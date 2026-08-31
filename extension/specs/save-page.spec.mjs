// Level 1 spec: nothing is injected into SingleFile. The relay extension asks it to
// save through the same public action string the "Save page" menu item uses, and the
// only thing inspected afterwards is the file on disk.
//
// One save, several assertions: re-saving the same page per assertion only re-measures
// the same artifact and costs a real capture each time.

import { waitForDownload, clearDownloads, readSavedPage, expectSelfContained, includesDeclaration } from "../expect/saved-page.mjs";

const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";

export const name = "save-page";
export const level = 1;

export async function run({ session, fixtures, test }) {
	let savedPath;
	let content;

	await test("save-page writes an .html file to the download directory", async () => {
		clearDownloads(session.downloadDir);
		await session.openTab(fixtures.url("simple.html"));
		await session.dispatch("save-page");
		savedPath = await waitForDownload(session.downloadDir);
		content = readSavedPage(savedPath);
		return savedPath.endsWith(".html") ? undefined : "saved file is not an .html page: " + savedPath;
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
