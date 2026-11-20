// Level 3 spec: "Save selected links" lists every link of the selection (SingleFile#2068).
//
// The links are collected by walking the page from the node the selection starts in. When the
// selection starts inside the text of a link, that node is the text and the walk has already gone
// past the link itself: the first link of the selection was missing from the list, and a selection
// inside one link listed nothing, so the page of the list did not even open.
//
// Level 3 because the result is read in SingleFile's own page, the list of the URLs to save.
//
// The ranges are written by a script: in the light DOM both browsers hand back a range as it was
// written.

const BATCH_PAGE = "src/ui/pages/batch-save-urls.html";
const LISTED_URLS = "JSON.stringify(Array.from(document.querySelectorAll(\".urls-row .result-url-title\")).map(element => element.textContent))";
const SELECTIONS = [
	["inside", "a selection that starts inside the text of a link lists that link", ["first", "second", "third"]],
	["before", "a selection that starts before a link lists that link", ["first", "second", "third"]],
	["one", "a selection inside the text of one link lists that link", ["second"]],
	["end", "a link the selection starts at the very end of is not listed", ["second", "third"]]
];

export const name = "selected-links";
export const level = 3;

export async function run({ session, fixtures, test }) {
	const context = await session.openTab(fixtures.url("selected-links.html"));
	try {
		for (const [selectionName, label, expectedLinks] of SELECTIONS) {
			await test(label, async () => {
				// the action reads the selection of the active tab, and the list opened by the
				// previous selection took its place
				await session.session.send("browsingContext.activate", { context });
				await session.evaluate(context, "window.selectFixtureRange(" + JSON.stringify(selectionName) + ")");
				await session.dispatch("save-selected-links");
				const batchContext = await waitFor(() => findBatchPage(session), Boolean);
				if (!batchContext) {
					return "the list of the URLs to save did not open";
				}
				try {
					// the fragment is removed from the URLs, two links to one page are one page to save
					const expectedUrls = expectedLinks.map(link => fixtures.url("simple.html?link=" + link));
					const urls = await waitFor(async () => JSON.parse(await session.evaluate(batchContext, LISTED_URLS)), value => value && value.length >= expectedUrls.length);
					return JSON.stringify(urls) == JSON.stringify(expectedUrls) ? undefined : "listed " + JSON.stringify(urls) + ", expected " + JSON.stringify(expectedUrls);
				} finally {
					await session.closeTab(batchContext);
				}
			});
		}
	} finally {
		await session.closeTab(context);
	}
}

async function findBatchPage(session) {
	const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
	const found = contexts.find(node => node.url && node.url.includes(BATCH_PAGE));
	return found && found.context;
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
