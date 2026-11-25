// Level 2 spec: the "save tabs in one archive" actions. Several tabs are open, the relay asks
// SingleFile to save them through the action strings the menu entries use, and the file on disk
// is inspected: there must be one, it must hold every tab in tab order, and it must open on its
// table of contents.
//
// Level 2 because the format of the archive follows the profile, which is set through the
// Import feature of the options page (see archive.spec.mjs).
//
// The session is shared with the other specs, and "all tabs" means all of them: the pages the
// earlier specs left open are closed first, otherwise they would be pages of the archive. The
// extension pages left open (options) are not closed, on purpose: a tab SingleFile cannot save
// must be left out of the archive without preventing it.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForDownload, clearDownloads, listDownloads } from "../expect/saved-page.mjs";

const FIRST_TITLE = "Archive first tab";
const SECOND_TITLE = "Rich functional fixture";
const THIRD_TITLE = "Archive third tab";
const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const ZIP_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const PASSWORD_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "secret" };
// the routes of the pages inside a multi-page archive: the first page is at the root of the
// archive, the others are in pages/<position>/
const SECOND_PAGE_ROUTE = "#sfz/pages/2/";
const SECOND_PAGE_ENTRY = "pages/2/index.html";
const THIRD_PAGE_ENTRY = "pages/3/index.html";
const FOURTH_PAGE_PREFIX = "pages/4/";
const PAGES_ENTRY = "sfz-pages.json";
const TOC_ENTRY = "sfz-toc.html";
const ZIP_SIGNATURE = "PK";
// joined in the page: the driver hands back a string as it is, and an array as a description of it
const TOC_LINKS = "Array.from(document.querySelectorAll(\"a\")).map(link => link.textContent).join(\"\\n\")";
const ERROR_BAR_TAGNAME = "singlefile-error-bar";
const ERROR_BAR_TEXT = `(() => { const bar = document.querySelector("${ERROR_BAR_TAGNAME}"); return bar && bar.shadowRoot ? bar.shadowRoot.textContent : ""; })()`;
const SAVED_PAGE_SCHEMES = ["http://", "file://"];
const EDITOR_PAGE = "editor.html";
const EDITOR_SETTLE_DELAY = 4000;

export const name = "tabs-archive";
export const level = 2;

export async function run({ session, fixtures, test }) {
	await session.importSettings(HTML_PROFILE);
	const firstTab = await session.openTab(fixtures.titledURL(FIRST_TITLE));
	await closeOtherPages(session, [firstTab]);
	const secondTab = await session.openTab(fixtures.url("rich.html"));
	const thirdTab = await session.openTab(fixtures.titledURL(THIRD_TITLE));
	const openedTabs = [firstTab, secondTab, thirdTab];

	try {
		// only set once a single file was written, so the next tests cannot pass vacuously
		let archivePath, archiveTab;
		await test("save-all-tabs-in-archive writes one file for all the tabs, named after the first one", async () => {
			const savedPath = await saveTabs(session, "save-all-tabs-in-archive");
			const downloads = listDownloads(session.downloadDir);
			if (downloads.length != 1) {
				return "expected one file, found " + JSON.stringify(downloads);
			}
			// the default profile saves plain HTML, which cannot hold several pages: the
			// archive is then a self-extracting one that also opens from file://
			if (!basename(savedPath).startsWith(FIRST_TITLE) || !savedPath.endsWith(".u.zip.html")) {
				return "unexpected name for the archive: " + basename(savedPath);
			}
			archivePath = savedPath;
			return undefined;
		});

		await test("the archive opens on a table of contents listing the tabs in tab order", async () => {
			if (!archivePath) {
				return "no archive was saved to open";
			}
			archiveTab = await session.openTab(pathToFileURL(archivePath).href);
			const expected = [FIRST_TITLE, SECOND_TITLE, THIRD_TITLE].join("\n");
			const links = await waitFor(() => session.evaluate(archiveTab, TOC_LINKS), value => value == expected);
			return links == expected ? undefined : "the table of contents lists " + JSON.stringify(links);
		});

		await test("a page of the archive other than the first one is displayed from it", async () => {
			if (!archiveTab) {
				return "no archive is open";
			}
			await session.evaluate(archiveTab, "location.hash = " + JSON.stringify(SECOND_PAGE_ROUTE));
			const title = await waitFor(() => session.evaluate(archiveTab, "document.title"), value => value == SECOND_TITLE);
			if (title != SECOND_TITLE) {
				return "the second page was not displayed, the title is " + JSON.stringify(title);
			}
			const text = await session.evaluate(archiveTab, "document.body.innerText");
			return text.includes(MARKER_TEXT) ? undefined : "the second page is displayed without its content";
		});
		if (archiveTab) {
			await session.closeTab(archiveTab);
		}

		await test("with a ZIP profile the archive is a plain ZIP file holding every tab", async () => {
			await session.importSettings(ZIP_PROFILE);
			const savedPath = await saveTabs(session, "save-unpinned-tabs-in-archive");
			if (!savedPath.endsWith(".zip") || !basename(savedPath).startsWith(FIRST_TITLE)) {
				return "unexpected name for the archive: " + basename(savedPath);
			}
			// entry names are stored as they are in a ZIP file, which is enough to tell
			// which pages it holds without unpacking it
			const content = readFileSync(savedPath).toString("latin1");
			const problems = [];
			if (!content.startsWith(ZIP_SIGNATURE)) {
				problems.push("the file does not start with a ZIP record");
			}
			[SECOND_PAGE_ENTRY, THIRD_PAGE_ENTRY, PAGES_ENTRY, TOC_ENTRY].forEach(entryName => {
				if (!content.includes(entryName)) {
					problems.push("no entry named " + entryName);
				}
			});
			if (content.includes(FOURTH_PAGE_PREFIX)) {
				problems.push("a fourth page was saved, from a tab that is not one of the three");
			}
			return problems.length ? problems.join("; ") : undefined;
		});

		await test("save-selected-tabs-in-archive saves the selected tab only", async () => {
			// importing the settings left the options page in front, and the selected tab
			// is the one in front
			await session.activate(thirdTab);
			const savedPath = await saveTabs(session, "save-selected-tabs-in-archive");
			if (!basename(savedPath).startsWith(THIRD_TITLE)) {
				return "the archive is not named after the selected tab: " + basename(savedPath);
			}
			const content = readFileSync(savedPath).toString("latin1");
			if (!content.includes(PAGES_ENTRY)) {
				return "the file is not a multi-page archive";
			}
			return content.includes(SECOND_PAGE_ENTRY) ? "another tab was saved with the selected one" : undefined;
		});

		await test("a profile with a password is refused with an error, and nothing is saved", async () => {
			await session.importSettings(PASSWORD_PROFILE);
			await session.activate(thirdTab);
			clearDownloads(session.downloadDir);
			await session.dispatch("save-all-tabs-in-archive");
			// the error bar is the signal that the action was handled: checking the
			// download directory before it would pass on an extension that did nothing yet
			const errorText = await waitFor(() => session.evaluate(thirdTab, ERROR_BAR_TEXT), value => Boolean(value));
			if (!errorText) {
				return "no error was displayed in the tab in front";
			}
			if (!errorText.includes("password")) {
				return "the error does not mention the password: " + JSON.stringify(errorText);
			}
			const downloads = listDownloads(session.downloadDir);
			return downloads.length ? "a file was saved: " + JSON.stringify(downloads) : undefined;
		});

		// The annotation editor saves its page on its own, after it answered the request: its
		// page arrived once the archive was written, and was saved in a file of its own beside
		// the archive. The editor tab is left out, like every tab that cannot be saved.
		await test("the annotation editor tab is left out, and saves no file of its own", async () => {
			await session.importSettings(ZIP_PROFILE);
			await session.activate(firstTab);
			await session.dispatch("edit-and-save-page");
			const editorTab = await waitFor(async () => {
				const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
				return contexts.find(({ url }) => url.includes(EDITOR_PAGE));
			}, Boolean);
			if (!editorTab) {
				return "the annotation editor did not open";
			}
			openedTabs.push(editorTab.context);
			// the editor gets its page after its tab is loaded
			await new Promise(resolve => setTimeout(resolve, EDITOR_SETTLE_DELAY));
			const savedPath = await saveTabs(session, "save-all-tabs-in-archive");
			// a second file, if any, comes after the archive
			await new Promise(resolve => setTimeout(resolve, EDITOR_SETTLE_DELAY));
			const downloads = listDownloads(session.downloadDir);
			if (downloads.length != 1) {
				return "expected one file, found " + JSON.stringify(downloads.map(path => basename(path)));
			}
			const content = readFileSync(savedPath).toString("latin1");
			if (!content.includes(THIRD_PAGE_ENTRY)) {
				return "the archive does not hold the three tabs";
			}
			return content.includes(FOURTH_PAGE_PREFIX) ? "the editor tab was saved as a fourth page" : undefined;
		});
	} finally {
		await session.importSettings(HTML_PROFILE);
		for (const context of openedTabs) {
			await session.closeTab(context);
		}
	}
}

async function saveTabs(session, action) {
	clearDownloads(session.downloadDir);
	await session.dispatch(action);
	return waitForDownload(session.downloadDir);
}

// Close the pages the earlier specs left open, which SingleFile could save.
async function closeOtherPages(session, keptContexts) {
	const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
	for (const { context, url } of contexts) {
		if (!keptContexts.includes(context) && SAVED_PAGE_SCHEMES.some(scheme => url.startsWith(scheme))) {
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
