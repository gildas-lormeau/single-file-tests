// Level 1 spec, with one level 2 read: auto-save is switched on for a tab through the
// public external API (`enableAutoSave`, what another extension would send), its options
// are set through the options page's own Import, and the only things inspected are the
// files in the download directory and the rows of the pending saves page.
//
// Every test here is about WHEN a page is saved and HOW MANY times, never about what the
// file holds: the other specs grade the content. A page is told apart by its title, which
// the default filename template starts with.

import { clearDownloads } from "../expect/saved-page.mjs";
import { autoSaveHelpers, sleep, MODES, AUTO_SAVE_DELAY, EARLY_LEAVE_DELAY, SAVE_TIMEOUT } from "../expect/autosave.mjs";

const REPEAT_DELAY = 4;
const QUIET_AFTER_CLOSE = 3000;

export const name = "autosave";
export const level = 1;

export async function run({ session, fixtures, test }) {
	const { configure, title, openAutoSavedPage, savedFiles, pendingSavesProblem } = autoSaveHelpers({ session, fixtures });

	await configure(MODES.loadOrUnload);

	await test("a page left open is saved once, after the delay", async () => {
		const page = await openAutoSavedPage("stay");
		const names = await savedFiles({ [page.title]: 1 }, { timeout: AUTO_SAVE_DELAY * 1000 + SAVE_TIMEOUT });
		await session.closeTab(page.context);
		return names.problem;
	});

	await test("a tab closed before the delay is saved once", async () => {
		const page = await openAutoSavedPage("close-early");
		await sleep(EARLY_LEAVE_DELAY);
		await session.closeTab(page.context);
		return (await savedFiles({ [page.title]: 1 })).problem;
	});

	await test("no save is left pending after the tab was closed", async () => {
		return pendingSavesProblem();
	});

	await test("a page left for another one before the delay is saved once, and so is the next page", async () => {
		const page = await openAutoSavedPage("navigate-early");
		await sleep(EARLY_LEAVE_DELAY);
		const nextTitle = title("navigate-early-next");
		await session.navigate(page.context, fixtures.titledURL(nextTitle));
		const names = await savedFiles({ [page.title]: 1, [nextTitle]: 1 }, { timeout: AUTO_SAVE_DELAY * 1000 + SAVE_TIMEOUT });
		await session.closeTab(page.context);
		return names.problem;
	});

	await test("no save is left pending after the navigation", async () => {
		return pendingSavesProblem();
	});

	await configure(MODES.load);

	await test("save on load only: a page left open is saved once", async () => {
		const page = await openAutoSavedPage("load-stay");
		const names = await savedFiles({ [page.title]: 1 }, { timeout: AUTO_SAVE_DELAY * 1000 + SAVE_TIMEOUT });
		await session.closeTab(page.context);
		return names.problem;
	});

	await test("save on load only: a tab closed before the delay is not saved", async () => {
		const page = await openAutoSavedPage("load-close-early");
		await sleep(EARLY_LEAVE_DELAY);
		await session.closeTab(page.context);
		return (await savedFiles({})).problem;
	});

	await test("save on load only: no save is left pending after the tab was closed", async () => {
		return pendingSavesProblem();
	});

	await configure(MODES.unload);

	await test("save on unload only: a page left open is not saved, and closing its tab saves it once", async () => {
		const page = await openAutoSavedPage("unload-close");
		const before = await savedFiles({}, { quietPeriod: AUTO_SAVE_DELAY * 1000 + 1500 });
		if (before.problem) {
			return "before the tab was closed: " + before.problem;
		}
		await session.closeTab(page.context);
		return (await savedFiles({ [page.title]: 1 })).problem;
	});

	await test("save on unload only: leaving a page for another one saves it once", async () => {
		const page = await openAutoSavedPage("unload-navigate");
		await sleep(EARLY_LEAVE_DELAY);
		const nextTitle = title("unload-navigate-next");
		await session.navigate(page.context, fixtures.titledURL(nextTitle));
		const names = await savedFiles({ [page.title]: 1 });
		clearDownloads(session.downloadDir);
		await session.closeTab(page.context);
		const afterClose = await savedFiles({ [nextTitle]: 1 });
		return names.problem || (afterClose.problem && "closing the tab on the next page: " + afterClose.problem);
	});

	// SingleFile captures the page when the browser asks it whether it may unload, which is
	// before it is known that the page goes away, and saves the capture once it did. This is
	// the case where it did not: the page must not be saved for having been asked.
	await test("save on unload only: a navigation that leaves the page in place does not save it, and closing its tab saves it once", async () => {
		const page = await openAutoSavedPage("unload-stay-after-navigation");
		await sleep(EARLY_LEAVE_DELAY);
		await session.evaluate(page.context, "location.href = " + JSON.stringify(fixtures.noContentURL()) + "; undefined");
		const before = await savedFiles({});
		const stillThere = await session.evaluate(page.context, "document.title");
		if (stillThere != page.title) {
			return "the page did not stay in place, the tab shows " + JSON.stringify(stillThere);
		}
		if (before.problem) {
			return "after the navigation that went nowhere: " + before.problem;
		}
		await session.closeTab(page.context);
		return (await savedFiles({ [page.title]: 1 })).problem;
	});

	await configure({ ...MODES.unload, autoSaveRemove: true });

	await test("save on unload and on tab removed: closing the tab saves the page once", async () => {
		const page = await openAutoSavedPage("unload-remove-close");
		await sleep(EARLY_LEAVE_DELAY);
		await session.closeTab(page.context);
		return (await savedFiles({ [page.title]: 1 })).problem;
	});

	await configure({ ...MODES.loadOrUnload, autoSaveRemove: true });

	await test("save on load or unload, and on tab removed: a page left for another one before the delay is saved", async () => {
		const page = await openAutoSavedPage("remove-navigate-early");
		await sleep(EARLY_LEAVE_DELAY);
		const nextTitle = title("remove-navigate-early-next");
		await session.navigate(page.context, fixtures.titledURL(nextTitle));
		const names = await savedFiles({ [page.title]: 1, [nextTitle]: 1 }, { timeout: AUTO_SAVE_DELAY * 1000 + SAVE_TIMEOUT });
		await session.closeTab(page.context);
		return names.problem;
	});

	await configure(MODES.load, { autoSaveDelay: 1, autoSaveRepeat: true, autoSaveRepeatDelay: REPEAT_DELAY });

	await test("save on load with repeat: a page left open is saved again after the repeat delay", async () => {
		const page = await openAutoSavedPage("repeat");
		const names = await savedFiles({ [page.title]: { min: 3 } }, { timeout: (1 + REPEAT_DELAY * 2) * 1000 + SAVE_TIMEOUT, quietPeriod: 500 });
		await session.closeTab(page.context);
		return names.problem;
	});

	await test("save on load with repeat: closing the tab stops the saves", async () => {
		// the save in flight when the tab was closed may still land
		await sleep(QUIET_AFTER_CLOSE);
		clearDownloads(session.downloadDir);
		return (await savedFiles({}, { quietPeriod: REPEAT_DELAY * 1000 + 2000 })).problem;
	});

	await test("no save is left pending at the end", async () => {
		return pendingSavesProblem();
	});

	// leave the profile as the other specs expect it
	await configure(MODES.loadOrUnload, { autoSaveDelay: 1 });
}
