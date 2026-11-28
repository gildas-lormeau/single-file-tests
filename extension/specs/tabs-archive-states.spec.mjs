// Level 3 spec: "save tabs in one archive" when a tab is not in the state the others are in
// (SingleFile#2062). The tab in front cannot be saved, a tab displays a PDF file, a tab was
// unloaded by the browser, a tab displays a page saved with SingleFile and opened from the disk.
//
// Firefox asks the user to allow each extension into the pages opened from the disk; the profile
// of the rig allows it (see launch-firefox.mjs).
//
// Level 3 because unloading a tab is something only the browser decides, or an extension through
// tabs.discard: this spec calls that API from one of SingleFile's own pages (see
// autosave-discard.spec.mjs). Everything it checks is the file on disk and what the user sees.

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForDownload, clearDownloads } from "../expect/saved-page.mjs";

const FIRST_TITLE = "States first tab";
const SECOND_TITLE = "States second tab";
const UNLOADED_TITLE = "States unloaded tab";
const SAVED_TITLE = "States saved page";
const PDF_FILE = "document.pdf";
const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const ZIP_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const OPTIONS_PAGE = "src/ui/pages/options.html";
const PENDINGS_PAGE = "src/ui/pages/pendings.html";
const PAGES_ENTRY = "sfz-pages.json";
const ERROR_BAR_TAGNAME = "singlefile-error-bar";
const ERROR_BAR_TEXT = `(() => { const bar = document.querySelector("${ERROR_BAR_TAGNAME}"); return bar && bar.shadowRoot ? bar.shadowRoot.textContent : ""; })()`;
const VISIBILITY = "document.visibilityState";
const VISIBLE = "visible";
const FAILURE_TEXT = "could not be saved in the archive";
const SAVED_PAGE_SCHEMES = ["http://", "file://"];
// the records of a ZIP file used to read one of its entries
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const DEFLATE_METHOD = 8;

export const name = "tabs-archive-states";
export const level = 3;

export async function run({ session, fixtures, test }) {
	await session.closeTab(await session.importSettings(ZIP_PROFILE));
	const firstTab = await session.openTab(fixtures.titledURL(FIRST_TITLE));
	await closeOtherPages(session, [firstTab]);
	const secondTab = await session.openTab(fixtures.titledURL(SECOND_TITLE));
	const openedTabs = [firstTab, secondTab];

	try {
		// The message listing the tabs left out is displayed in a page, so it needs a tab
		// SingleFile can display it in. When the tab in front is not one, the message went to
		// the first saved tab, which was hidden: nothing told the user that tabs were missing.
		await test("the tabs left out are reported in a visible tab when the tab in front cannot be saved", async () => {
			const optionsTab = await session.openTab(session.singlefileURL(OPTIONS_PAGE));
			try {
				await saveTabs(session, "save-all-tabs-in-archive");
				const reported = await waitFor(() => readErrors(session, [firstTab, secondTab]), errors => errors.some(({ text }) => text));
				const displayed = (reported || []).filter(({ text }) => text);
				if (!displayed.length) {
					return "no error was displayed in a saved tab";
				}
				if (!displayed[0].text.includes(FAILURE_TEXT) || !displayed[0].text.includes(basename(OPTIONS_PAGE))) {
					return "unexpected error message: " + JSON.stringify(displayed[0].text);
				}
				const visible = await waitFor(() => readErrors(session, [firstTab, secondTab]), errors => errors.some(({ text, visibility }) => text && visibility == VISIBLE));
				return visible.some(({ text, visibility }) => text && visibility == VISIBLE) ? undefined : "the error is displayed in a hidden tab";
			} finally {
				await session.closeTab(optionsTab);
			}
		});

		// Chromium lets an extension run scripts in the document of its PDF viewer, so the tab
		// looked saved: the archive held a page with an empty frame and no PDF, and the tab was
		// not reported. Firefox refuses the scripts, and the tab was reported.
		await test("a tab displaying a PDF file is left out and reported", async () => {
			await session.activate(secondTab);
			const pdfTab = await session.openTab(fixtures.url(PDF_FILE));
			try {
				await session.activate(secondTab);
				const savedPath = await saveTabs(session, "save-all-tabs-in-archive");
				const manifest = JSON.parse(readEntry(readFileSync(savedPath), PAGES_ENTRY));
				const urls = manifest.pages.map(page => page.url);
				if (urls.some(url => url.includes(PDF_FILE))) {
					return "the PDF tab is a page of the archive: " + JSON.stringify(urls);
				}
				if (urls.length != 2) {
					return "expected the two HTML pages in the archive, found " + JSON.stringify(urls);
				}
				const errorText = await waitFor(() => session.evaluate(secondTab, ERROR_BAR_TEXT), value => Boolean(value && value.includes(PDF_FILE)));
				return errorText && errorText.includes(PDF_FILE) ? undefined : "the PDF tab is not reported, the message is " + JSON.stringify(errorText);
			} finally {
				await session.closeTab(pdfTab);
			}
		});

		// A browser short of memory unloads the tabs in the background. Chromium loads such a tab
		// again when SingleFile runs its scripts in it, and the tab is saved like the others.
		//
		// Chromium only: Firefox runs no script in an unloaded tab, which is reported as a tab that
		// could not be saved (SingleFile#2062). Loading it again from the extension is not possible
		// yet: in Firefox 161, tabs.reload leaves such a tab on about:blank.
		if (session.browserName == "chromium") {
			await test("a tab unloaded by the browser is saved", async () => {
				const unloadedTab = await session.openTab(fixtures.titledURL(UNLOADED_TITLE));
				openedTabs.push(unloadedTab);
				await session.activate(secondTab);
				try {
					const state = await discardTab(session, UNLOADED_TITLE);
					if (state != "discarded") {
						return "the tab could not be unloaded: " + state;
					}
					// reading the state opened a page of the extension, which was closed
					await session.activate(secondTab);
					const savedPath = await saveTabs(session, "save-all-tabs-in-archive");
					const manifest = JSON.parse(readEntry(readFileSync(savedPath), PAGES_ENTRY));
					const titles = manifest.pages.map(page => page.title);
					return titles.includes(UNLOADED_TITLE) ? undefined : "the unloaded tab is not in the archive, which holds " + JSON.stringify(titles);
				} finally {
					// a discarded tab is a new tab to Chromium, the context no longer closes it
					await session.closeTabsShowing(encodeURIComponent(UNLOADED_TITLE));
				}
			});
		}

		// The address of a page saved with SingleFile is in the comment at the top of its file.
		// Opened from the disk, such a page was recorded in the archive under the file:// address
		// of the file, which means nothing on another computer.
		await test("a saved page opened from the disk is recorded under the address it was saved from", async () => {
			await session.closeTab(await session.importSettings(HTML_PROFILE));
			const pageURL = fixtures.titledURL(SAVED_TITLE);
			const pageTab = await session.openTab(pageURL);
			clearDownloads(session.downloadDir);
			await session.dispatch("save-page");
			const pagePath = await waitForDownload(session.downloadDir);
			await session.closeTab(pageTab);
			const fileTab = await session.openTab(pathToFileURL(pagePath).href);
			try {
				await session.closeTab(await session.importSettings(ZIP_PROFILE));
				await session.activate(fileTab);
				// the file of the saved page is removed with the other downloads before the save:
				// the page is loaded, the tab no longer needs it
				const savedPath = await saveTabs(session, "save-selected-tabs-in-archive");
				const manifest = JSON.parse(readEntry(readFileSync(savedPath), PAGES_ENTRY));
				const urls = manifest.pages.map(page => page.url);
				return urls.length == 1 && urls[0] == pageURL ? undefined : "expected " + pageURL + ", the archive records " + JSON.stringify(urls);
			} finally {
				await session.closeTab(fileTab);
			}
		});
	} finally {
		await session.closeTab(await session.importSettings(HTML_PROFILE));
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

async function readErrors(session, contexts) {
	return Promise.all(contexts.map(async context => ({
		text: await session.evaluate(context, ERROR_BAR_TEXT),
		visibility: await session.evaluate(context, VISIBILITY)
	})));
}

// Ask the browser to unload the tab showing the given page, from a page of the extension, and
// tell what the browser says of the tab afterwards.
async function discardTab(session, pageTitle) {
	const context = await session.openTab(session.singlefileURL(PENDINGS_PAGE));
	const api = session.browserName == "firefox" ? "browser" : "chrome";
	const findTab = "(await " + api + ".tabs.query({})).find(tab => tab.url && tab.url.includes(" + JSON.stringify(encodeURIComponent(pageTitle)) + "))";
	const state = await session.evaluate(context, "(async () => { const tab = " + findTab + "; " +
		"if (!tab) { return \"no tab\"; } await " + api + ".tabs.discard(tab.id); " +
		"const discardedTab = " + findTab + "; " +
		"return discardedTab ? (discardedTab.discarded ? \"discarded\" : \"not discarded\") : \"no tab after the discard\"; })()");
	await session.closeTab(context);
	return state;
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

// Read the text of an entry of a ZIP file, or undefined when the file has no such entry. The
// entry is found through the central directory, where its size is always recorded.
function readEntry(archive, entryName) {
	for (let offset = archive.length - CENTRAL_HEADER_LENGTH; offset >= 0; offset--) {
		if (archive.readUInt32LE(offset) == CENTRAL_HEADER_SIGNATURE) {
			const nameLength = archive.readUInt16LE(offset + 28);
			const entry = archive.toString("utf8", offset + CENTRAL_HEADER_LENGTH, offset + CENTRAL_HEADER_LENGTH + nameLength);
			if (entry == entryName) {
				const method = archive.readUInt16LE(offset + 10);
				const compressedSize = archive.readUInt32LE(offset + 20);
				const localOffset = archive.readUInt32LE(offset + 42);
				const dataOffset = localOffset + LOCAL_HEADER_LENGTH + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
				const data = archive.subarray(dataOffset, dataOffset + compressedSize);
				return (method == DEFLATE_METHOD ? inflateRawSync(data) : data).toString("utf8");
			}
		}
	}
	return undefined;
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
