// Level 2 spec: a page saved as a ZIP file through the annotation editor. The page is captured,
// the editor opens with it, and its save button writes the file. The editor reads the entries
// of the captured archive back and sorts them into images, fonts, scripts and stylesheets
// before the file is built again.
//
// The fixture uses a stylesheet as an image, which real pages do by mistake. The archive then
// holds an image entry named "images/<n>.css": sorted by its extension as well as by its folder,
// it was added twice and nothing was saved ("File already exists", SingleFile issue 1915).
//
// Level 2 because the format follows the profile, set through the Import feature of the
// options page (see archive.spec.mjs).

import { readFileSync } from "node:fs";
import { waitForDownload, clearDownloads, listDownloads } from "../expect/saved-page.mjs";

const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const ZIP_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const FIXTURE_PAGE = "editor-resources.html";
const EDITOR_PAGE = "editor.html";
const ZIP_SIGNATURE = "PK";
const STYLESHEET_IMAGE_ENTRY = /images\/\d+\.css/;
const PAGE_ENTRY = "index.html";
// The save button is in the editor page from the start, and pressing it before the page arrived
// saves nothing, silently. The editor replaces its "Please wait..." title with this prefix followed
// by the title of the page once the page is displayed and can be saved.
const EDITOR_TITLE_PREFIX = "[SingleFile] ";
const EDITOR_READY = "document.title.startsWith(" + JSON.stringify(EDITOR_TITLE_PREFIX) + ")";
// the button listens to "mouseup", which a synthetic click does not send
const PRESS_SAVE_BUTTON = "document.querySelector(\".save-page-button\").dispatchEvent(new MouseEvent(\"mouseup\", { bubbles: true }))";
const ERROR_BAR_TEXT = "(() => { const bar = document.querySelector(\"singlefile-error-bar\"); return bar && bar.shadowRoot ? bar.shadowRoot.textContent : \"\"; })()";
const READY_TIMEOUT = 20000;
const POLL_DELAY = 200;
const SAVE_TIMEOUT = 20000;

export const name = "editor-archive";
export const level = 2;

export async function run({ session, fixtures, test }) {
	await session.closeTab(await session.importSettings(ZIP_PROFILE));
	const pageTab = await session.openTab(fixtures.url(FIXTURE_PAGE));
	const openedTabs = [pageTab];
	try {
		await test("the editor saves a ZIP file holding an image entry named like a stylesheet", async () => {
			clearDownloads(session.downloadDir);
			await session.dispatch("edit-and-save-page");
			// The editor tab is looked for again at each attempt: while its page loads, the tab found
			// by its URL may have no document to evaluate a script in yet, which is one more way of
			// not being ready. The last refusal is reported if the editor never gets ready.
			let lastError;
			const editorTab = await waitFor(async () => {
				const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
				const tab = contexts.find(({ url }) => url.includes(EDITOR_PAGE));
				if (tab && !openedTabs.includes(tab.context)) {
					openedTabs.push(tab.context);
				}
				try {
					return tab && await session.evaluate(tab.context, EDITOR_READY) ? tab : undefined;
				} catch (error) {
					lastError = error;
					return undefined;
				}
			}, Boolean);
			if (!editorTab) {
				return "the annotation editor did not display the page" + (lastError ? " (" + lastError.message + ")" : "");
			}
			await session.evaluate(editorTab.context, PRESS_SAVE_BUTTON);
			let savedPath;
			try {
				savedPath = await waitForDownload(session.downloadDir, { timeout: SAVE_TIMEOUT });
			} catch (error) {
				const errorText = await session.evaluate(editorTab.context, ERROR_BAR_TEXT);
				return "no file was saved (" + error.message + "), error shown in the editor: " + JSON.stringify(errorText);
			}
			const downloads = listDownloads(session.downloadDir);
			if (downloads.length != 1) {
				return "expected one file, found " + JSON.stringify(downloads);
			}
			const content = readFileSync(savedPath).toString("latin1");
			if (!content.startsWith(ZIP_SIGNATURE)) {
				return "the saved file is not a ZIP file";
			}
			// without this entry the fixture no longer exercises the case
			if (!STYLESHEET_IMAGE_ENTRY.test(content)) {
				return "the archive holds no image entry named like a stylesheet";
			}
			const pageEntries = countEntries(content, PAGE_ENTRY);
			return pageEntries == 1 ? undefined : "expected one " + PAGE_ENTRY + " entry, found " + pageEntries;
		});
	} finally {
		await session.closeTab(await session.importSettings(HTML_PROFILE));
		for (const context of openedTabs) {
			await session.closeTab(context);
		}
	}
}

// counts the central directory records (signature "PK\x01\x02") whose name is exactly entryName
function countEntries(content, entryName) {
	const NAME_LENGTH_OFFSET = 28;
	const NAME_OFFSET = 46;
	let count = 0;
	let offset = content.indexOf("PK\x01\x02");
	while (offset != -1) {
		const nameLength = content.charCodeAt(offset + NAME_LENGTH_OFFSET) + content.charCodeAt(offset + NAME_LENGTH_OFFSET + 1) * 256;
		if (content.substring(offset + NAME_OFFSET, offset + NAME_OFFSET + nameLength) == entryName) {
			count++;
		}
		offset = content.indexOf("PK\x01\x02", offset + NAME_OFFSET);
	}
	return count;
}

async function waitFor(getValue, isReady) {
	const deadline = Date.now() + READY_TIMEOUT;
	let value = await getValue();
	while (!isReady(value) && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, POLL_DELAY));
		value = await getValue();
	}
	return isReady(value) ? value : undefined;
}
