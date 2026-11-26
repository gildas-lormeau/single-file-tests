// Level 3 spec: two saves that need the offscreen document at the same moment, when it does not
// exist yet, are both served.
//
// In Chromium the background script is a service worker, and the pages are compressed in an
// offscreen document created at the first need. The second of two saves ending together used to
// find the document already listed among the contexts of the extension while it was still
// loading, and sent it a message that nothing was listening to yet: that page failed with "The
// message port closed before a response was received". It happened once per browser session, to
// whoever started with several compressed saves at once.
//
// Level 3 because the offscreen document is closed and the URLs are added through the API and the
// messages of SingleFile's own pages. Firefox has no offscreen document: the spec only runs the
// plain case there.

import { sleep } from "../expect/autosave.mjs";

const CONTROL_PAGE = "src/ui/pages/batch-save-urls.html";
const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const URL_COUNT = 2;
const POLL_DELAY = 250;
const SAVE_TIMEOUT = 30000;
const CLOSE_OFFSCREEN_DOCUMENT = "(async () => { try { await chrome.offscreen.closeDocument(); return \"closed\"; } catch (error) { return \"none\"; } })()";

export const name = "offscreen-start";
export const level = 3;

export async function run({ session, fixtures, test }) {
	const run = Date.now();
	let round = 0;

	await session.closeTab(await session.importSettings(HTML_PROFILE));

	await test("two pages stored at once both reach the archive in progress", async () => {
		const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
		const problem = await storeProblem(control);
		await session.closeTab(control);
		return problem;
	});

	if (session.browserName != "firefox") {
		await test("they both reach it when the offscreen document does not exist yet", async () => {
			const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
			// the test before left the document open: without this the case under test is not met
			const closed = await session.evaluate(control, CLOSE_OFFSCREEN_DOCUMENT);
			const problem = closed == "closed" ? await storeProblem(control) : "there was no offscreen document to close, the case is not the one under test";
			await session.closeTab(control);
			return problem;
		});
	}

	async function storeProblem(control) {
		round++;
		const urls = Array.from({ length: URL_COUNT }, (_, index) => fixtures.titledURL("offscreen-" + run + "-" + round + "-" + (index + 1)));
		await send(control, { method: "archive.clear" });
		await send(control, { method: "archive.addUrls", urls });
		const deadline = Date.now() + SAVE_TIMEOUT;
		let pages = [];
		while (Date.now() < deadline && pages.length < urls.length) {
			await sleep(POLL_DELAY);
			pages = await send(control, { method: "archive.getPages" });
		}
		await send(control, { method: "archive.clear" });
		const stored = urls.filter(url => pages.some(page => page.url == url && !page.failed)).length;
		return stored == urls.length ? undefined
			: stored + " page(s) of " + urls.length + " stored: " + JSON.stringify(pages.map(page => ({ url: page.url.slice(-20), failed: Boolean(page.failed) })));
	}

	async function send(context, message) {
		return JSON.parse(await session.evaluate(context,
			"browser.runtime.sendMessage(" + JSON.stringify(message) + ").then(response => JSON.stringify(response === undefined ? null : response))"));
	}
}
