// Level 1 spec: with the option "zoom out the page during the capture"
// (loadDeferredContentKeepZoomLevel), the content a page reveals on scroll is revealed in the saved
// page (SingleFile#2085).
//
// SingleFile zooms the page out so that the whole document fits in the window, and the scripts of
// the page then find every block inside the viewport. This holds only while `getBoundingClientRect`
// returns the rectangles of the zoomed out page. SingleFile 1.37.0 made it return the rectangles of
// the page at its real size, to fix the height of a list of comments (SingleFile#1919): the blocks
// below the first screen were then never revealed, and were saved hidden.
//
// The fixture marks a block with an attribute once its rectangle is inside the viewport. The first
// block is on the first screen and is the control: it is revealed whatever the option. The last
// block is five screens below, and the page is never scrolled.

import { readFileSync } from "node:fs";
import { waitForDownload, clearDownloads, elementWithId } from "../expect/saved-page.mjs";

const PAGE = "zoom-out-reveal.html";
const FIRST_BLOCK_ID = "first";
const LAST_BLOCK_ID = "last";
const REVEALED_ATTRIBUTE = /\sdata-revealed=["']?yes/;
const ZOOM_OUT = { loadDeferredContent: true, loadDeferredContentKeepZoomLevel: true };
const NO_ZOOM_OUT = { loadDeferredContent: true, loadDeferredContentKeepZoomLevel: false };

export const name = "zoom-out";
export const level = 1;

export async function run({ session, fixtures, test }) {
	try {
		await test("a block below the first screen is revealed in the page saved zoomed out", async () => {
			await session.closeTab(await session.importSettings(ZOOM_OUT));
			const content = await save(session, fixtures);
			if (!isRevealed(content, FIRST_BLOCK_ID)) {
				return "the block of the first screen was not revealed: the script of the fixture did not run";
			}
			if (!isRevealed(content, LAST_BLOCK_ID)) {
				return "the last block was not revealed";
			}
			return undefined;
		});
	} finally {
		await session.closeTab(await session.importSettings(NO_ZOOM_OUT));
	}
}

async function save(session, fixtures) {
	const context = await session.openTab(fixtures.url(PAGE));
	try {
		await session.activate(context);
		clearDownloads(session.downloadDir);
		await session.dispatch("save-page");
		return readFileSync(await waitForDownload(session.downloadDir), "utf8");
	} finally {
		await session.closeTab(context);
	}
}

function isRevealed(content, id) {
	const element = elementWithId(content, id);
	return Boolean(element) && REVEALED_ATTRIBUTE.test(element);
}
