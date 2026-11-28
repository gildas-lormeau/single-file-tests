// What the auto-save specs share: how a tab gets auto-save, how its options are set, and
// how "saved N times" is read from the download directory.
//
// The delay is long on purpose. "Left before the save on load" needs a window that a slow
// machine cannot miss, and "saved once" needs a quiet period after the expected file to
// be worth anything.

import { clearDownloads, listDownloads } from "./saved-page.mjs";

const PENDINGS_PAGE = "src/ui/pages/pendings.html";
const DEFAULT_PROFILE_NAME = "__Default_Settings__";
const RULED_PROFILE_NAME = "Ruled";
// the title of the page a tab shows while auto-save is switched on for it, see openAutoSavedPage()
const STAGING_TITLE = "autosave-staging";
const AUTO_SAVE_DELAY = 4;
const EARLY_LEAVE_DELAY = 1000;
const QUIET_PERIOD = 3500;
const SAVE_TIMEOUT = 20000;
const MODES = {
	loadOrUnload: { autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: true },
	load: { autoSaveLoad: true, autoSaveUnload: false, autoSaveLoadOrUnload: false },
	unload: { autoSaveLoad: false, autoSaveUnload: true, autoSaveLoadOrUnload: false },
	none: { autoSaveLoad: false, autoSaveUnload: false, autoSaveLoadOrUnload: false }
};

export { autoSaveHelpers, sleep, MODES, AUTO_SAVE_DELAY, EARLY_LEAVE_DELAY, SAVE_TIMEOUT };

// shared by every spec of a run, so two specs never give two pages the same title
let sequence = 0;

function autoSaveHelpers({ session, fixtures }) {
	return { configure, title, openAutoSavedPage, savedFiles, pendingSavesProblem };

	// Every option of the profile that matters to the test, stated in full: a key left out
	// would be filled from the defaults and silently carry over nothing from the last call.
	//
	// `ruled` adds a second profile, used for auto-save on the URLs containing `ruled.url`
	// and told apart by its filename template.
	async function configure(mode, options = {}, { ruled } = {}) {
		const profile = {
			autoSaveDelay: AUTO_SAVE_DELAY,
			autoSaveDiscard: false,
			autoSaveRemove: false,
			autoSaveRepeat: false,
			...mode,
			...options
		};
		const context = await session.importSettings(profile, ruled ? {
			profiles: { [RULED_PROFILE_NAME]: { ...profile, filenameTemplate: ruled.filenameTemplate } },
			rules: [{ url: ruled.url, profile: DEFAULT_PROFILE_NAME, autoSaveProfile: RULED_PROFILE_NAME }]
		} : undefined);
		await session.closeTab(context);
	}

	function title(label) {
		sequence++;
		return "autosave-" + label + "-" + sequence;
	}

	// Auto-save is a property of the tab, read by the content script when a page starts
	// loading. So the tab is opened on a page that is not under test, auto-save is switched
	// on for it, and the page under test is then loaded in that same tab. A caller that
	// needs a richer page than a titled one passes its URL; its title is then the page's own.
	//
	// That first page can be saved too. Its content script reads the auto-save state of the tab
	// while the page loads: when the switch lands before that, which happens now and then on a
	// slow machine, the page knows auto-save is on and is saved when the tab leaves it. This is
	// what SingleFile must do, and it is not what the test is about: the page has a title of its
	// own, and savedFiles() leaves its files out.
	async function openAutoSavedPage(label, { url } = {}) {
		clearDownloads(session.downloadDir);
		const context = await session.openTab(fixtures.titledURL(STAGING_TITLE));
		await session.dispatch({ method: "enableAutoSave", enabled: true });
		await sleep(500);
		const pageTitle = url ? undefined : title(label);
		await session.navigate(context, url || fixtures.titledURL(pageTitle));
		return { context, title: pageTitle };
	}

	// Wait for the expected number of files per title, then for a quiet period, and report
	// what is there. The quiet period is what turns "one file appeared" into "one file".
	// A count may be { min } when the test is about "at least".
	async function savedFiles(expected, { timeout = SAVE_TIMEOUT, quietPeriod = QUIET_PERIOD } = {}) {
		const minimum = count => typeof count == "number" ? count : count.min;
		const expectedTotal = Object.values(expected).reduce((total, count) => total + minimum(count), 0);
		const exact = Object.values(expected).every(count => typeof count == "number");
		const deadline = Date.now() + timeout;
		// Each expected page is waited for by its title. Counting the files of the folder stopped
		// the wait as soon as any file made the number, a file of another page included, and the
		// page still to be saved was then reported missing.
		const awaited = () => {
			const names = testedPageFiles();
			return Object.entries(expected).every(([pageTitle, count]) => countFiles(names, pageTitle) >= minimum(count));
		};
		while (Date.now() < deadline && !awaited()) {
			await sleep(125);
		}
		await sleep(quietPeriod);
		const names = testedPageFiles();
		const problems = [];
		for (const [pageTitle, count] of Object.entries(expected)) {
			const found = countFiles(names, pageTitle);
			if (typeof count == "number" ? found != count : found < count.min) {
				problems.push(pageTitle + " was saved " + found + " time(s), expected " + (typeof count == "number" ? count : "at least " + count.min));
			}
		}
		if (exact && names.length != expectedTotal && !problems.length) {
			problems.push("expected " + expectedTotal + " file(s), found " + names.length);
		}
		return { names, problem: problems.length ? problems.join("; ") + " [" + names.join(", ") + "]" : undefined };
	}

	function testedPageFiles() {
		return listDownloads(session.downloadDir).filter(fileName => !fileName.startsWith(STAGING_TITLE + " "));
	}

	function countFiles(names, pageTitle) {
		return names.filter(fileName => fileName.startsWith(pageTitle + " ")).length;
	}

	// The pending saves page is what a user opens to see what is stuck. A row without the
	// "no-result" cell is a save still listed.
	async function pendingSavesProblem() {
		const context = await session.openTab(session.singlefileURL(PENDINGS_PAGE));
		await sleep(750);
		const rows = await session.evaluate(context, "JSON.stringify(Array.from(document.querySelectorAll(\"#resultsTable .result-row\"))" +
			".filter(row => !row.querySelector(\".no-result\")).map(row => row.textContent.trim().slice(0, 80)))");
		await session.closeTab(context);
		const pending = JSON.parse(rows);
		return pending.length ? pending.length + " save(s) still pending: " + pending.join(" | ") : undefined;
	}
}

function sleep(delay) {
	return new Promise(resolve => setTimeout(resolve, delay));
}
