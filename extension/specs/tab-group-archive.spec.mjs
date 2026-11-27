// Level 3 spec: the action "save-tab-group-in-archive" saves the tabs of the tab group of the
// current tab in one archive, and "add-tab-group-to-archive" adds them to the archive in progress.
//
// Three tabs are open, the first and the third are put in a tab group and the second is left
// outside of it. The action is sent while a tab of the group is in front: the archive must hold
// the two tabs of the group, in tab order, and not the tab between them. Sent while the tab
// outside of the group is in front, the action must save nothing and say why.
//
// The spec runs in the shared browser, which was NOT started with the optional permission
// "tabGroups": the action reads the id of the group on the tab and asks for the tabs that have
// the same one, which takes no permission. The name of the group is never read.
//
// Level 3 because the group is made through the browser API from one of SingleFile's own pages.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { waitForDownload, clearDownloads, listDownloads } from "../expect/saved-page.mjs";

const CONTROL_PAGE = "src/ui/pages/batch-save-urls.html";
const FIRST_TITLE = "Group first tab";
const OUTSIDE_TITLE = "Tab outside of the group";
const LAST_TITLE = "Group last tab";
const ZIP_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const SECOND_PAGE_ENTRY = "pages/2/index.html";
const THIRD_PAGE_PREFIX = "pages/3/";
const PAGES_ENTRY = "sfz-pages.json";
const ERROR_BAR_TAGNAME = "singlefile-error-bar";
const ERROR_BAR_TEXT = `(() => { const bar = document.querySelector("${ERROR_BAR_TAGNAME}"); return bar && bar.shadowRoot ? bar.shadowRoot.textContent : ""; })()`;
const NO_GROUP_TEXT = "not in a tab group";
const ACTION = "save-tab-group-in-archive";
const ADD_ACTION = "add-tab-group-to-archive";
const ARCHIVE_PAGE = "src/ui/pages/archive.html";
// joined in the page: the driver hands back a string as it is, and an array as a description of it
const ROW_TITLES = "Array.from(document.querySelectorAll(\"#pagesTable .page-title input\")).map(input => input.value).join(\"\\n\")";
// long enough for a row that should not be added to show up
const NO_ROW_DELAY = 3000;

export const name = "tab-group-archive";
export const level = 3;

export async function run({ session, fixtures, test }) {
	// the browser API as an extension page sees it: SingleFile's own `browser` is a short list
	const api = session.browserName == "firefox" ? "browser" : "chrome";
	await session.closeTab(await session.importSettings(ZIP_PROFILE));
	const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
	const firstTab = await session.openTab(fixtures.titledURL(FIRST_TITLE));
	const outsideTab = await session.openTab(fixtures.titledURL(OUTSIDE_TITLE));
	const lastTab = await session.openTab(fixtures.titledURL(LAST_TITLE));
	const openedTabs = [control, firstTab, outsideTab, lastTab];

	try {
		let grouped;
		await test("two tabs are put in a tab group", async () => {
			// the tabs are found by the title of their page, and the answer is the number of
			// tabs the browser reports in the group
			const count = await session.evaluate(control, "(async () => { const tabs = await " + api + ".tabs.query({}); " +
				"const tabIds = [" + JSON.stringify(FIRST_TITLE) + ", " + JSON.stringify(LAST_TITLE) + "].map(title => tabs.find(tab => tab.title == title).id); " +
				"const groupId = await " + api + ".tabs.group({ tabIds }); " +
				"return (await " + api + ".tabs.query({ groupId })).length; })()");
			grouped = count == 2;
			return grouped ? undefined : "the group holds " + JSON.stringify(count) + " tabs";
		});

		await test("the action saves nothing from a tab that is not in a group, and says so", async () => {
			if (!grouped) {
				return "no tab group was made";
			}
			await session.activate(outsideTab);
			clearDownloads(session.downloadDir);
			await session.dispatch(ACTION);
			// the error bar is the signal that the action was handled: checking the download
			// directory before it would pass on an extension that did nothing yet
			const errorText = await waitFor(() => session.evaluate(outsideTab, ERROR_BAR_TEXT), value => Boolean(value));
			if (!errorText || !errorText.includes(NO_GROUP_TEXT)) {
				return "unexpected error message: " + JSON.stringify(errorText);
			}
			const downloads = listDownloads(session.downloadDir);
			return downloads.length ? "a file was saved: " + JSON.stringify(downloads) : undefined;
		});

		await test("the action saves the tabs of the group of the current tab in one archive", async () => {
			if (!grouped) {
				return "no tab group was made";
			}
			// the last tab of the group is in front: the archive starts with the first tab of
			// the group all the same
			await session.activate(lastTab);
			clearDownloads(session.downloadDir);
			await session.dispatch(ACTION);
			const savedPath = await waitForDownload(session.downloadDir);
			const downloads = listDownloads(session.downloadDir);
			if (downloads.length != 1) {
				return "expected one file, found " + JSON.stringify(downloads);
			}
			if (!savedPath.endsWith(".zip") || !basename(savedPath).startsWith(FIRST_TITLE)) {
				return "unexpected name for the archive: " + basename(savedPath);
			}
			// entry names and page titles are stored as they are in a ZIP file, which is
			// enough to tell which pages it holds without unpacking it
			const content = readFileSync(savedPath).toString("latin1");
			const problems = [];
			[SECOND_PAGE_ENTRY, PAGES_ENTRY].forEach(entryName => {
				if (!content.includes(entryName)) {
					problems.push("no entry named " + entryName);
				}
			});
			if (content.includes(THIRD_PAGE_PREFIX)) {
				problems.push("a third page was saved, the group holds two tabs");
			}
			return problems.length ? problems.join("; ") : undefined;
		});

		await test("add-tab-group-to-archive adds the tabs of the group to the archive in progress", async () => {
			if (!grouped) {
				return "no tab group was made";
			}
			// the page is opened after the list was emptied, and it is a tab in front: the tab
			// of the group is brought back in front before the action is sent
			const builderTab = await session.openTab(session.singlefileURL(ARCHIVE_PAGE));
			openedTabs.push(builderTab);
			await session.evaluate(builderTab, "browser.runtime.sendMessage({ method: \"archive.clear\" }).then(() => \"\")");
			await session.activate(lastTab);
			await session.dispatch(ADD_ACTION);
			const expected = [FIRST_TITLE, LAST_TITLE].join("\n");
			const readTitles = async () => {
				const context = await session.openTab(session.singlefileURL(ARCHIVE_PAGE));
				try {
					return await waitFor(() => session.evaluate(context, ROW_TITLES), value => value == expected, { timeout: 5000 });
				} finally {
					await session.closeTab(context);
				}
			};
			let titles = await waitFor(readTitles, value => value == expected);
			if (titles != expected) {
				return "the page lists " + JSON.stringify(titles);
			}
			// the tab outside of the group must not come later
			await new Promise(resolve => setTimeout(resolve, NO_ROW_DELAY));
			titles = await readTitles();
			return titles == expected ? undefined : "the page lists " + JSON.stringify(titles);
		});
	} finally {
		await session.evaluate(control, "browser.runtime.sendMessage({ method: \"archive.clear\" }).then(() => \"\")").catch(() => { });
		await session.closeTab(await session.importSettings(HTML_PROFILE));
		for (const context of openedTabs) {
			await session.closeTab(context);
		}
	}
}

async function waitFor(read, accept, { timeout = 15000 } = {}) {
	const deadline = Date.now() + timeout;
	let value;
	while (Date.now() < deadline) {
		value = await read().catch(() => undefined);
		if (accept(value)) {
			return value;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	return value;
}
