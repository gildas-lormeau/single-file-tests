// Level 3 spec: the archive in progress. Tabs are added to it one at a time through the action
// strings the menu entries use, nothing is written to disk meanwhile, and the "Archive in
// progress" page of the extension lists the stored pages, lets the user rename, reorder and
// remove them, and produces the file.
//
// Level 3 because the list lives in a page of the extension: its rows are read, and its title
// fields are filled, by script. The buttons are clicked like a user does where the browser
// allows it (see click in session.mjs).
//
// Not covered: a tab of a private window (refused by the extension, the rig opens none) and a
// browser restart between two additions (the session is shared with the other specs).

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForDownload, clearDownloads, listDownloads } from "../expect/saved-page.mjs";

const ARCHIVE_PAGE = "src/ui/pages/archive.html";
const BATCH_PAGE = "src/ui/pages/batch-save-urls.html";
const FIRST_URL_TITLE = "Builder first URL";
const SECOND_URL_TITLE = "Builder second URL";
const ADD_TO_ARCHIVE_BUTTON = "#addToArchiveButton";
const VIEW_ARCHIVE_BUTTON = "#viewArchiveButton";
const LISTED_URLS_COUNT = "String(document.querySelectorAll(\"#urlsTable .result-url-title\").length)";
const FIRST_TITLE = "Builder first tab";
const SECOND_TITLE = "Builder second tab";
const THIRD_TITLE = "Builder third tab";
const RENAMED_TITLE = "Renamed in the builder";
const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const ZIP_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
// without the background save, the file is handed to the page, which downloads it itself: it is
// the default in Safari and in Firefox for Android
const FOREGROUND_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "", backgroundSave: false };
const OPTIONS_PAGE = "src/ui/pages/options.html";
const DEDUP_CHECKBOX = "#archiveDedupPagesInput";
// the options page is one long column of collapsed sections; a headless window is far
// too short for it, and a pointer aimed below the fold silently hits something else
const OPTIONS_VIEWPORT = { width: 1200, height: 4000 };
// the options page persists on change, asynchronously
const OPTIONS_SETTLE_DELAY = 750;
// in a ZIP file, a file stored once is replaced in the other pages by a symbolic link, whose
// content is the relative path of the stored file: from pages/2/ it starts by going up twice
const SYMLINK_TARGET = /\.\.\/\.\.\/[\w./-]+/g;
const ARCHIVE_OPTIONS_PROFILE = { ...ZIP_PROFILE, archiveTableOfContents: false, archiveMarkUnarchivedLinks: true, archivePageTransitions: "fade" };
const FADE_TRANSITION = "fade";
// the records of a ZIP file used to read one of its entries
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const DEFLATE_METHOD = 8;
const FAILED_ROW_URLS = "Array.from(document.querySelectorAll(\"#pagesTable .page-failed .page-url\")).map(label => label.textContent).join(\"\\n\")";
const FAILED_ROW_STATUS = "Array.from(document.querySelectorAll(\"#pagesTable .page-failed .page-size\")).map(cell => cell.textContent).join(\"\\n\")";
const FAILED_LABEL = "document.getElementById(\"failedLabel\").hidden ? \"\" : document.getElementById(\"failedLabel\").textContent";
const FAILED_ROW_REMOVE_BUTTON = "#pagesTable .page-failed .page-remove button";
const ROWS_COUNT = "String(document.querySelectorAll(\"#pagesTable .page-title input\").length)";
const NOT_SAVED_STATUS = "not saved";
const PASSWORD_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "secret" };
const SECOND_PAGE_ENTRY = "pages/2/index.html";
const THIRD_PAGE_ENTRY = "pages/3/index.html";
const FOURTH_PAGE_PREFIX = "pages/4/";
const PAGES_ENTRY = "sfz-pages.json";
const TOC_ENTRY = "sfz-toc.html";
const ZIP_SIGNATURE = "PK";
// joined in the page: the driver hands back a string as it is, and an array as a description of it
const ROW_TITLES = "Array.from(document.querySelectorAll(\"#pagesTable .page-title input\")).map(input => input.value).join(\"\\n\")";
const TOC_LINKS = "Array.from(document.querySelectorAll(\"a\")).map(link => link.textContent).join(\"\\n\")";
const ERROR_TEXT = "document.getElementById(\"errorLabel\").textContent";
const FILENAME_VALUE = "document.getElementById(\"filenameInput\").value";
const REMOVE_ALL_BUTTON = "#removeAllButton";
const SAVE_BUTTON = "#saveButton";
// the second row is the first one that can move up
const SECOND_ROW_UP_BUTTON = "#pagesTable .page-row:nth-child(2) .page-move button:first-child";
const RENAME_SECOND_ROW = `(() => {
	const input = document.querySelectorAll("#pagesTable .page-title input")[1];
	input.value = ${JSON.stringify(RENAMED_TITLE)};
	input.dispatchEvent(new Event("change"));
})()`;
// long enough for a file that should not be written to show up
const NO_DOWNLOAD_DELAY = 3000;

export const name = "archive-builder";
export const level = 3;

export async function run({ session, fixtures, test }) {
	await session.closeTab(await session.importSettings(HTML_PROFILE));
	const firstTab = await session.openTab(fixtures.titledURL(FIRST_TITLE));
	const secondTab = await session.openTab(fixtures.titledURL(SECOND_TITLE));
	const thirdTab = await session.openTab(fixtures.titledURL(THIRD_TITLE));
	const openedTabs = [firstTab, secondTab, thirdTab];
	// The page is opened again each time it is needed, in a new tab, which is what the "View the
	// archive in progress" menu entry does. A new tab is the tab in front, where a pointer click
	// lands, and Firefox 156+ refuses to bring a page of an extension back to the front. It also
	// shows what was really stored: the rows of a new page are read back from the extension.
	let builderTab;
	const openBuilder = async () => {
		if (builderTab) {
			await session.closeTab(builderTab);
		}
		builderTab = await session.openTab(session.singlefileURL(ARCHIVE_PAGE));
	};
	await openBuilder();
	const rowTitles = expected => waitFor(() => session.evaluate(builderTab, ROW_TITLES), value => value == expected);

	try {
		// a list left by an earlier run of this spec in the same profile would shift every row
		if (await rowTitles("") != "") {
			await session.click(builderTab, REMOVE_ALL_BUTTON);
		}
		clearDownloads(session.downloadDir);

		// only set once the rows are the expected ones, so the next tests cannot pass vacuously
		let pagesAdded;
		await test("add-tab-to-archive stores the tab in front and writes no file", async () => {
			await session.activate(firstTab);
			await session.dispatch("add-tab-to-archive");
			let titles = await rowTitles(FIRST_TITLE);
			if (titles != FIRST_TITLE) {
				return "after the first tab the page lists " + JSON.stringify(titles);
			}
			await session.activate(secondTab);
			await session.dispatch("add-tab-to-archive");
			const expected = [FIRST_TITLE, SECOND_TITLE].join("\n");
			titles = await rowTitles(expected);
			if (titles != expected) {
				return "after the second tab the page lists " + JSON.stringify(titles);
			}
			await new Promise(resolve => setTimeout(resolve, NO_DOWNLOAD_DELAY));
			const downloads = listDownloads(session.downloadDir);
			if (downloads.length) {
				return "a file was written: " + JSON.stringify(downloads.map(path => basename(path)));
			}
			pagesAdded = true;
			return undefined;
		});

		await test("add-selected-tabs-to-archive adds the selected tab after the stored ones", async () => {
			if (!pagesAdded) {
				return "the first pages were not stored";
			}
			await session.activate(thirdTab);
			await session.dispatch("add-selected-tabs-to-archive");
			const expected = [FIRST_TITLE, SECOND_TITLE, THIRD_TITLE].join("\n");
			const titles = await rowTitles(expected);
			return titles == expected ? undefined : "the page lists " + JSON.stringify(titles);
		});

		let reordered;
		await test("a page is renamed and moved up in the list", async () => {
			if (!pagesAdded) {
				return "the first pages were not stored";
			}
			await openBuilder();
			await rowTitles([FIRST_TITLE, SECOND_TITLE, THIRD_TITLE].join("\n"));
			await session.evaluate(builderTab, RENAME_SECOND_ROW);
			// the field shows the new title as soon as it is typed: the page is opened again
			// to read what was stored, and to click in a list that is not being redrawn
			await openBuilder();
			let expected = [FIRST_TITLE, RENAMED_TITLE, THIRD_TITLE].join("\n");
			let titles = await rowTitles(expected);
			if (titles != expected) {
				return "after the renaming the page lists " + JSON.stringify(titles);
			}
			await session.click(builderTab, SECOND_ROW_UP_BUTTON);
			expected = [RENAMED_TITLE, FIRST_TITLE, THIRD_TITLE].join("\n");
			titles = await rowTitles(expected);
			if (titles != expected) {
				return "after the move the page lists " + JSON.stringify(titles);
			}
			await openBuilder();
			titles = await rowTitles(expected);
			if (titles != expected) {
				return "after a reload the page lists " + JSON.stringify(titles);
			}
			reordered = true;
			return undefined;
		});

		let archivePath;
		await test("the save button writes one archive, named after the first page of the list", async () => {
			if (!reordered) {
				return "the list is not in the expected state";
			}
			// the file name keeps the name the page was given when it was captured
			const filename = await waitFor(() => session.evaluate(builderTab, FILENAME_VALUE), value => Boolean(value));
			if (!filename.startsWith(SECOND_TITLE)) {
				return "the file name field holds " + JSON.stringify(filename);
			}
			clearDownloads(session.downloadDir);
			await session.click(builderTab, SAVE_BUTTON);
			const savedPath = await waitForDownload(session.downloadDir);
			const downloads = listDownloads(session.downloadDir);
			if (downloads.length != 1) {
				return "expected one file, found " + JSON.stringify(downloads.map(path => basename(path)));
			}
			// the default profile saves plain HTML, which cannot hold several pages
			if (!basename(savedPath).startsWith(SECOND_TITLE) || !savedPath.endsWith(".u.zip.html")) {
				return "unexpected name for the archive: " + basename(savedPath);
			}
			archivePath = savedPath;
			return undefined;
		});

		await test("the archive lists the pages in the order and with the titles of the list", async () => {
			if (!archivePath) {
				return "no archive was saved to open";
			}
			const archiveTab = await session.openTab(pathToFileURL(archivePath).href);
			openedTabs.push(archiveTab);
			const expected = [RENAMED_TITLE, FIRST_TITLE, THIRD_TITLE].join("\n");
			const links = await waitFor(() => session.evaluate(archiveTab, TOC_LINKS), value => value == expected);
			return links == expected ? undefined : "the table of contents lists " + JSON.stringify(links);
		});

		await test("the pages stay in the list, and a ZIP profile gives a plain ZIP file of them", async () => {
			if (!archivePath) {
				return "no archive was saved";
			}
			await session.closeTab(await session.importSettings(ZIP_PROFILE));
			await openBuilder();
			const expected = [RENAMED_TITLE, FIRST_TITLE, THIRD_TITLE].join("\n");
			const titles = await rowTitles(expected);
			if (titles != expected) {
				return "after the save the page lists " + JSON.stringify(titles);
			}
			clearDownloads(session.downloadDir);
			await session.click(builderTab, SAVE_BUTTON);
			const savedPath = await waitForDownload(session.downloadDir);
			if (!savedPath.endsWith(".zip") || savedPath.endsWith(".html")) {
				return "unexpected name for the archive: " + basename(savedPath);
			}
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
				problems.push("a fourth page was saved");
			}
			return problems.length ? problems.join("; ") : undefined;
		});

		await test("without the background save, the page downloads the archive itself", async () => {
			if (!archivePath) {
				return "no archive was saved";
			}
			await session.closeTab(await session.importSettings(FOREGROUND_PROFILE));
			await openBuilder();
			await rowTitles([RENAMED_TITLE, FIRST_TITLE, THIRD_TITLE].join("\n"));
			clearDownloads(session.downloadDir);
			await session.click(builderTab, SAVE_BUTTON);
			const savedPath = await waitForDownload(session.downloadDir);
			if (!savedPath.endsWith(".zip")) {
				return "unexpected name for the archive: " + basename(savedPath);
			}
			const content = readFileSync(savedPath).toString("latin1");
			if (!content.startsWith(ZIP_SIGNATURE) || !content.includes(THIRD_PAGE_ENTRY)) {
				return "the file is not the archive of the three pages";
			}
			const errorText = await session.evaluate(builderTab, ERROR_TEXT);
			return errorText ? "an error was displayed: " + JSON.stringify(errorText) : undefined;
		});

		await test("a profile with a password is refused with an error in the page, and nothing is saved", async () => {
			if (!pagesAdded) {
				return "the first pages were not stored";
			}
			await session.closeTab(await session.importSettings(PASSWORD_PROFILE));
			await openBuilder();
			await rowTitles([RENAMED_TITLE, FIRST_TITLE, THIRD_TITLE].join("\n"));
			clearDownloads(session.downloadDir);
			await session.click(builderTab, SAVE_BUTTON);
			// the error is the signal that the click was handled: checking the download
			// directory before it would pass on an extension that did nothing yet
			const errorText = await waitFor(() => session.evaluate(builderTab, ERROR_TEXT), value => Boolean(value));
			if (!errorText) {
				return "no error was displayed in the page";
			}
			if (!errorText.includes("password")) {
				return "the error does not mention the password: " + JSON.stringify(errorText);
			}
			const downloads = listDownloads(session.downloadDir);
			return downloads.length ? "a file was saved: " + JSON.stringify(downloads.map(path => basename(path))) : undefined;
		});

		await test("the remove all button empties the list", async () => {
			if (!pagesAdded) {
				return "the first pages were not stored";
			}
			await session.click(builderTab, REMOVE_ALL_BUTTON);
			let titles = await rowTitles("");
			if (titles != "") {
				return "the page still lists " + JSON.stringify(titles);
			}
			await openBuilder();
			// the rows of a page come a moment after its load
			await new Promise(resolve => setTimeout(resolve, NO_DOWNLOAD_DELAY));
			titles = await session.evaluate(builderTab, ROW_TITLES);
			return titles == "" ? undefined : "after a reload the page lists " + JSON.stringify(titles);
		});
		// The URLs are typed in the batch page, which is also where "save selected links" puts
		// the links. Each one is loaded in a tab of its own, which is closed once it is stored.
		await test("the batch page adds its URLs to the archive, in the order of its list", async () => {
			if (!pagesAdded) {
				return "the first pages were not stored";
			}
			await session.closeTab(await session.importSettings(HTML_PROFILE));
			const urls = [fixtures.titledURL(FIRST_URL_TITLE), fixtures.titledURL(SECOND_URL_TITLE)];
			const batchTab = await session.openTab(session.singlefileURL(BATCH_PAGE));
			openedTabs.push(batchTab);
			for (const url of urls) {
				await session.evaluate(batchTab, "(() => { const input = document.getElementById(\"addUrlInput\"); input.value = " + JSON.stringify(url) + "; document.getElementById(\"addUrlForm\").onsubmit(); })()");
			}
			await waitFor(() => session.evaluate(batchTab, LISTED_URLS_COUNT), value => value == String(urls.length));
			clearDownloads(session.downloadDir);
			await session.click(batchTab, ADD_TO_ARCHIVE_BUTTON);
			await openBuilder();
			const expected = [FIRST_URL_TITLE, SECOND_URL_TITLE].join("\n");
			const titles = await rowTitles(expected);
			if (titles != expected) {
				return "the page lists " + JSON.stringify(titles);
			}
			const listedCount = await session.evaluate(batchTab, LISTED_URLS_COUNT);
			if (listedCount != "0") {
				return "the batch page still lists " + listedCount + " URL(s)";
			}
			const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
			const leftOpen = contexts.filter(({ url }) => urls.includes(url));
			if (leftOpen.length) {
				return "a tab opened for a URL was left open";
			}
			const downloads = listDownloads(session.downloadDir);
			return downloads.length ? "a file was written: " + JSON.stringify(downloads.map(path => basename(path))) : undefined;
		});
		await test("the batch page has a button that opens the archive in progress", async () => {
			const batchTab = await session.openTab(session.singlefileURL(BATCH_PAGE));
			openedTabs.push(batchTab);
			const listArchivePages = async () => {
				const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
				return contexts.filter(({ url }) => url.includes(ARCHIVE_PAGE)).map(({ context }) => context);
			};
			const knownPages = await listArchivePages();
			await session.click(batchTab, VIEW_ARCHIVE_BUTTON);
			const newPages = await waitFor(async () => (await listArchivePages()).filter(context => !knownPages.includes(context)), value => Boolean(value && value.length));
			if (!newPages || !newPages.length) {
				return "the page of the archive in progress was not opened";
			}
			openedTabs.push(...newPages);
			return undefined;
		});
		// The same page is added twice, so every file of the second page is a duplicate.
		await test("with the option, the files shared by the pages are stored only once", async () => {
			await session.evaluate(builderTab, "browser.runtime.sendMessage({ method: \"archive.clear\" }).then(() => \"\")");
			await session.closeTab(await session.importSettings(ZIP_PROFILE));
			const richTab = await session.openTab(fixtures.url("rich.html"));
			openedTabs.push(richTab);
			const richTitle = await session.evaluate(richTab, "document.title");
			await openBuilder();
			for (const expected of [richTitle, [richTitle, richTitle].join("\n")]) {
				await session.activate(richTab);
				await session.dispatch("add-tab-to-archive");
				const titles = await rowTitles(expected);
				if (titles != expected) {
					return "the page lists " + JSON.stringify(titles);
				}
			}
			const saveArchive = async () => {
				await openBuilder();
				await rowTitles([richTitle, richTitle].join("\n"));
				clearDownloads(session.downloadDir);
				await session.click(builderTab, SAVE_BUTTON);
				return readFileSync(await waitForDownload(session.downloadDir)).toString("latin1");
			};
			const content = await saveArchive();
			// the option is set like a user sets it, with a click in the options page
			const optionsTab = await session.openTab(session.singlefileURL(OPTIONS_PAGE));
			openedTabs.push(optionsTab);
			await session.setViewport(optionsTab, OPTIONS_VIEWPORT.width, OPTIONS_VIEWPORT.height);
			await session.click(optionsTab, "#expandAllButton");
			await new Promise(resolve => setTimeout(resolve, OPTIONS_SETTLE_DELAY));
			await session.click(optionsTab, DEDUP_CHECKBOX);
			await new Promise(resolve => setTimeout(resolve, OPTIONS_SETTLE_DELAY));
			const dedupContent = await saveArchive();
			const targets = dedupContent.match(SYMLINK_TARGET) || [];
			if (!dedupContent.includes(SECOND_PAGE_ENTRY)) {
				return "the archive does not hold the second page";
			}
			if (content.match(SYMLINK_TARGET)) {
				return "without the option, the archive holds symbolic links";
			}
			if (!targets.length) {
				return "with the option, no file of the second page is a symbolic link";
			}
			return dedupContent.length < content.length ? undefined : "the archive is not smaller with the option (" + dedupContent.length + " bytes, " + content.length + " without)";
		});
		// The pages added by the previous test are saved twice more, with and without the options.
		await test("the table of contents, the marking of links and the transitions follow the options", async () => {
			const saveArchive = async profile => {
				await session.closeTab(await session.importSettings(profile));
				await openBuilder();
				await waitFor(() => session.evaluate(builderTab, ROW_TITLES), value => Boolean(value));
				clearDownloads(session.downloadDir);
				await session.click(builderTab, SAVE_BUTTON);
				return readFileSync(await waitForDownload(session.downloadDir));
			};
			const archive = await saveArchive(ZIP_PROFILE);
			const manifest = JSON.parse(readEntry(archive, PAGES_ENTRY));
			const problems = [];
			if (!manifest.pages || manifest.pages.length != 2) {
				problems.push("the file describing the pages lists " + JSON.stringify(manifest.pages));
			}
			if (readEntry(archive, TOC_ENTRY) === undefined) {
				problems.push("by default, the archive has no table of contents");
			}
			if (manifest.markUnarchivedLinks || manifest.pageTransitions) {
				problems.push("by default, the archive marks links or sets a transition");
			}
			const optionsArchive = await saveArchive(ARCHIVE_OPTIONS_PROFILE);
			const optionsManifest = JSON.parse(readEntry(optionsArchive, PAGES_ENTRY));
			if (readEntry(optionsArchive, TOC_ENTRY) !== undefined) {
				problems.push("with the option unchecked, the archive has a table of contents");
			}
			if (optionsManifest.markUnarchivedLinks !== true) {
				problems.push("the marking of links is not set");
			}
			if (optionsManifest.pageTransitions != FADE_TRANSITION) {
				problems.push("the transition is " + JSON.stringify(optionsManifest.pageTransitions));
			}
			return problems.length ? problems.join("; ") : undefined;
		});
		// The page of the archive in progress is a page of the extension, which SingleFile cannot
		// save: it is the tab in front when the action is dispatched. The two pages added by the
		// earlier tests are still in the list.
		await test("a tab that cannot be saved is listed as not saved, and is left out of the archive", async () => {
			await session.closeTab(await session.importSettings(ZIP_PROFILE));
			await openBuilder();
			const savedCount = Number(await waitFor(() => session.evaluate(builderTab, ROWS_COUNT), value => Number(value) > 0));
			if (!savedCount) {
				return "the list is empty, there is no saved page to tell from the failed one";
			}
			await session.dispatch("add-tab-to-archive");
			const failedURLs = await waitFor(() => session.evaluate(builderTab, FAILED_ROW_URLS), value => Boolean(value));
			if (!failedURLs || !failedURLs.includes(ARCHIVE_PAGE) || failedURLs.includes("\n")) {
				return "the rows marked as failed are " + JSON.stringify(failedURLs);
			}
			const status = await session.evaluate(builderTab, FAILED_ROW_STATUS);
			if (status != NOT_SAVED_STATUS) {
				return "the status of the failed row is " + JSON.stringify(status);
			}
			const failedLabel = await session.evaluate(builderTab, FAILED_LABEL);
			if (!failedLabel.includes("1")) {
				return "the number of failed pages is displayed as " + JSON.stringify(failedLabel);
			}
			clearDownloads(session.downloadDir);
			await session.click(builderTab, SAVE_BUTTON);
			const manifest = JSON.parse(readEntry(readFileSync(await waitForDownload(session.downloadDir)), PAGES_ENTRY));
			if (manifest.pages.length != savedCount) {
				return "the archive holds " + manifest.pages.length + " page(s), " + savedCount + " were saved";
			}
			await session.click(builderTab, FAILED_ROW_REMOVE_BUTTON);
			const rowsCount = await waitFor(() => session.evaluate(builderTab, ROWS_COUNT), value => value == String(savedCount));
			if (rowsCount != String(savedCount)) {
				return "after the removal the list holds " + rowsCount + " row(s)";
			}
			return await session.evaluate(builderTab, FAILED_LABEL) ? "the number of failed pages is still displayed" : undefined;
		});
	} finally {
		await session.evaluate(builderTab, "browser.runtime.sendMessage({ method: \"archive.clear\" }).then(() => \"\")").catch(() => { });
		await session.closeTab(await session.importSettings(HTML_PROFILE));
		for (const context of [...openedTabs, builderTab]) {
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
			const name = archive.toString("utf8", offset + CENTRAL_HEADER_LENGTH, offset + CENTRAL_HEADER_LENGTH + nameLength);
			if (name == entryName) {
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
