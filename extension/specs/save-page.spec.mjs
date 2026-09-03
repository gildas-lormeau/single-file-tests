// Level 1 spec: nothing is injected into SingleFile. The relay extension asks it to
// save through the same public action string the "Save page" menu item uses, and the
// only thing inspected afterwards is the file on disk.
//
// One save, several assertions: re-saving the same page per assertion only re-measures
// the same artifact and costs a real capture each time.

import { waitForDownload, clearDownloads, readSavedPage, expectSelfContained, includesDeclaration } from "../expect/saved-page.mjs";

const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const RESPONSE_TIMEOUT = 30000;

export const name = "save-page";
export const level = 1;

export async function run({ session, fixtures, test }) {
	let savedPath;
	let content;
	let response;

	await test("save-page writes an .html file to the download directory", async () => {
		clearDownloads(session.downloadDir);
		await session.openTab(fixtures.url("simple.html"));
		// save-page returns nothing, but the caller must still be answered: on Chromium a
		// listener that promises a reply and never sends one leaves the caller waiting
		response = await session.dispatch("save-page", { expectResponse: true, responseTimeout: RESPONSE_TIMEOUT });
		savedPath = await waitForDownload(session.downloadDir);
		content = readSavedPage(savedPath);
		return savedPath.endsWith(".html") ? undefined : "saved file is not an .html page: " + savedPath;
	});

	await test("the caller is answered once the save is dispatched", async () => {
		return response && response.noResponse
			? "no answer within " + RESPONSE_TIMEOUT + "ms: " + response.detail
			: undefined;
	});

	await test("the saved page is self-contained", async () => {
		if (!content) {
			return "nothing was saved to inspect";
		}
		const problems = expectSelfContained(content, { markerText: MARKER_TEXT });
		return problems.length ? problems.join("; ") : undefined;
	});

	await test("the saved page inlines the external stylesheet", async () => {
		if (!content) {
			return "nothing was saved to inspect";
		}
		return includesDeclaration(content, "color: rgb(17, 85, 204)")
			? undefined
			: "the external stylesheet rule is not present in the saved page";
	});
}
