// Level 2 spec: "Save selection" on a page that writes text directly in the elements holding the
// selection (SingleFile#2066).
//
// SingleFile marks a selection on elements and removes the elements that are not marked. Text that
// is in no element of its own was never removed: the Lua manual writes the description of each
// function as bare text of <body>, and every selection saved from it came with all of them. The
// content script now tells which text of a partly selected element is selected.
//
// The ranges are written by a script: in the light DOM both browsers hand back a range as it was
// written, so the real pointer would add nothing here (see selection-in-shadow-root.spec.mjs for
// the case where it does).

import { waitForDownload, clearDownloads, readSavedPage } from "../expect/saved-page.mjs";

const RESPONSE_TIMEOUT = 30000;
const ALL_TEXTS = ["PARAGRAPH_SELECTED", "BARE_FIRST", "BARE_SECOND", "MIXED_BEFORE", "BOLD_SELECTED", "MIXED_AFTER", "LINK_UNSELECTED", "HEADING_SELECTED", "BARE_SELECTED", "BARE_LAST"];
const SELECTIONS = [
	["paragraph", "a selection inside a paragraph", ["PARAGRAPH_SELECTED"]],
	["bold", "a selection inside an inline element", ["BOLD_SELECTED"]],
	["bare", "a selection that ends in bare text", ["HEADING_SELECTED", "BARE_SELECTED"]]
];

export const name = "selection-bare-text";
export const level = 2;

export async function run({ session, fixtures, test }) {
	const context = await session.openTab(fixtures.url("bare-text-selection.html"));
	try {
		for (const [selectionName, label, selectedTexts] of SELECTIONS) {
			let content;

			await test(label + " is saved", async () => {
				clearDownloads(session.downloadDir);
				const selectedText = await session.evaluate(context, "window.selectFixtureRange(" + JSON.stringify(selectionName) + ")");
				if (!selectedTexts.every(text => selectedText.includes(text))) {
					return "the fixture selected " + JSON.stringify(selectedText);
				}
				await session.dispatch("save-selected-content", { expectResponse: true, responseTimeout: RESPONSE_TIMEOUT });
				content = readSavedPage(await waitForDownload(session.downloadDir));
				const missing = selectedTexts.filter(text => !content.includes(text));
				return missing.length ? "selected but not saved: " + missing.join(", ") : undefined;
			});

			await test("the text written around it in no element of its own is not saved (" + selectionName + ")", async () => {
				if (!content) {
					return "nothing was saved to inspect";
				}
				const found = ALL_TEXTS.filter(text => !selectedTexts.includes(text) && content.includes(text));
				return found.length ? "saved although not selected: " + found.join(", ") : undefined;
			});

			await test("the page is left without the marks of the selection (" + selectionName + ")", async () => {
				const marksCount = await session.evaluate(context, "window.countSelectionMarks()");
				return marksCount ? marksCount + " elements still carry a mark of the selection, the next save of a selection would use them" : undefined;
			});
		}
	} finally {
		await session.closeTab(context);
	}
}
