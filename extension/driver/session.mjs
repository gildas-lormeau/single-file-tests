// One session API over both browsers. Everything after the launch is shared: the
// per-browser differences are confined to launch-chromium.mjs / launch-firefox.mjs and
// to how the installed extension's origin is derived.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchChromium } from "./launch-chromium.mjs";
import { launchFirefox, SINGLEFILE_UUID } from "./launch-firefox.mjs";
import { buildRelay } from "../relay/build.mjs";
import { startBridge } from "../relay/bridge.mjs";
import { unpackRelease } from "./release-build.mjs";
import { guardDirectory, releaseDirectory } from "./process-guard.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// the MV2 build is the Firefox one, the MV3 build is the Chromium one
const EXTENSION_PATHS = {
	firefox: process.env.SF_EXTENSION_FIREFOX || join(REPO_ROOT, "single-file"),
	chromium: process.env.SF_EXTENSION_CHROMIUM || join(REPO_ROOT, "single-file-mv3")
};

export { openSession, BROWSERS };

const BROWSERS = ["chromium", "firefox"];
const IMPORT_TIMEOUT = 10000;
const IMPORT_POLL_DELAY = 50;
const OPTIONS_PAGE = "src/ui/pages/options.html";
// The options page is one long column and a headless window is far too short for it; a
// pointer aimed below the fold either errors (Firefox) or silently hits something else
// (Chromium), so give the page a viewport tall enough to hold its controls.
//
// Deliberately far taller than the page needs. 4000 was enough until a control near the
// bottom had to be clicked on Firefox, where the expanded page runs past 4200 — and the
// failure mode on the other browser is a silent hit on the wrong element, so there is no
// reason to keep this close to the real height.
const OPTIONS_VIEWPORT = { width: 1200, height: 12000 };
const PERMISSION_INPUTS = ["#externalCaptureAllowedIdsInput", "#externalCaptureDeniedIdsInput"];
// WebDriver special keys, built from code points so nothing can strip them silently
const BACKSPACE = String.fromCharCode(0xE003);
const TAB = String.fromCharCode(0xE004);
const CONTROL = String.fromCharCode(0xE009);
const META = String.fromCharCode(0xE03D);
const SELECT_ALL_MODIFIER = process.platform == "darwin" ? META : CONTROL;
// Firefox 156 treats an extension page as a privileged browsing context (Bug 2055034,
// remote/shared/BrowsingContextUtils.sys.mjs isPrivilegedContext: any page outside a web
// or file content process). With -remote-allow-system-access, navigate, reload, close,
// getTree and script evaluation accept such a context; setViewport, locateNodes,
// input.performActions and input.setFiles answer "The command does not support browsing
// contexts in privileged scope". The level-2 helpers below try the real command first and,
// once a context has been refused, drive that page through its own scripts instead. That
// is a level-3 path taken only on those builds: Chromium, older Firefox and web pages keep
// real input. Measured 2026-09-20: the 1.26.0 gate ran on Firefox 155, the next one met 156.
const PRIVILEGED_SCOPE_REFUSAL = /privileged scope/;

// `release` tests the zip build-extension.sh produces instead of the working tree; see
// release-build.mjs for why the two are not the same thing.
//
// `grantedPermissions` names optional permissions of the extension that the session starts
// with. Granting one takes a click on a button of the options page and then, in Chromium, a
// click in a dialog of the browser itself, which nothing here can reach; Firefox refuses the
// request unless it comes from real input, which it does not accept on an extension page
// (see PRIVILEGED_SCOPE_REFUSAL). So the extension is installed from a copy whose manifest
// requires these permissions. Everything behind the permission is then tested for real; the
// request itself is not, and a spec that relies on this should say so.
async function openSession(browserName, { headless = true, release = false, grantedPermissions = [] } = {}) {
	const releaseBuild = release ? unpackRelease(browserName, REPO_ROOT) : undefined;
	const sourcePath = releaseBuild ? releaseBuild.path : EXTENSION_PATHS[browserName];
	let extensionPath = sourcePath;
	let singlefileId, downloadDir, bridge, relayPath, browser, grantedPath;
	try {
		if (grantedPermissions.length) {
			grantedPath = extensionPath = grantPermissions(sourcePath, grantedPermissions);
		}
		singlefileId = readGeckoId(extensionPath);
		downloadDir = mkdtempSync(join(tmpdir(), "sf-fn-dl-"));
		guardDirectory(downloadDir);
		bridge = await startBridge();
		relayPath = buildRelay(browserName, bridge.url);
		guardDirectory(relayPath);
		browser = browserName == "firefox"
			? await launchFirefox({ singlefileId, downloadDir, headless })
			: await launchChromium({ downloadDir, headless });
	} catch (error) {
		// nothing below is reachable yet, so unwind by hand rather than through close()
		if (bridge) {
			await bridge.close();
		}
		[relayPath, downloadDir, grantedPath].forEach(path => path && releaseDirectory(path));
		if (releaseBuild) {
			releaseBuild.dispose();
		}
		throw error;
	}
	const { session } = browser;
	// contexts Firefox 156+ refused a level-2 command on, driven by script from then on
	const privilegedContexts = new Set();

	let singlefileOrigin;
	try {
		const singlefile = await session.send("webExtension.install",
			{ extensionData: { type: "path", path: extensionPath } }, 30000);
		await session.send("webExtension.install", { extensionData: { type: "path", path: relayPath } }, 30000);
		singlefileOrigin = browserName == "firefox"
			? "moz-extension://" + SINGLEFILE_UUID
			: "chrome-extension://" + singlefile.extension;
		const relay = await bridge.waitForRelay();
		return {
			browserName,
			session,
			downloadDir,
			// what was actually installed, so a run can say which build it graded
			extensionPath: sourcePath,
			// another browser running the same build, with optional permissions already granted
			openVariant: options => openSession(browserName, { headless, release, ...options }),
			releaseZip: releaseBuild && releaseBuild.zipPath,
			releaseStaleness: releaseBuild && releaseBuild.staleness,
			singlefileId: singlefile.extension,
			singlefileURL,
			// level 1: the relay asks SingleFile to do something through its public
			// runtime.onMessageExternal API, exactly as another extension would
			// expectResponse only for messages that return data (capture-page); the save
			// actions never answer, so waiting on them costs a full timeout per dispatch
			dispatch: (message, { expectResponse = false, responseTimeout } = {}) =>
				bridge.dispatch(singlefile.extension, message, expectResponse, responseTimeout),
			// SingleFile identifies the caller by this id when granting capture permission
			relayId: relay && relay.id,
			openTab,
			navigate,
			back,
			activate,
			closeTab,
			closeTabsShowing,
			setViewport,
			// level 2: real pointer and keyboard input aimed at a real element
			click,
			pressKey,
			importSettings,
			resetCapturePermissions,
			evaluate,
			close
		};
	} catch (error) {
		await close();
		throw error;
	}

	async function openTab(url) {
		const { context } = await session.send("browsingContext.create", { type: "tab" });
		await session.send("browsingContext.navigate", { context, url, wait: "complete" }, 30000);
		// SingleFile acts on the active tab, and a freshly created tab is the active one
		return context;
	}

	// Load another page in a tab that is already open, the way a click on a link does. A
	// caller that wants to act while the page is still loading passes wait "interactive".
	async function navigate(context, url, { wait = "complete" } = {}) {
		await session.send("browsingContext.navigate", { context, url, wait }, 30000);
	}

	// The back button.
	async function back(context) {
		await session.send("browsingContext.traverseHistory", { context, delta: -1 });
	}

	// Bring a tab back to the front, which hides the one that was there.
	async function activate(context) {
		await session.send("browsingContext.activate", { context });
	}

	// A headless window is short, and a pointer aimed at an element below the fold lands
	// on whatever is on top instead of erroring. Giving a long page a viewport tall enough
	// to hold it is the reliable way to keep controls clickable.
	// The tab is closed the way a click on its close button closes it: the browser asks the
	// page first (beforeunload) and removes the tab afterwards. Without promptUnload the tab
	// is removed at once, which no user can do, and SingleFile then has nothing but the
	// unload event to save the page from. Firefox aborts the scripts still running in a
	// process it shuts down, and the process of a tab that was alone in it is shut down when
	// the tab closes: the save on unload was cut that way in about one close out of five on
	// the Linux runners (2026-11-18), and reported as "saved 0 time(s)".
	//
	// A close that fails is not an error for the caller: a discarded tab is a new tab to
	// Chromium, and the context a spec holds no longer closes it. It is printed, though,
	// because a tab that stays open is never unloaded and an auto-save test waiting for the
	// save on unload then fails with nothing to tell why.
	async function closeTab(context) {
		await session.send("browsingContext.close", { context, promptUnload: true }).catch(error =>
			// eslint-disable-next-line no-console
			console.log("        note: closing a tab failed (" + error.message + ")"));
	}

	// Close every tab whose URL contains the given text. A discarded tab is a new tab to
	// Chromium (new tab id, new browsing context), so the context a spec opened the page with
	// no longer closes it, and closeTab swallows that. A discarded tab left open is reloaded
	// as soon as it becomes the active one.
	async function closeTabsShowing(urlPart) {
		const { contexts } = await session.send("browsingContext.getTree", { maxDepth: 0 });
		for (const { context, url } of contexts) {
			if (url.includes(urlPart)) {
				await closeTab(context);
			}
		}
	}

	async function setViewport(context, width, height) {
		if (privilegedContexts.has(context)) {
			return;
		}
		try {
			await session.send("browsingContext.setViewport", { context, viewport: { width, height } });
		} catch (error) {
			if (!refusedAsPrivileged(error)) {
				throw error;
			}
			// the page is driven by script from here on, and a script needs no viewport
			privilegedContexts.add(context);
		}
	}

	function refusedAsPrivileged(error) {
		return PRIVILEGED_SCOPE_REFUSAL.test(error.message);
	}

	// Aim input at an element rather than at coordinates: locateNodes gives a node
	// reference the pointer can use as its origin, so nothing has to guess a position or
	// scroll the element into view by hand.
	async function locate(context, selector) {
		const { nodes } = await session.send("browsingContext.locateNodes", {
			context,
			locator: { type: "css", value: selector }
		});
		if (!nodes || !nodes.length) {
			throw new Error("no element matched " + selector);
		}
		return nodes[0].sharedId;
	}

	async function click(context, selector) {
		if (!privilegedContexts.has(context)) {
			try {
				const sharedId = await locate(context, selector);
				const origin = { type: "element", element: { sharedId } };
				await session.send("input.performActions", {
					context,
					actions: [{
						type: "pointer",
						id: "mouse",
						parameters: { pointerType: "mouse" },
						actions: [
							{ type: "pointerMove", x: 0, y: 0, origin },
							{ type: "pointerDown", button: 0 },
							{ type: "pointerUp", button: 0 }
						]
					}]
				});
				return;
			} catch (error) {
				if (!refusedAsPrivileged(error)) {
					throw error;
				}
				privilegedContexts.add(context);
			}
		}
		await evaluate(context, "(() => { const element = document.querySelector(" + JSON.stringify(selector) + "); " +
			"if (!element) { throw new Error(" + JSON.stringify("no element matched " + selector) + "); } element.click(); })()");
	}

	async function pressKey(context, key, times = 1) {
		const actions = [];
		for (let index = 0; index < times; index++) {
			actions.push({ type: "keyDown", value: key }, { type: "keyUp", value: key });
		}
		await session.send("input.performActions", {
			context,
			actions: [{ type: "key", id: "keyboard", actions }]
		});
	}

	async function pressChord(context, modifier, key) {
		await session.send("input.performActions", {
			context,
			actions: [{
				type: "key",
				id: "keyboard",
				actions: [
					{ type: "keyDown", value: modifier },
					{ type: "keyDown", value: key },
					{ type: "keyUp", value: key },
					{ type: "keyUp", value: modifier }
				]
			}]
		});
	}

	// Empty the two permission lists on the options page, which is the only way back to a
	// clean slate: a capture decision is sticky by design, and the lists live outside the
	// settings profile, so importSettings does not touch them.
	//
	// Each textarea persists on `change`, which a textarea fires on blur — hence the Tab.
	async function resetCapturePermissions() {
		const context = await openTab(singlefileURL(OPTIONS_PAGE));
		await setViewport(context, OPTIONS_VIEWPORT.width, OPTIONS_VIEWPORT.height);
		await click(context, "#expandAllButton");
		if (privilegedContexts.has(context)) {
			// what the select-all, backspace and tab sequence amounts to: an emptied value
			// and the change event the page persists on
			await evaluate(context, "(() => { for (const selector of " + JSON.stringify(PERMISSION_INPUTS) + ") { " +
				"const input = document.querySelector(selector); input.value = \"\"; " +
				"input.dispatchEvent(new Event(\"change\", { bubbles: true })); } })()");
		} else {
			for (const selector of PERMISSION_INPUTS) {
				await click(context, selector);
				await pressChord(context, SELECT_ALL_MODIFIER, "a");
				await pressKey(context, BACKSPACE);
				await pressKey(context, TAB);
			}
		}
		await new Promise(resolve => setTimeout(resolve, 750));
		return context;
	}

	// Set any option without touching its widget, using the options page's own Import
	// feature: a real click on the real button, then a real file handed to the real
	// <input type="file">. Keys left out of the profile are filled from DEFAULT_CONFIG
	// when the config is upgraded, so a partial profile is enough.
	//
	// This exists because a <select> cannot be driven by synthetic input on macOS — the
	// click opens a native menu that swallows the keys. Import sidesteps the widget
	// question entirely and works for every option, not just that one.
	//
	// `profiles` adds named profiles next to the default one and `rules` maps URLs to
	// them, for the tests about which profile a page is saved with.
	async function importSettings(profile, { profileName = "__Default_Settings__", profiles = {}, rules = [] } = {}) {
		const context = await openTab(singlefileURL(OPTIONS_PAGE));
		await setViewport(context, OPTIONS_VIEWPORT.width, OPTIONS_VIEWPORT.height);
		const settingsDir = mkdtempSync(join(tmpdir(), "sf-fn-settings-"));
		guardDirectory(settingsDir);
		const settingsPath = join(settingsDir, "settings.json");
		const settings = JSON.stringify({ profiles: { [profileName]: profile, ...profiles }, rules });
		writeFileSync(settingsPath, settings);
		// the click is what registers the file input's change handler
		await click(context, "#importButton");
		if (privilegedContexts.has(context)) {
			// the handler reads fileInput.files[0], and a File built in the page is one
			await evaluate(context, "(() => { const input = document.querySelector(\"#fileInput\"); " +
				"const transfer = new DataTransfer(); " +
				"transfer.items.add(new File([" + JSON.stringify(settings) + "], \"settings.json\", { type: \"application/json\" })); " +
				"input.files = transfer.files; input.dispatchEvent(new Event(\"change\", { bubbles: true })); })()");
		} else {
			const { nodes } = await session.send("browsingContext.locateNodes", {
				context,
				locator: { type: "css", value: "#fileInput" }
			});
			if (!nodes || !nodes.length) {
				throw new Error("the options page has no #fileInput to import through");
			}
			await session.send("input.setFiles", {
				context,
				element: { sharedId: nodes[0].sharedId },
				files: [settingsPath]
			});
		}
		// The handler reads the file, has it stored, refreshes the page and empties the file
		// input as its last step: an empty input means the settings are in place. The profiles
		// are stored complete in one write since the import fills the defaults before storing.
		const deadline = Date.now() + IMPORT_TIMEOUT;
		while (await evaluate(context, "document.querySelector(\"#fileInput\").value") !== "") {
			if (Date.now() > deadline) {
				throw new Error("the settings were not imported after " + IMPORT_TIMEOUT + " ms");
			}
			await new Promise(resolve => setTimeout(resolve, IMPORT_POLL_DELAY));
		}
		// the directory, not just the file inside it: this runs once per option change
		releaseDirectory(settingsDir);
		return context;
	}

	function singlefileURL(path) {
		return singlefileOrigin + "/" + String(path).replace(/^\//, "");
	}

	// level 3 helper. Reserved for SingleFile's own pages; specs that use it against page
	// internals should say so, because that is no longer black box.
	async function evaluate(context, expression) {
		const { result, exceptionDetails } = await session.send("script.evaluate", {
			expression,
			target: { context },
			awaitPromise: true,
			resultOwnership: "none"
		});
		if (exceptionDetails) {
			throw new Error("evaluate failed: " + JSON.stringify(exceptionDetails).slice(0, 300));
		}
		return result && result.value;
	}

	async function close() {
		session.close();
		await browser.close();
		await bridge.close();
		releaseDirectory(relayPath);
		releaseDirectory(downloadDir);
		// a copy of the release carries the injected Woleet key as the release does
		if (grantedPath) {
			releaseDirectory(grantedPath);
		}
		// the unpacked release carries the injected Woleet key, so it does not outlive the run
		if (releaseBuild) {
			releaseBuild.dispose();
		}
	}
}

function readGeckoId(extensionPath) {
	const manifest = JSON.parse(readFileSync(join(extensionPath, "manifest.json"), "utf8"));
	const settings = manifest.browser_specific_settings || manifest.applications;
	return settings && settings.gecko && settings.gecko.id;
}

// A copy of the extension whose manifest requires the given optional permissions. The
// dependencies and the history of a working tree are left out: the browser loads neither.
function grantPermissions(extensionPath, permissions) {
	const grantedPath = mkdtempSync(join(tmpdir(), "sf-fn-granted-"));
	guardDirectory(grantedPath);
	cpSync(extensionPath, grantedPath, { recursive: true, filter: source => !["node_modules", ".git"].includes(basename(source)) });
	const manifestPath = join(grantedPath, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const missing = permissions.filter(permission => !(manifest.optional_permissions || []).includes(permission));
	if (missing.length) {
		releaseDirectory(grantedPath);
		throw new Error("not an optional permission of " + extensionPath + ": " + missing.join(", "));
	}
	manifest.optional_permissions = manifest.optional_permissions.filter(permission => !permissions.includes(permission));
	manifest.permissions = [...manifest.permissions, ...permissions];
	writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
	return grantedPath;
}
