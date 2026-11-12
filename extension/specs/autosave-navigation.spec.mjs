// Level 1 spec: what auto-save does when the page under test is reached or left through a
// navigation that changes more than the URL of the tab. Going back brings a page out of
// the back/forward cache, where its content script is already running. Leaving for another
// origin means that, by the time the save is processed, the tab is on a page the rules may
// map to another profile.

import { clearDownloads } from "../expect/saved-page.mjs";
import { startFixtureServer } from "../fixtures/server.mjs";
import { autoSaveHelpers, sleep, MODES, EARLY_LEAVE_DELAY, SAVE_TIMEOUT } from "../expect/autosave.mjs";

const RULED_PREFIX = "ruled-";
const RULED_TEMPLATE = RULED_PREFIX + "{page-title}.html";

const BACK_QUIET_PERIOD = 6000;

export const name = "autosave-navigation";
export const level = 1;

export async function run({ session, fixtures, test }) {
	const { configure, title, openAutoSavedPage, savedFiles, pendingSavesProblem } = autoSaveHelpers({ session, fixtures });
	// a second origin: same host, another port
	const otherFixtures = await startFixtureServer();
	try {
		await configure(MODES.loadOrUnload, { autoSaveDelay: 1 });

		// The two browsers do different things here and both are right. Chromium brings the
		// page back from the back/forward cache: it is the same document, already saved, so
		// nothing is saved. Firefox keeps no page with an unload listener in that cache, so
		// going back loads the page again, and a page that was loaded is saved.
		const savesAfterBack = session.browserName == "chromium" ? 0 : 1;
		await test("going back to a page that was saved " + (savesAfterBack ? "loads it again and saves it once more" : "restores it and does not save it again"), async () => {
			const page = await openAutoSavedPage("back");
			const nextTitle = title("back-next");
			const first = await savedFiles({ [page.title]: 1 }, { quietPeriod: 500 });
			await session.navigate(page.context, fixtures.titledURL(nextTitle));
			const second = await savedFiles({ [page.title]: 1, [nextTitle]: 1 }, { quietPeriod: 500 });
			clearDownloads(session.downloadDir);
			await session.back(page.context);
			const afterBack = await savedFiles(savesAfterBack ? { [page.title]: savesAfterBack } : {}, { quietPeriod: BACK_QUIET_PERIOD });
			await session.closeTab(page.context);
			return first.problem || second.problem || (afterBack.problem && "after going back: " + afterBack.problem);
		});

		await test("no save is left pending after going back", async () => {
			return pendingSavesProblem();
		});

		const ruledHost = new URL(fixtures.url("")).host;
		await configure(MODES.unload, {}, { ruled: { url: ruledHost, filenameTemplate: RULED_TEMPLATE } });

		await test("a page with its own auto-save profile is saved with it when its tab is closed", async () => {
			const page = await openAutoSavedPage("ruled-close");
			await sleep(EARLY_LEAVE_DELAY);
			await session.closeTab(page.context);
			const { names } = await savedFiles({});
			return names.length == 1 && names[0] == RULED_PREFIX + page.title + ".html" ? undefined : "saved as [" + names.join(", ") + "]";
		});

		await test("a page with its own auto-save profile is saved with it when left for another site", async () => {
			const page = await openAutoSavedPage("ruled-leave");
			await sleep(EARLY_LEAVE_DELAY);
			const nextTitle = title("ruled-leave-next");
			await session.navigate(page.context, otherFixtures.titledURL(nextTitle));
			const { names } = await savedFiles({});
			clearDownloads(session.downloadDir);
			await session.closeTab(page.context);
			await savedFiles({ [nextTitle]: 1 });
			return names.length == 1 && names[0] == RULED_PREFIX + page.title + ".html" ? undefined : "saved as [" + names.join(", ") + "]";
		});

		await test("a page without its own profile is saved with the default one when left for a site that has one", async () => {
			clearDownloads(session.downloadDir);
			const context = await session.openTab(otherFixtures.url("simple.html"));
			await session.dispatch({ method: "enableAutoSave", enabled: true });
			await sleep(500);
			const pageTitle = title("default-leave");
			await session.navigate(context, otherFixtures.titledURL(pageTitle));
			await sleep(EARLY_LEAVE_DELAY);
			const nextTitle = title("default-leave-next");
			await session.navigate(context, fixtures.titledURL(nextTitle));
			const { names } = await savedFiles({});
			clearDownloads(session.downloadDir);
			await session.closeTab(context);
			await savedFiles({}, { timeout: SAVE_TIMEOUT });
			return names.length == 1 && names[0].startsWith(pageTitle + " ") ? undefined : "saved as [" + names.join(", ") + "]";
		});

		await test("no save is left pending after the profile tests", async () => {
			return pendingSavesProblem();
		});
	} finally {
		await otherFixtures.close();
		// leave the profile as the other specs expect it
		await configure(MODES.loadOrUnload, { autoSaveDelay: 1 });
	}
}
