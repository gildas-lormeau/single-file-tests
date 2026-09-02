// Level 3 spec: the viewer page is where "open the saved page" lands. Its failures used
// to leave a blank tab with the error only in the console, which is how #1917 was
// reported. The page must display the saved page, and say what went wrong otherwise.
//
// Level 3 because the second test opens SingleFile's own page with a bad address and
// reads its error bar, which is not black box.

import { waitForDownload, clearDownloads } from "../expect/saved-page.mjs";

const VIEWER_PAGE = "src/ui/pages/viewer.html";
const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const ERROR_BAR_TAGNAME = "singlefile-error-bar";
const ERROR_BAR_TEXT = `(() => { const bar = document.querySelector("${ERROR_BAR_TAGNAME}"); return bar && bar.shadowRoot ? bar.shadowRoot.textContent : ""; })()`;

export const name = "viewer";
export const level = 3;

export async function run({ session, fixtures, test }) {
	await test("the saved page opens in the viewer", async () => {
		await session.importSettings({ openSavedPage: true });
		let context;
		try {
			clearDownloads(session.downloadDir);
			await session.openTab(fixtures.url("simple.html"));
			await session.dispatch("save-page");
			await waitForDownload(session.downloadDir);
			context = await waitForViewer(session);
			if (!context) {
				return "no viewer tab opened after the save";
			}
			const text = await waitFor(() => session.evaluate(context, "document.body ? document.body.innerText : \"\""), value => value.includes(MARKER_TEXT));
			const errorText = await session.evaluate(context, ERROR_BAR_TEXT);
			if (errorText) {
				return "the viewer displayed an error on a valid page: " + errorText;
			}
			return text.includes(MARKER_TEXT) ? undefined : "the viewer did not display the saved page";
		} finally {
			if (context) {
				await session.closeTab(context);
			}
			await session.importSettings({ openSavedPage: false });
		}
	});

	await test("a page the viewer cannot load is reported in its error bar", async () => {
		const url = session.singlefileURL(VIEWER_PAGE) + "?blobURI=blob:" + session.singlefileURL("missing-blob");
		const context = await session.openTab(url);
		try {
			const errorText = await waitFor(() => session.evaluate(context, ERROR_BAR_TEXT), value => Boolean(value));
			return errorText ? undefined : "no error bar appeared for a blob that cannot be fetched";
		} finally {
			await session.closeTab(context);
		}
	});
}

async function waitForViewer(session, { timeout = 15000 } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const { contexts } = await session.session.send("browsingContext.getTree", {});
		const found = contexts.find(node => node.url && node.url.includes(VIEWER_PAGE));
		if (found) {
			return found.context;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

async function waitFor(read, accept, { timeout = 15000 } = {}) {
	const deadline = Date.now() + timeout;
	let value;
	while (Date.now() < deadline) {
		value = await read().catch(() => undefined);
		if (accept(value)) {
			return value;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	return value;
}
