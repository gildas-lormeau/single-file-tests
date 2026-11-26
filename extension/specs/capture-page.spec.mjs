// Level 2 spec: capture-page is the one external message that returns data, and the only
// one gated by a permission prompt. Both matter — the prompt is a security boundary, and
// the return path is otherwise untested.
//
// The prompt is driven by clicking the real Approve button on the real options page.
// Everything asserted afterwards comes from the value SingleFile handed back.

const CAPTURE_TIMEOUT = 60000;
const PROMPT_MARKER = "externalCaptureRequestId";
const OPTIONS_VIEWPORT = { width: 1200, height: 4000 };
const SFZ_PRELUDE = /<html data-sfz>/;
const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const FOCUSED_FIELD_TEXTS = ["TEXT_BEFORE_FIELD", "FIELD_LABEL", "TEXT_AFTER_FIELD"];

export const name = "capture-page";
export const level = 2;

export async function run({ session, fixtures, test }) {
	await test("an unapproved caller is asked for permission", async () => {
		await session.openTab(fixtures.url("simple.html"));
		// The call blocks until someone answers the prompt, so do not await it yet
		const capturing = capture(session, {});
		const promptContext = await waitForPrompt(session);
		if (!promptContext) {
			return "no approval prompt appeared for an unknown caller";
		}
		await session.setViewport(promptContext, OPTIONS_VIEWPORT.width, OPTIONS_VIEWPORT.height);
		await session.click(promptContext, "#externalCaptureApproveButton");
		// Approving leaves the options page as the active tab. The capture that raised the
		// prompt must still return the page the caller asked about, not the prompt.
		const captured = await capturing.catch(error => ({ error: error.message }));
		// the prompt tab stays open on approval, and a stale one would look like a new
		// prompt to the test below
		await session.closeTab(promptContext);
		if (!captured || !String(captured.content).includes(MARKER_TEXT)) {
			return "the capture that raised the prompt did not return the fixture page: " + JSON.stringify(captured).slice(0, 200);
		}
		return undefined;
	});

	await test("an approved caller gets the captured page back", async () => {
		const captured = await captureFixture(session, fixtures, {});
		if (!captured || typeof captured != "object") {
			return "capture-page returned " + JSON.stringify(captured);
		}
		const missing = ["title", "filename", "mimeType", "content"].filter(key => captured[key] === undefined);
		if (missing.length) {
			return "the captured page is missing " + missing.join(", ");
		}
		if (!String(captured.content).includes(MARKER_TEXT)) {
			return "the captured content is not the fixture page";
		}
		return captured.mimeType == "text/html" ? undefined : "unexpected mimeType " + captured.mimeType;
	});

	await test("approving once is enough, the prompt does not come back", async () => {
		await session.openTab(fixtures.url("simple.html"));
		const capturing = capture(session, {});
		const promptContext = await waitForPrompt(session, { timeout: 4000 });
		const captured = await capturing.catch(error => ({ error: error.message }));
		if (promptContext) {
			return "a second prompt appeared for an already approved caller";
		}
		return captured && captured.content ? undefined : "the repeat capture returned nothing";
	});

	await test("config cannot choose the save format, only the content", async () => {
		// removeSavedDate is on the capture whitelist; selfExtractingArchive is deliberately
		// not, so an external caller must not be able to turn the result into an archive
		const captured = await captureFixture(session, fixtures, {
			removeSavedDate: true,
			selfExtractingArchive: true,
			compressContent: true
		});
		const content = String(captured && captured.content);
		const problems = [];
		if (SFZ_PRELUDE.test(content)) {
			problems.push("an external caller forced a self-extracting archive");
		}
		if (content.includes("saved date:")) {
			problems.push("removeSavedDate was ignored, so the whitelist let nothing through");
		}
		return problems.join("; ") || undefined;
	});

	await test("a focused text field is not taken for a selection", async () => {
		// optionallySelected is what the shortcut Ctrl+Shift+Y asks for: the selection if there is
		// one, the page otherwise. With the focus in a text field nothing is selected, but Chromium
		// reports a range around the field, and only the field was saved (SingleFile#2078).
		const captured = await captureFixture(session, fixtures, { optionallySelected: true }, "focused-field.html");
		const content = String(captured && captured.content);
		const missing = FOCUSED_FIELD_TEXTS.filter(text => !content.includes(text));
		return missing.length ? "missing from the page captured with the focus in a text field: " + missing.join(", ") : undefined;
	});
}

function capture(session, config, responseTimeout = CAPTURE_TIMEOUT) {
	return session.dispatch({ method: "capture-page", config },
		{ expectResponse: true, responseTimeout });
}

// capture-page acts on the active tab, and opening the fixture makes it active again —
// which matters because the approval page from the first test is still open
async function captureFixture(session, fixtures, config, page = "simple.html") {
	await session.openTab(fixtures.url(page));
	return capture(session, config);
}

async function waitForPrompt(session, { timeout = 15000 } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const { contexts } = await session.session.send("browsingContext.getTree", {});
		const found = contexts.find(node => node.url && node.url.includes(PROMPT_MARKER));
		if (found) {
			return found.context;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}
