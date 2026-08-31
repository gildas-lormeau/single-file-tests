// Level 2 spec: the options page is driven with real pointer input, and the effect is
// verified the only way that proves anything — by saving a page afterwards and reading
// the file. Nothing inspects the options page's own state.
//
// The profile is fresh for every session, so the defaults are known: insertMetaCSP is
// true and removeSavedDate is false. Every test restores what it changed, so the specs
// stay order-independent.

import { waitForDownload, clearDownloads, readSavedPage } from "../expect/saved-page.mjs";

const OPTIONS_PAGE = "src/ui/pages/options.html";
const CSP_META = "content-security-policy";
const SAVED_DATE = "saved date:";
const INSERT_CSP_CHECKBOX = "#insertMetaCSPInput";
const REMOVE_SAVED_DATE_CHECKBOX = "#removeInfobarSavedDateInput";
// the options page is one long column of collapsed sections; a headless window is far
// too short for it, and a pointer aimed below the fold silently hits something else
const OPTIONS_VIEWPORT = { width: 1200, height: 4000 };

export const name = "options";
export const level = 2;

export async function run({ session, fixtures, test }) {
	const options = await openOptionsPage(session);

	await test("a save carries the CSP meta and the saved date by default", async () => {
		const content = await saveFixture(session, fixtures);
		const problems = [];
		if (!content.includes(CSP_META)) {
			problems.push("no CSP meta in the default save");
		}
		if (!content.includes(SAVED_DATE)) {
			problems.push("no saved date in the default save");
		}
		return problems.join("; ") || undefined;
	});

	await test("unchecking the CSP option removes the meta from the saved page", async () => {
		await toggle(session, options, INSERT_CSP_CHECKBOX);
		const content = await saveFixture(session, fixtures);
		return content.includes(CSP_META) ? "the CSP meta is still present after unchecking the option" : undefined;
	});

	await test("re-checking the CSP option puts the meta back", async () => {
		await toggle(session, options, INSERT_CSP_CHECKBOX);
		const content = await saveFixture(session, fixtures);
		return content.includes(CSP_META) ? undefined : "the CSP meta did not come back after re-checking";
	});

	await test("checking the remove-saved-date option drops the date from the saved page", async () => {
		await toggle(session, options, REMOVE_SAVED_DATE_CHECKBOX);
		const content = await saveFixture(session, fixtures);
		const stillThere = content.includes(SAVED_DATE);
		await toggle(session, options, REMOVE_SAVED_DATE_CHECKBOX);
		return stillThere ? "the saved date survived the option" : undefined;
	});
}

// open the page once and expand its sections, the way a user reaching a buried option does
async function openOptionsPage(session) {
	const context = await session.openTab(session.singlefileURL(OPTIONS_PAGE));
	await session.setViewport(context, OPTIONS_VIEWPORT.width, OPTIONS_VIEWPORT.height);
	await session.click(context, "#expandAllButton");
	await settle();
	return context;
}

// a real click on the real control; the options page persists on change
async function toggle(session, context, selector) {
	await session.click(context, selector);
	// the change handler writes to storage asynchronously
	await settle();
}

async function saveFixture(session, fixtures) {
	clearDownloads(session.downloadDir);
	await session.openTab(fixtures.url("simple.html"));
	await session.dispatch("save-page");
	return readSavedPage(await waitForDownload(session.downloadDir));
}

function settle() {
	return new Promise(resolve => setTimeout(resolve, 750));
}
