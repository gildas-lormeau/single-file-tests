// Level 2 spec: the infobar of a saved page viewed in a browser where SingleFile is installed.
//
// Two options are involved. "include the infobar in the saved page" writes the infobar in the
// file, so that it shows for people who do not have SingleFile. "display an infobar when viewing
// a saved page" is the choice of the person viewing: with it unchecked, SingleFile adds no
// infobar to the saved pages it recognizes. An infobar written in the file used to show anyway,
// since nothing removed it (SingleFile issue 584): the viewing option must win.
//
// The saved file is served over http by a stub, the way a saved page published on a site is:
// the content scripts of an extension do not run on file:// pages in Chromium unless the user
// allows it. Level 2 because the options are set through the Import feature of the options page.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { waitForDownload, clearDownloads } from "../expect/saved-page.mjs";

const INFOBAR_TAGNAME = "single-file-infobar";
const INFOBAR_PRESENT = "Boolean(document.querySelector(" + JSON.stringify(INFOBAR_TAGNAME) + "))";
const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const MARKER_PRESENT = "document.body.textContent.includes(" + JSON.stringify(MARKER_TEXT) + ")";
const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false };
const ARCHIVE_PROFILE = { compressContent: true, selfExtractingArchive: true, extractDataFromPage: true };
const DEFAULT_PROFILE = { displayInfobar: true, includeInfobar: false, ...HTML_PROFILE };
const WAIT_TIMEOUT = 15000;
const POLL_DELAY = 200;

export const name = "infobar-display";
export const level = 2;

export async function run({ session, fixtures, test }) {
	const site = await startSite();
	const openedTabs = [];
	try {
		// The control: this is how the test knows SingleFile recognizes a saved page served by the
		// stub. Without it, an infobar that is absent below could mean a script that never ran.
		await test("SingleFile adds an infobar to a saved page that has none", async () => {
			const view = await saveAndView(session, fixtures, site, openedTabs, { displayInfobar: true, includeInfobar: false, ...HTML_PROFILE });
			if (view.failure) {
				return view.failure;
			}
			if (view.included) {
				return "the infobar is in the file although it was not asked for";
			}
			return await waitFor(() => session.evaluate(view.tab, INFOBAR_PRESENT), true) ? undefined : "no infobar was added to the saved page";
		});

		await test("an infobar included in the file is displayed when the viewing option is checked", async () => {
			const view = await saveAndView(session, fixtures, site, openedTabs, { displayInfobar: true, includeInfobar: true });
			if (view.failure) {
				return view.failure;
			}
			if (!view.included) {
				return "the infobar is not in the file";
			}
			return await waitFor(() => session.evaluate(view.tab, INFOBAR_PRESENT), true) ? undefined : "the infobar of the file is not displayed";
		});

		await test("an infobar included in the file is removed when the viewing option is unchecked", async () => {
			const view = await saveAndView(session, fixtures, site, openedTabs, { displayInfobar: false, includeInfobar: true });
			if (view.failure) {
				return view.failure;
			}
			// without it in the file there is nothing to remove, and the test would pass for nothing
			if (!view.included) {
				return "the infobar is not in the file";
			}
			return await waitFor(() => session.evaluate(view.tab, INFOBAR_PRESENT), false) ? undefined : "the infobar of the file is still displayed";
		});

		// A self-extracting archive rebuilds its page once loaded, and the infobar comes with it.
		// The file is compressed, so the test cannot read in it that the infobar is there: this
		// case was run against the extension without the fix, where it fails with the infobar
		// displayed.
		await test("the infobar of a self-extracting archive is removed too", async () => {
			const view = await saveAndView(session, fixtures, site, openedTabs, { displayInfobar: false, includeInfobar: true, ...ARCHIVE_PROFILE });
			if (view.failure) {
				return view.failure;
			}
			return await waitFor(() => session.evaluate(view.tab, INFOBAR_PRESENT), false) ? undefined : "the infobar of the archive is still displayed";
		});
	} finally {
		for (const context of openedTabs) {
			await session.closeTab(context);
		}
		await session.closeTab(await session.importSettings(DEFAULT_PROFILE));
		site.close();
	}
}

async function saveAndView(session, fixtures, site, openedTabs, profile) {
	await session.closeTab(await session.importSettings(profile));
	clearDownloads(session.downloadDir);
	openedTabs.push(await session.openTab(fixtures.url("simple.html")));
	await session.dispatch("save-page");
	const content = readFileSync(await waitForDownload(session.downloadDir));
	site.page = content;
	const tab = await session.openTab(site.url + "?" + Date.now());
	openedTabs.push(tab);
	if (!await waitFor(() => session.evaluate(tab, MARKER_PRESENT), true)) {
		return { failure: "the saved page was not displayed" };
	}
	return { tab, included: content.toString("latin1").includes("<" + INFOBAR_TAGNAME) };
}

// resolves to true once the value is the expected one, to false if it never is
async function waitFor(getValue, expected) {
	const deadline = Date.now() + WAIT_TIMEOUT;
	let value = await getValue();
	while (value !== expected && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, POLL_DELAY));
		value = await getValue();
	}
	return value === expected;
}

function startSite() {
	const site = { page: "" };
	const server = createServer((request, response) =>
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(site.page));
	return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
		site.url = "http://127.0.0.1:" + server.address().port + "/saved.html";
		site.close = () => server.close();
		resolve(site);
	}));
}
