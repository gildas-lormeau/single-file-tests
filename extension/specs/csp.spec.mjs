// Level 1 spec: saving a page that is served under a restrictive Content-Security-Policy.
//
// This is a recurring failure class rather than a hypothetical. SingleFile's page-world
// hooks were silently blocked by CSP for a long stretch of releases, and #199 was the
// same shape again under Trusted Types. Both were reported as "the save is incomplete"
// rather than as an error, which is exactly what a functional check catches and a unit
// test does not: the extension keeps working, the page it produces is just missing things.
//
// The fixture server applies whatever policy the query string asks for, so one page can
// be saved under several policies without a fixture per policy.

import { waitForDownload, clearDownloads, readSavedPage, expectSelfContained, includesDeclaration, elementWithId } from "../expect/saved-page.mjs";

const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const FRAME_MARKER = "IFRAME_CONTENT_MARKER";
const DATA_IMAGE = /data:image\/(png|svg\+xml);base64,/;
const NO_SCRIPTS = "script-src 'none'";
const TRUSTED_TYPES = "require-trusted-types-for 'script'; script-src 'self' 'unsafe-inline'";

export const name = "csp";
export const level = 1;

export async function run({ session, fixtures, test }) {
	await test("a page that forbids scripts still saves completely", async () => {
		const content = await saveUnder(session, fixtures, "simple.html", NO_SCRIPTS);
		const problems = expectSelfContained(content, { markerText: MARKER_TEXT });
		if (!includesDeclaration(content, "color: rgb(17, 85, 204)")) {
			problems.push("the external stylesheet was not inlined");
		}
		return problems.join("; ") || undefined;
	});

	await test("a page requiring trusted types still saves completely", async () => {
		const content = await saveUnder(session, fixtures, "simple.html", TRUSTED_TYPES);
		const problems = expectSelfContained(content, { markerText: MARKER_TEXT });
		if (!includesDeclaration(content, "color: rgb(17, 85, 204)")) {
			problems.push("the external stylesheet was not inlined");
		}
		return problems.join("; ") || undefined;
	});

	await test("frames and images survive a page that forbids scripts", async () => {
		// the rich fixture's own script cannot run under this policy, so the canvas and the
		// shadow root are legitimately absent; everything the markup describes must not be
		const content = await saveUnder(session, fixtures, "rich.html", NO_SCRIPTS);
		const problems = [];
		if (!content.includes(FRAME_MARKER)) {
			problems.push("the frame's content is missing");
		}
		if (!includesDeclaration(content, "color: rgb(200, 30, 90)")) {
			problems.push("the @import-ed stylesheet was not followed");
		}
		const logo = elementWithId(content, "logo");
		if (!logo || !DATA_IMAGE.test(logo)) {
			problems.push("the image was not embedded");
		}
		return problems.join("; ") || undefined;
	});
}

async function saveUnder(session, fixtures, page, policy) {
	clearDownloads(session.downloadDir);
	await session.openTab(fixtures.url(page) + "?csp=" + encodeURIComponent(policy));
	await session.dispatch("save-page");
	return readSavedPage(await waitForDownload(session.downloadDir));
}
