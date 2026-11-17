// Level 2 spec: a selection made with the mouse inside a shadow root, saved with "Save selection".
//
// It needs the real pointer because the two browsers disagree on what a script may then read.
// Firefox hands the range as it is, inside the shadow root. Chromium hides it: the classic selection
// API answers with a collapsed range on the parent of the host, and only getComposedRanges(), given
// the shadow root, tells where the selection is. A range written by a script would be handed back
// as written in both, and would test neither.
//
// Before the fix the two failed differently. In Firefox the selected paragraph was marked and none
// of its ancestors above the shadow root were, so everything was pruned and the saved page was
// empty. In Chromium no selection was found at all, and the area picker opened instead of the save.

import { waitForDownload, clearDownloads, readSavedPage } from "../expect/saved-page.mjs";

const RESPONSE_TIMEOUT = 30000;
const VIEWPORT = { width: 1000, height: 700 };
const DRAG_STEP_DURATION = 100;
const SELECTED_TEXT = "SHADOW_SELECTED";
const UNSELECTED_TEXTS = ["LIGHT_BEFORE", "LIGHT_AFTER", "SHADOW_FIRST", "SHADOW_LAST", "SLOTTED", "OUTER_FIRST", "OUTER_LAST"];
const SHADOW_DECLARATION = /color:\s*rgb\(0,\s*128,\s*0\)/;
const MODES = [
	["open", "an open shadow root"],
	["closed", "a closed shadow root"],
	["nested", "a shadow root inside another one"]
];

export const name = "selection-in-shadow-root";
export const level = 2;

export async function run({ session, fixtures, test }) {
	for (const [mode, label] of MODES) {
		let context, content;

		await test("a selection made in " + label + " is saved", async () => {
			clearDownloads(session.downloadDir);
			context = await session.openTab(fixtures.url("shadow-selection.html?mode=" + mode));
			await session.setViewport(context, VIEWPORT.width, VIEWPORT.height);
			const selectedText = await selectTarget(session, context);
			if (!selectedText.includes(SELECTED_TEXT)) {
				return "the drag selected " + JSON.stringify(selectedText) + " instead of the paragraph";
			}
			await session.dispatch("save-selected-content", { expectResponse: true, responseTimeout: RESPONSE_TIMEOUT });
			content = readSavedPage(await waitForDownload(session.downloadDir));
			return content.includes(SELECTED_TEXT) ? undefined : "the selected paragraph is not in the saved page";
		});

		await test("nothing else of the page is saved with it (" + mode + ")", async () => {
			if (!content) {
				return "nothing was saved to inspect";
			}
			const found = UNSELECTED_TEXTS.filter(text => content.includes(text));
			return found.length ? "saved although not selected: " + found.join(", ") : undefined;
		});

		await test("the stylesheet of the shadow root is saved with it (" + mode + ")", async () => {
			if (!content) {
				return "nothing was saved to inspect";
			}
			return SHADOW_DECLARATION.test(content) ? undefined : "the rule colouring the paragraph is not in the saved page";
		});

		await test("the page is left without the marks of the selection (" + mode + ")", async () => {
			if (!context) {
				return "no page was opened";
			}
			const marksCount = await session.evaluate(context, "window.countSelectionMarks()");
			return marksCount ? marksCount + " elements still carry the selection mark, the next save of a selection would include them" : undefined;
		});
	}
}

// Drags across the paragraph the fixture exposes, and returns what the page then reports as
// selected. toString() tells the text in both browsers, whatever the ranges say.
async function selectTarget(session, context) {
	const rect = JSON.parse(await session.evaluate(context, "JSON.stringify(window.targetElement.getBoundingClientRect())"));
	const left = Math.round(rect.left) + 1;
	const y = Math.round(rect.top + rect.height / 2);
	await session.session.send("input.performActions", {
		context,
		actions: [{
			type: "pointer",
			id: "mouse",
			parameters: { pointerType: "mouse" },
			actions: [
				{ type: "pointerMove", x: left, y },
				{ type: "pointerDown", button: 0 },
				{ type: "pointerMove", x: left + Math.round(rect.width / 4), y, duration: DRAG_STEP_DURATION },
				{ type: "pointerMove", x: left + Math.round(rect.width / 2), y, duration: DRAG_STEP_DURATION },
				{ type: "pointerUp", button: 0 }
			]
		}]
	});
	return session.evaluate(context, "getSelection().toString()");
}
