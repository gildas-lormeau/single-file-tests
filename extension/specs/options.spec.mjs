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
const BLOCK_IMAGES_CHECKBOX = "#blockImagesInput";
const LINK_BLOCKED_IMAGES_CHECKBOX = "#linkBlockedImagesInput";
const REMOTE_IMAGES_POLICY = /img-src [^;]*http: https:;/;
const LOGO_SOURCE = /<img[^>]*id="?logo"?[^>]*src="?([^" >]*)/;
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

	// The option that keeps the address of a blocked image only means something once images are
	// blocked, so its checkbox sits under "images" and is disabled until that one is checked. This
	// test does read the state of the page: a click on an enabled checkbox with images not blocked
	// would save the very same file, embedded images and a closed policy.
	await test("the link option is disabled while images are not blocked, and a click on it changes nothing", async () => {
		const disabledBefore = await session.evaluate(options, "document.querySelector(\"" + LINK_BLOCKED_IMAGES_CHECKBOX + "\").disabled");
		await toggle(session, options, LINK_BLOCKED_IMAGES_CHECKBOX);
		const checkedAfter = await session.evaluate(options, "document.querySelector(\"" + LINK_BLOCKED_IMAGES_CHECKBOX + "\").checked");
		const content = await saveFixture(session, fixtures, "rich.html");
		const problems = [];
		if (!disabledBefore) {
			problems.push("the checkbox is enabled with images not blocked");
		}
		if (checkedAfter) {
			problems.push("the click checked it");
		}
		if (!logoSource(content).startsWith("data:image/")) {
			problems.push("the logo is not embedded: " + logoSource(content).slice(0, 80));
		}
		if (REMOTE_IMAGES_POLICY.test(content)) {
			problems.push("the policy of the saved page lets remote images through");
		}
		return problems.join("; ") || undefined;
	});

	await test("blocking images alone saves the page with empty images", async () => {
		await toggle(session, options, BLOCK_IMAGES_CHECKBOX);
		const content = await saveFixture(session, fixtures, "rich.html");
		const problems = [];
		if (logoSource(content) != "data:,") {
			problems.push("the logo is not emptied: " + logoSource(content).slice(0, 80));
		}
		if (REMOTE_IMAGES_POLICY.test(content)) {
			problems.push("the policy of the saved page lets remote images through");
		}
		return problems.join("; ") || undefined;
	});

	await test("with the link option, the saved page keeps the addresses of its images and its policy lets them through", async () => {
		const enabled = !(await session.evaluate(options, "document.querySelector(\"" + LINK_BLOCKED_IMAGES_CHECKBOX + "\").disabled"));
		await toggle(session, options, LINK_BLOCKED_IMAGES_CHECKBOX);
		const content = await saveFixture(session, fixtures, "rich.html");
		const expectedLogo = fixtures.url("logo.svg");
		const problems = [];
		if (!enabled) {
			problems.push("the checkbox stayed disabled once images were blocked");
		}
		if (logoSource(content) != expectedLogo) {
			problems.push("the logo is " + logoSource(content).slice(0, 80) + ", expected " + expectedLogo);
		}
		if (content.includes("data:image/png")) {
			problems.push("an image is still embedded");
		}
		if (!REMOTE_IMAGES_POLICY.test(content)) {
			problems.push("the policy of the saved page does not let remote images through");
		}
		return problems.join("; ") || undefined;
	});

	await test("unchecking both puts the embedded images back", async () => {
		await toggle(session, options, LINK_BLOCKED_IMAGES_CHECKBOX);
		await toggle(session, options, BLOCK_IMAGES_CHECKBOX);
		const content = await saveFixture(session, fixtures, "rich.html");
		const problems = [];
		if (!logoSource(content).startsWith("data:image/")) {
			problems.push("the logo is not embedded: " + logoSource(content).slice(0, 80));
		}
		if (REMOTE_IMAGES_POLICY.test(content)) {
			problems.push("the policy of the saved page still lets remote images through");
		}
		return problems.join("; ") || undefined;
	});
}

function logoSource(content) {
	const match = content.match(LOGO_SOURCE);
	return match ? match[1] : "";
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

async function saveFixture(session, fixtures, pageName = "simple.html") {
	clearDownloads(session.downloadDir);
	await session.openTab(fixtures.url(pageName));
	await session.dispatch("save-page");
	return readSavedPage(await waitForDownload(session.downloadDir));
}

function settle() {
	return new Promise(resolve => setTimeout(resolve, 750));
}
