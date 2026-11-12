// Level 3 spec. "Auto-save on tab discard" captures the page each time its tab is hidden
// and writes the file when the browser discards the tab. Hiding is done the way a user
// does it, by opening another tab. Discarding is something only the browser decides, or an
// extension through tabs.discard: there is no black-box way to ask for it, so this spec
// calls that API from one of SingleFile's own pages. That call is the only thing it knows
// about the implementation; what it checks is still the file on disk, and the page the
// user is left with.

import { autoSaveHelpers, sleep, MODES } from "../expect/autosave.mjs";

const PENDINGS_PAGE = "src/ui/pages/pendings.html";
const HIDDEN_CAPTURE_DELAY = 2000;
const MARKER_ATTRIBUTE_PREFIX = "data-single-file-";
const STORE_DATABASE_NAME = "single-file-autosave";
const STORE_NAME = "pages";

export const name = "autosave-discard";
export const level = 3;

export async function run({ session, fixtures, test }) {
	const { configure, openAutoSavedPage, savedFiles, pendingSavesProblem } = autoSaveHelpers({ session, fixtures });

	await configure(MODES.none, { autoSaveDiscard: true });

	await test("a hidden tab is not saved until it is discarded, then saved once", async () => {
		const page = await openAutoSavedPage("discard");
		await sleep(1000);
		const front = await session.openTab(fixtures.url("simple.html"));
		const before = await savedFiles({}, { quietPeriod: HIDDEN_CAPTURE_DELAY });
		if (before.problem) {
			await session.closeTab(front);
			await session.closeTab(page.context);
			return "before the discard: " + before.problem;
		}
		const discarded = await discardTab(page.title);
		const names = await savedFiles({ [page.title]: 1 });
		await closePage(page);
		await session.closeTab(front);
		return discarded ? names.problem : "the tab could not be discarded";
	});

	await test("a tab hidden and shown again keeps a page free of capture markers", async () => {
		const page = await openAutoSavedPage("discard-markers", { url: fixtures.url("rich.html") });
		await sleep(1000);
		const front = await session.openTab(fixtures.url("simple.html"));
		await sleep(HIDDEN_CAPTURE_DELAY);
		await session.closeTab(front);
		await session.activate(page.context);
		await sleep(500);
		const markers = JSON.parse(await session.evaluate(page.context, "JSON.stringify(Array.from(new Set(Array.from(document.querySelectorAll(\"*\"))" +
			".flatMap(element => element.getAttributeNames()).filter(attributeName => attributeName.startsWith(" + JSON.stringify(MARKER_ATTRIBUTE_PREFIX) + ")))))"));
		await session.closeTab(page.context);
		return markers.length ? "the live page still carries " + markers.join(", ") : undefined;
	});

	// Chromium only: the MV3 service worker can be stopped while a hidden tab waits for its
	// discard, so the capture is also kept in an IndexedDB store. A record must not outlive
	// the tab's need for it, or it stays on the user's disk.
	if (session.browserName == "chromium") {
		await test("the capture of a hidden tab is stored, and removed once the tab is discarded and saved", async () => {
			const page = await openAutoSavedPage("store-discard");
			await sleep(1000);
			const front = await session.openTab(fixtures.url("simple.html"));
			await sleep(HIDDEN_CAPTURE_DELAY);
			const whileHidden = await storedCaptures(page);
			await discardTab(page.title);
			const names = await savedFiles({ [page.title]: 1 });
			const afterSave = await storedCaptures(page);
			await closePage(page);
			await session.closeTab(front);
			return whileHidden.length != 1 ? "expected 1 stored capture while the tab was hidden, found " + describe(whileHidden)
				: names.problem || (afterSave.length ? describe(afterSave) + " left in the store after the save" : undefined);
		});

		await test("the stored capture of a hidden tab is removed when the tab is closed", async () => {
			const page = await openAutoSavedPage("store-close");
			await sleep(1000);
			const front = await session.openTab(fixtures.url("simple.html"));
			await sleep(HIDDEN_CAPTURE_DELAY);
			const whileHidden = await storedCaptures(page);
			await session.closeTab(page.context);
			await sleep(1000);
			const afterClose = await storedCaptures(page);
			await session.closeTab(front);
			const files = await savedFiles({});
			return whileHidden.length != 1 ? "expected 1 stored capture while the tab was hidden, found " + describe(whileHidden)
				: afterClose.length ? describe(afterClose) + " left in the store after the tab was closed" : files.problem;
		});

		await test("the stored capture of a hidden tab is removed when the tab loads another page", async () => {
			const page = await openAutoSavedPage("store-navigate");
			await sleep(1000);
			const front = await session.openTab(fixtures.url("simple.html"));
			await sleep(HIDDEN_CAPTURE_DELAY);
			const whileHidden = await storedCaptures(page);
			await session.closeTab(front);
			await session.activate(page.context);
			await session.navigate(page.context, fixtures.url("simple.html"));
			await sleep(1000);
			const afterNavigation = await storedCaptures(page);
			await session.closeTab(page.context);
			await sleep(1000);
			const afterClose = await storedCaptures(page);
			return whileHidden.length != 1 ? "expected 1 stored capture while the tab was hidden, found " + describe(whileHidden)
				: afterNavigation.length ? describe(afterNavigation) + " left in the store after the navigation"
					: afterClose.length ? describe(afterClose) + " left in the store after the tab was closed" : undefined;
		});
	}

	await test("no save is left pending after the discard tests", async () => {
		return pendingSavesProblem();
	});

	// leave the profile as the other specs expect it
	await configure(MODES.loadOrUnload, { autoSaveDelay: 1 });

	// by URL and before the tab in front of it: see closeTabsShowing
	function closePage(page) {
		return session.closeTabsShowing(encodeURIComponent(page.title));
	}

	// The records of the store that hold the given page, read from an extension page. Only
	// those: reading the store opens a tab, which hides the one in front, and when that one
	// has auto-save its capture is stored too, rightly.
	//
	// The database is only opened when it exists: opening a missing one would create it
	// empty, and the extension would then find a database without its store.
	async function storedCaptures(page) {
		const context = await session.openTab(session.singlefileURL(PENDINGS_PAGE));
		const records = await session.evaluate(context, "(async () => { " +
			"if (!(await indexedDB.databases()).some(database => database.name == " + JSON.stringify(STORE_DATABASE_NAME) + ")) { return \"[]\"; } " +
			"const database = await new Promise((resolve, reject) => { const request = indexedDB.open(" + JSON.stringify(STORE_DATABASE_NAME) + "); " +
			"request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); " +
			"try { if (!database.objectStoreNames.contains(" + JSON.stringify(STORE_NAME) + ")) { return \"[]\"; } " +
			"return await new Promise((resolve, reject) => { const request = database.transaction(" + JSON.stringify(STORE_NAME) + ").objectStore(" + JSON.stringify(STORE_NAME) + "); " +
			"const keysRequest = request.getAllKeys(); const valuesRequest = request.getAll(); " +
			"request.transaction.oncomplete = () => resolve(JSON.stringify(valuesRequest.result.map((record, index) => " +
			"\"tab \" + keysRequest.result[index] + \": \" + String(record.url).replace(/^.*[/=]/, \"\")))); " +
			"request.transaction.onerror = () => reject(request.transaction.error); }); } finally { database.close(); } })()");
		await session.closeTab(context);
		return JSON.parse(records).filter(record => record.endsWith(": " + page.title));
	}

	// tabs.discard, called from an extension page: Chromium's is promise-based on chrome,
	// Firefox's on browser
	async function discardTab(pageTitle) {
		const context = await session.openTab(session.singlefileURL(PENDINGS_PAGE));
		const api = session.browserName == "firefox" ? "browser" : "chrome";
		const result = await session.evaluate(context, "(async () => { const tabs = await " + api + ".tabs.query({}); " +
			"const tab = tabs.find(tab => tab.url && tab.url.includes(" + JSON.stringify(encodeURIComponent(pageTitle)) + ")); " +
			"if (!tab) { return \"no tab\"; } await " + api + ".tabs.discard(tab.id); return \"discarded\"; })()");
		await session.closeTab(context);
		return result == "discarded";
	}
}

function describe(records) {
	return records.length + " [" + records.join(", ") + "]";
}
