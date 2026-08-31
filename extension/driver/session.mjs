// One session API over both browsers. Everything after the launch is shared: the
// per-browser differences are confined to launch-chromium.mjs / launch-firefox.mjs and
// to how the installed extension's origin is derived.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchChromium } from "./launch-chromium.mjs";
import { launchFirefox, SINGLEFILE_UUID } from "./launch-firefox.mjs";
import { buildRelay } from "../relay/build.mjs";
import { startBridge } from "../relay/bridge.mjs";
import { unpackRelease } from "./release-build.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// the MV2 build is the Firefox one, the MV3 build is the Chromium one
const EXTENSION_PATHS = {
	firefox: process.env.SF_EXTENSION_FIREFOX || join(REPO_ROOT, "single-file"),
	chromium: process.env.SF_EXTENSION_CHROMIUM || join(REPO_ROOT, "single-file-mv3")
};

export { openSession, BROWSERS };

const BROWSERS = ["chromium", "firefox"];
const OPTIONS_PAGE = "src/ui/pages/options.html";
// the options page is one long column and a headless window is far too short for it; a
// pointer aimed below the fold either errors (Firefox) or silently hits something else
// (Chromium), so give the page a viewport tall enough to hold its controls
const OPTIONS_VIEWPORT = { width: 1200, height: 4000 };

// `release` tests the zip build-extension.sh produces instead of the working tree; see
// release-build.mjs for why the two are not the same thing.
async function openSession(browserName, { headless = true, release = false } = {}) {
	const releaseBuild = release ? unpackRelease(browserName, REPO_ROOT) : undefined;
	const extensionPath = releaseBuild ? releaseBuild.path : EXTENSION_PATHS[browserName];
	let singlefileId, downloadDir, bridge, relayPath, browser;
	try {
		singlefileId = readGeckoId(extensionPath);
		downloadDir = mkdtempSync(join(tmpdir(), "sf-fn-dl-"));
		bridge = await startBridge();
		relayPath = buildRelay(browserName, bridge.url);
		browser = browserName == "firefox"
			? await launchFirefox({ singlefileId, downloadDir, headless })
			: await launchChromium({ downloadDir, headless });
	} catch (error) {
		// nothing below is reachable yet, so unwind by hand rather than through close()
		if (bridge) {
			await bridge.close();
		}
		[relayPath, downloadDir].forEach(path => path && rmSync(path, { recursive: true, force: true }));
		if (releaseBuild) {
			releaseBuild.dispose();
		}
		throw error;
	}
	const { session } = browser;

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
			extensionPath,
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
			closeTab,
			setViewport,
			// level 2: real pointer and keyboard input aimed at a real element
			click,
			pressKey,
			importSettings,
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

	// A headless window is short, and a pointer aimed at an element below the fold lands
	// on whatever is on top instead of erroring. Giving a long page a viewport tall enough
	// to hold it is the reliable way to keep controls clickable.
	async function closeTab(context) {
		await session.send("browsingContext.close", { context }).catch(() => undefined);
	}

	async function setViewport(context, width, height) {
		await session.send("browsingContext.setViewport", { context, viewport: { width, height } });
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

	// Set any option without touching its widget, using the options page's own Import
	// feature: a real click on the real button, then a real file handed to the real
	// <input type="file">. Keys left out of the profile are filled from DEFAULT_CONFIG
	// when the config is upgraded, so a partial profile is enough.
	//
	// This exists because a <select> cannot be driven by synthetic input on macOS — the
	// click opens a native menu that swallows the keys. Import sidesteps the widget
	// question entirely and works for every option, not just that one.
	async function importSettings(profile, { profileName = "__Default_Settings__" } = {}) {
		const context = await openTab(singlefileURL(OPTIONS_PAGE));
		await setViewport(context, OPTIONS_VIEWPORT.width, OPTIONS_VIEWPORT.height);
		const settingsPath = join(mkdtempSync(join(tmpdir(), "sf-fn-settings-")), "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ profiles: { [profileName]: profile }, rules: [] }));
		// the click is what registers the file input's change handler
		await click(context, "#importButton");
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
		// the handler reads the file and writes storage asynchronously
		await new Promise(resolve => setTimeout(resolve, 2500));
		rmSync(settingsPath, { force: true });
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
		rmSync(relayPath, { recursive: true, force: true });
		rmSync(downloadDir, { recursive: true, force: true });
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
