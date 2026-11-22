// Level 3 spec: a save that ends without a file must not stay in the list of the pending saves.
//
// A save is a task of the background page, removed when the download ends. A save that never
// reaches the download (no area selected, a capture that throws) used to keep its task: one row
// "processing" in the page of the pending saves and one slot of the parallel saves taken, until
// the tab was reloaded or closed.
//
// Level 3 because the result is read in SingleFile's own page, the list of the pending saves.
//
// A page cannot make the capture throw. The tests of that case need builds whose `processPage`
// throws on a URL holding `sf-probe-throw`, given with SF_EXTENSION_FIREFOX and
// SF_EXTENSION_CHROMIUM, and run only when SF_FAILED_SAVE_PROBE is set.

import { waitForDownload, clearDownloads, listDownloads } from "../expect/saved-page.mjs";
import { autoSaveHelpers, sleep } from "../expect/autosave.mjs";

const SETTLE_DELAY = 3000;
const AREA_SELECTION_DELAY = 1500;
const PRESS_ESCAPE = "[\"keydown\", \"keyup\"].forEach(type => dispatchEvent(new KeyboardEvent(type, { key: \"Escape\", bubbles: true, cancelable: true })))";

export const name = "failed-save";
export const level = 3;

export async function run({ session, fixtures, test }) {
	const { pendingSavesProblem } = autoSaveHelpers({ session, fixtures });

	await test("control: a save that works leaves nothing pending", async () => {
		clearDownloads(session.downloadDir);
		const context = await session.openTab(fixtures.url("simple.html"));
		await session.dispatch("save-page");
		await waitForDownload(session.downloadDir);
		await sleep(SETTLE_DELAY);
		const problem = await pendingSavesProblem();
		await session.closeTab(context);
		return problem;
	});

	await test("giving up the selection of an area leaves nothing pending", async () => {
		// with nothing selected, SingleFile asks for an area of the page and waits; Escape gives
		// up, and the save ends without a file
		clearDownloads(session.downloadDir);
		const context = await session.openTab(fixtures.url("simple.html"));
		await session.dispatch("save-selected-content");
		await sleep(AREA_SELECTION_DELAY);
		await session.evaluate(context, PRESS_ESCAPE);
		await sleep(SETTLE_DELAY);
		const saved = listDownloads(session.downloadDir).length;
		const problem = await pendingSavesProblem();
		await session.closeTab(context);
		return saved ? "a page was saved with nothing selected" : problem;
	});

	if (process.env.SF_FAILED_SAVE_PROBE) {
		let failedContext;
		await test("a save whose capture throws leaves nothing pending", async () => {
			clearDownloads(session.downloadDir);
			failedContext = await session.openTab(fixtures.url("simple.html?sf-probe-throw"));
			await session.dispatch("save-page");
			await sleep(SETTLE_DELAY);
			if (listDownloads(session.downloadDir).length) {
				return "the page was saved: this build does not throw on the marked URL";
			}
			return pendingSavesProblem();
		});

		await test("a second failed save of the same tab leaves nothing pending", async () => {
			await session.session.send("browsingContext.activate", { context: failedContext });
			await session.dispatch("save-page");
			await sleep(SETTLE_DELAY);
			return pendingSavesProblem();
		});

		await test("the same tab is saved once its capture works again", async () => {
			// the fragment is not a navigation: the content script and its state are kept
			clearDownloads(session.downloadDir);
			await session.session.send("browsingContext.activate", { context: failedContext });
			await session.evaluate(failedContext, "history.replaceState(null, \"\", \"simple.html\")");
			await session.dispatch("save-page");
			const savedPath = await waitForDownload(session.downloadDir).catch(() => undefined);
			await session.closeTab(failedContext);
			return savedPath ? undefined : "the page was not saved after the failed saves";
		});
	}
}
