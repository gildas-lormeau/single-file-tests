// Level 2 spec: the option "apply the print stylesheets" saves a page the way it would be printed.
//
// The saved page is read on a screen, so the rules the site wrote for paper must apply there and
// the rules it wrote for screens only must go (SingleFile#1567). The rewriting itself is tested in
// single-file-core and what browsers display from it in single-file-cli. This spec checks the part
// that belongs to the extension: the checkbox of the options page reaches the save.
//
// The fixture hides its navigation on paper and shows a note on paper only. The checkbox is clicked
// for real and the result is read in the saved file.

import { waitForDownload, clearDownloads, readSavedPage, elementWithId } from "../expect/saved-page.mjs";

const OPTIONS_PAGE = "src/ui/pages/options.html";
const PRINT_CHECKBOX = "#applyPrintStylesheetsInput";
const FIXTURE = "print.html";
// the rule hiding the navigation on paper, once it applies to every medium; a saved page is
// compressed, so nothing separates the tokens
const NAVIGATION_HIDDEN_EVERYWHERE = /@media all\{#navigation\{display:none\}\}/;
const SCREEN_RULE = /@media[^{]*screen/;
const HIDDEN_CLASS = "sf-hidden";
// the options page is one long column of collapsed sections; a headless window is far
// too short for it, and a pointer aimed below the fold silently hits something else
const OPTIONS_VIEWPORT = { width: 1200, height: 4000 };

export const name = "print-stylesheets";
export const level = 2;

export async function run({ session, fixtures, test }) {
	// the defaults, whatever the spec before left behind
	await session.closeTab(await session.importSettings({}));
	const options = await session.openTab(session.singlefileURL(OPTIONS_PAGE));
	await session.setViewport(options, OPTIONS_VIEWPORT.width, OPTIONS_VIEWPORT.height);
	await session.click(options, "#expandAllButton");
	await settle();

	// The control: by default the page is saved for a screen. The note is not displayed there, and
	// the removal of hidden elements either takes it out of the file or keeps it hidden.
	await test("by default the page is saved with its screen layout", async () => {
		const content = await saveFixture();
		return (NAVIGATION_HIDDEN_EVERYWHERE.test(content) ? "the navigation is hidden in the saved page" : undefined)
			|| (SCREEN_RULE.test(content) ? undefined : "the rule for screens is missing from the saved page")
			|| (isDisplayable(elementWithId(content, "print-note")) ? "the note displayed on paper only is left displayable in the saved page" : undefined);
	});

	await test("with the option checked the page is saved with its print layout", async () => {
		await toggle();
		const content = await saveFixture();
		return (NAVIGATION_HIDDEN_EVERYWHERE.test(content) ? undefined : "the rule hiding the navigation on paper does not apply to every medium")
			|| (SCREEN_RULE.test(content) ? "a rule for screens is left in the saved page" : undefined)
			|| (isDisplayable(elementWithId(content, "print-note")) ? undefined : "the note displayed on paper was removed or hidden as a hidden element")
			|| (elementWithId(content, "article") ? undefined : "the article is missing");
	});

	await test("unchecking the option gives the screen layout back", async () => {
		await toggle();
		const content = await saveFixture();
		return NAVIGATION_HIDDEN_EVERYWHERE.test(content) ? "the navigation is still hidden in the saved page" : undefined;
	});

	await session.closeTab(options);

	// a real click on the real control; the options page persists on change
	async function toggle() {
		await session.click(options, PRINT_CHECKBOX);
		await settle();
	}

	async function saveFixture() {
		clearDownloads(session.downloadDir);
		const context = await session.openTab(fixtures.url(FIXTURE));
		await session.dispatch("save-page");
		const content = readSavedPage(await waitForDownload(session.downloadDir));
		await session.closeTab(context);
		return content;
	}
}

// an element the removal of hidden elements keeps is given this class, which hides it
function isDisplayable(element) {
	return Boolean(element) && !element.includes(HIDDEN_CLASS);
}

// the change handler of the options page writes to storage asynchronously
function settle() {
	return new Promise(resolve => setTimeout(resolve, 750));
}
