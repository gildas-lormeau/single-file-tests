// Level 1 spec: with the option "do not include the saved date" (removeSavedDate), a page saved
// as a ZIP file does not record when it was saved, so two saves of the same page give the same
// file (SingleFile#1918). The dates were the modification date of every entry of the ZIP file and
// the `archiveTime` value of manifest.json.
//
// The extension passes its options to the archive writer one by one: an option missing from that
// list does nothing, and only a real save shows it. The check is the file on disk, compared byte
// for byte with the file of a second save. `archiveTime` is written in milliseconds, so the two
// files differ without the option however close the two saves are, which the last test shows.

import { readFileSync } from "node:fs";
import { waitForDownload, clearDownloads } from "../expect/saved-page.mjs";

const PAGE = "simple.html";
const FIRST_TITLE = "Undated first tab";
const SECOND_TITLE = "Undated second tab";
const DATED = { removeSavedDate: false };
const UNDATED = { removeSavedDate: true };
const ZIP_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false, password: "" };
const SELF_EXTRACTING_PROFILE = { compressContent: true, selfExtractingArchive: true, extractDataFromPage: true, password: "" };
const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false, password: "", removeSavedDate: false };
const SAVED_PAGE_SCHEMES = ["http://", "file://"];

export const name = "undated-archive";
export const level = 1;

export async function run({ session, fixtures, test }) {
	const pageTab = await session.openTab(fixtures.url(PAGE));
	try {
		await test("a ZIP file saved twice without the saved date is the same file", async () => {
			await session.closeTab(await session.importSettings({ ...ZIP_PROFILE, ...UNDATED }));
			return compareSaves(session, pageTab, "save-page", true);
		});

		await test("a self-extracting file saved twice without the saved date is the same file", async () => {
			await session.closeTab(await session.importSettings({ ...SELF_EXTRACTING_PROFILE, ...UNDATED }));
			return compareSaves(session, pageTab, "save-page", true);
		});

		// the archive of several tabs is written by another function, with its own list of options
		await test("an archive of two tabs saved twice without the saved date is the same file", async () => {
			await session.closeTab(await session.importSettings({ ...ZIP_PROFILE, ...UNDATED }));
			await session.closeTab(pageTab);
			const firstTab = await session.openTab(fixtures.titledURL(FIRST_TITLE));
			await closeOtherPages(session, [firstTab]);
			const secondTab = await session.openTab(fixtures.titledURL(SECOND_TITLE));
			try {
				return await compareSaves(session, secondTab, "save-all-tabs-in-archive", true);
			} finally {
				await session.closeTab(secondTab);
				await session.closeTab(firstTab);
			}
		});

		// the control: with the saved date, two saves never give the same file
		await test("a ZIP file saved twice with the saved date differs", async () => {
			await session.closeTab(await session.importSettings({ ...ZIP_PROFILE, ...DATED }));
			const controlTab = await session.openTab(fixtures.url(PAGE));
			try {
				return await compareSaves(session, controlTab, "save-page", false);
			} finally {
				await session.closeTab(controlTab);
			}
		});
	} finally {
		await session.closeTab(await session.importSettings(HTML_PROFILE));
	}
}

async function compareSaves(session, context, action, expectSame) {
	const first = await save(session, context, action);
	const second = await save(session, context, action);
	const same = first.equals(second);
	if (same == expectSame) {
		return undefined;
	}
	return expectSame ?
		"the two files differ, sizes " + first.length + " and " + second.length + ", first difference at byte " + first.findIndex((value, index) => value != second[index]) :
		"the two files are the same";
}

async function save(session, context, action) {
	await session.activate(context);
	clearDownloads(session.downloadDir);
	await session.dispatch(action);
	return readFileSync(await waitForDownload(session.downloadDir));
}

// Close the pages the earlier specs left open, which SingleFile would add to the archive.
async function closeOtherPages(session, keptContexts) {
	const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
	for (const { context, url } of contexts) {
		if (!keptContexts.includes(context) && SAVED_PAGE_SCHEMES.some(scheme => url.startsWith(scheme))) {
			await session.closeTab(context);
		}
	}
}
