// Level 2 spec: the half of the permission prompt that says no.
//
// capture-page.spec.mjs covers approval. Refusal is the side with the security contract
// and the documented error, and it is the side an extension author actually has to
// handle, so it is worth its own spec.
//
// This runs after capture-page.spec.mjs and starts by clearing both permission lists,
// because a decision is sticky by design and that spec has already approved this caller.
// It clears them again at the end, so neither spec depends on the order of the other.

import { waitForDownload, clearDownloads, readSavedPage } from "../expect/saved-page.mjs";

const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const PROMPT_MARKER = "externalCaptureRequestId";
const OPTIONS_VIEWPORT = { width: 1200, height: 4000 };
const REFUSAL_MESSAGE = "SingleFile capture was not approved for this extension";
// Until the polyfill grew a catch, Chromium answered a refusal by never answering at all,
// so this bounded what was otherwise a wait for the channel to be torn down. Keep it: it
// is the assertion that the caller is answered promptly rather than eventually.
const REFUSAL_TIMEOUT = 5000;

export const name = "capture-refused";
export const level = 2;

export async function run({ session, fixtures, test }) {
	await session.resetCapturePermissions();

	await test("refusing the prompt tells the caller why", async () => {
		await session.openTab(fixtures.url("simple.html"));
		const capturing = outcomeOf(capture(session));
		const promptContext = await waitForPrompt(session);
		if (!promptContext) {
			return "no approval prompt appeared for an unknown caller";
		}
		await session.setViewport(promptContext, OPTIONS_VIEWPORT.width, OPTIONS_VIEWPORT.height);
		await session.click(promptContext, "#externalCaptureDenyButton");
		const outcome = await capturing;
		await session.closeTab(promptContext);
		return describeRefusal(outcome);
	});

	await test("a refused caller is refused again without a new prompt", async () => {
		await session.openTab(fixtures.url("simple.html"));
		const capturing = outcomeOf(capture(session));
		const promptContext = await waitForPrompt(session, { timeout: 4000 });
		const outcome = await capturing;
		if (promptContext) {
			await session.closeTab(promptContext);
			return "a refused caller was asked again instead of being turned away";
		}
		// the point here is that nothing was captured; which way the refusal is delivered
		// is the previous test's subject
		return outcome.value && outcome.value.content ? "the refused caller got the page anyway" : undefined;
	});

	await test("refusing does not stop the extension saving normally", async () => {
		// the permission covers the external capture API, not the extension itself, so a
		// refusal must not leave SingleFile in a state where its own save is affected
		clearDownloads(session.downloadDir);
		await session.openTab(fixtures.url("simple.html"));
		const outcome = await outcomeOf(session.dispatch("save-page"));
		if (outcome.error) {
			return "save-page was refused too: " + outcome.error;
		}
		// wait for the file, do not just check nothing threw: a save left in flight lands
		// in the download directory after the next spec has cleared it, and every
		// waitForDownload from then on returns the previous test's file
		const content = readSavedPage(await waitForDownload(session.downloadDir));
		return content.includes(MARKER_TEXT) ? undefined : "the save after a refusal is not the fixture page";
	});

	await session.resetCapturePermissions();
}

function capture(session) {
	return session.dispatch({ method: "capture-page", config: {} },
		{ expectResponse: true, responseTimeout: REFUSAL_TIMEOUT });
}

// A refusal reaches the caller as a rejection on Firefox and as nothing at all on
// Chromium, so both have to be representable rather than one of them throwing here.
async function outcomeOf(promise) {
	try {
		return { value: await promise };
	} catch (error) {
		return { error: error.message };
	}
}

// What matters is that the reason reaches the caller, not which channel carries it. The
// two engines cannot use the same one: Firefox reports a rejected onMessageExternal
// handler through runtime.lastError, and Chrome gives a listener no way to set it, so
// there the reason arrives as an { error } response instead. Both count; being told
// nothing does not.
function describeRefusal({ value, error }) {
	if (error) {
		return error.includes(REFUSAL_MESSAGE) ? undefined : "refused with an unexpected error: " + error;
	}
	if (value && value.noResponse) {
		return String(value.detail).includes(REFUSAL_MESSAGE)
			? undefined
			: "the caller was told nothing at all (" + value.detail + ")";
	}
	if (value && value.error) {
		return String(value.error).includes(REFUSAL_MESSAGE)
			? undefined
			: "refused with an unexpected error: " + value.error;
	}
	return "the refused caller got " + JSON.stringify(value).slice(0, 120);
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
