// Level 3 spec: the tabs of the tab groups and of the containers selected in the options page are
// auto-saved.
//
// The section "Auto-saved tabs" of the options page lists the named tab groups of the browser
// and, in Firefox, the containers. The tabs of a checked group or container are auto-saved, on
// top of what the auto-save menu selects. A group is recognised by its name, which is what the
// browser keeps across a restart, so a group that is renamed is no longer the checked one.
//
// Reading the name of a group takes the optional permission "tabGroups". The spec runs in a
// browser of its own, started with that permission (see `grantedPermissions` in session.mjs),
// so what is NOT tested here is the button of the options page that asks for it.
//
// Level 3 because the groups are made through the browser API from one of SingleFile's own
// pages, and the boxes of the options page are checked by script.

import { autoSaveHelpers, sleep, MODES, AUTO_SAVE_DELAY, SAVE_TIMEOUT } from "../expect/autosave.mjs";
import { clearDownloads } from "../expect/saved-page.mjs";

const CONTROL_PAGE = "src/ui/pages/batch-save-urls.html";
const OPTIONS_PAGE = "src/ui/pages/options.html";
const GROUP_NAME = "Research";
const RENAMED_GROUP_NAME = "Archive";
const NO_CONTAINER_ID = "firefox-default";
// what the options page shows for a checked group that no tab is in
const NOT_OPEN_NAME = GROUP_NAME + " (not open)";
const OPTIONS_TIMEOUT = 10000;
const POLL_DELAY = 100;
const SAVE_WAIT = { timeout: AUTO_SAVE_DELAY * 1000 + SAVE_TIMEOUT };
// the lists of the section, as { id of the list: [{ value, name, checked, unavailable }] }
const READ_LISTS = "JSON.stringify(Object.fromEntries([\"autoSaveTabGroupsList\", \"autoSaveContainersList\"].map(id => [id, " +
	"Array.from(document.getElementById(id).querySelectorAll(\"input\")).map(input => ({ value: input.dataset.value, " +
	"name: input.parentElement.querySelector(\"label\").textContent, checked: input.checked, " +
	"unavailable: input.parentElement.classList.contains(\"unavailable\") }))])))";

export const name = "autosave-tabs";
export const level = 3;

export async function run({ session: mainSession, fixtures, test }) {
	let session;
	try {
		session = await mainSession.openVariant({ grantedPermissions: ["tabGroups"] });
	} catch (error) {
		await test("a browser starts with the permission to read the tab groups", async () => error.message);
		return;
	}
	try {
		await runTests({ session, fixtures, test });
	} finally {
		await session.close();
	}
}

async function runTests({ session, fixtures, test }) {
	const { configure, title, savedFiles } = autoSaveHelpers({ session, fixtures });
	// the browser API as an extension page sees it: SingleFile's own `browser` is a short list
	const api = session.browserName == "firefox" ? "browser" : "chrome";
	const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
	// importing the settings empties the selection, so it comes first
	await configure(MODES.load);

	// A tab is found by the title of its page, which is unique in a run.
	const tabOf = pageTitle => "(await " + api + ".tabs.query({})).find(tab => tab.title == " + JSON.stringify(pageTitle) + ")";

	async function openPage(label) {
		const pageTitle = title(label);
		const context = await session.openTab(fixtures.titledURL(pageTitle));
		return { context, title: pageTitle };
	}

	// Put the tab showing a page in a group of its own with the given name, or in an existing
	// group when its id is given.
	async function group(pageTitle, { groupName, groupId }) {
		return session.evaluate(control, "(async () => { const tab = " + tabOf(pageTitle) + "; " +
			"const groupId = await " + api + ".tabs.group(" + (groupId === undefined ? "{ tabIds: [tab.id] }" : "{ tabIds: [tab.id], groupId: " + groupId + " }") + "); " +
			(groupName ? "await " + api + ".tabGroups.update(groupId, { title: " + JSON.stringify(groupName) + " }); " : "") +
			"return groupId; })()");
	}

	// Open the options page, wait for the section to be filled, run `action` on its lists and
	// close the page. An action may check a box, which is all it takes to store the selection.
	async function withOptions(action) {
		const context = await session.openTab(session.singlefileURL(OPTIONS_PAGE));
		try {
			const deadline = Date.now() + OPTIONS_TIMEOUT;
			let lists;
			do {
				await sleep(POLL_DELAY);
				lists = JSON.parse(await session.evaluate(context, READ_LISTS));
			} while (!lists.autoSaveContainersList.length && Date.now() < deadline);
			return await action(context, lists);
		} finally {
			await session.closeTab(context);
		}
	}

	// Check or uncheck the box of a group or of a container, the way a click does.
	async function select(listId, value, checked) {
		return withOptions(async (context, lists) => {
			const item = lists[listId].find(candidate => candidate.value == value);
			if (!item) {
				return "\"" + value + "\" is not listed: " + JSON.stringify(lists[listId].map(candidate => candidate.name));
			}
			if (item.checked != checked) {
				await session.evaluate(context, "Array.from(document.getElementById(" + JSON.stringify(listId) + ").querySelectorAll(\"input\"))" +
					".find(input => input.dataset.value == " + JSON.stringify(value) + ").click()");
				// the page stores the selection in its change handler, which ends after the click returns
				await sleep(500);
			}
		});
	}

	await test("a named tab group is listed in the options page, unchecked", async () => {
		const page = await openPage("listed");
		await group(page.title, { groupName: GROUP_NAME });
		const problem = await withOptions((context, lists) => {
			const item = lists.autoSaveTabGroupsList.find(candidate => candidate.value == GROUP_NAME);
			return item ? (item.checked ? "the group is checked before anyone checked it" : undefined)
				: "the group is not listed: " + JSON.stringify(lists.autoSaveTabGroupsList);
		});
		await session.closeTab(page.context);
		return problem;
	});

	await test("nothing is auto-saved while no group is checked", async () => {
		clearDownloads(session.downloadDir);
		const page = await openPage("unchecked");
		await group(page.title, { groupName: GROUP_NAME });
		await session.navigate(page.context, fixtures.titledURL(page.title));
		const result = await savedFiles({}, { quietPeriod: AUTO_SAVE_DELAY * 1000 + 2000 });
		await session.closeTab(page.context);
		return result.problem;
	});

	await test("a page loaded in a tab of a checked group is auto-saved, a page in another tab is not", async () => {
		const inGroup = await openPage("in-group");
		await group(inGroup.title, { groupName: GROUP_NAME });
		const problem = await select("autoSaveTabGroupsList", GROUP_NAME, true);
		if (problem) {
			return problem;
		}
		clearDownloads(session.downloadDir);
		const outside = await openPage("outside");
		const savedTitle = title("in-group-next");
		await session.navigate(inGroup.context, fixtures.titledURL(savedTitle));
		const result = await savedFiles({ [savedTitle]: 1 }, SAVE_WAIT);
		await session.closeTab(outside.context);
		await session.closeTab(inGroup.context);
		return result.problem;
	});

	await test("a checked group that was renamed is no longer auto-saved, and its old name stays listed", async () => {
		const page = await openPage("renamed");
		await group(page.title, { groupName: RENAMED_GROUP_NAME });
		clearDownloads(session.downloadDir);
		const nextTitle = title("renamed-next");
		await session.navigate(page.context, fixtures.titledURL(nextTitle));
		const result = await savedFiles({}, { quietPeriod: AUTO_SAVE_DELAY * 1000 + 2000 });
		const problem = await withOptions((context, lists) => {
			const old = lists.autoSaveTabGroupsList.find(candidate => candidate.value == GROUP_NAME);
			const renamed = lists.autoSaveTabGroupsList.find(candidate => candidate.value == RENAMED_GROUP_NAME);
			return (old && old.checked && old.unavailable && old.name == NOT_OPEN_NAME ? undefined : "the old name is not listed as checked, dimmed and \"not open\": " + JSON.stringify(old))
				|| (renamed && !renamed.checked ? undefined : "the new name is not listed unchecked: " + JSON.stringify(renamed));
		});
		await session.closeTab(page.context);
		return result.problem || problem;
	});

	await test("a checked group that was closed stays listed as not open, until it is opened again", async () => {
		const read = () => withOptions((context, lists) => lists.autoSaveTabGroupsList.find(candidate => candidate.value == GROUP_NAME));
		const page = await openPage("closed");
		await group(page.title, { groupName: GROUP_NAME });
		const open = await read();
		// closing its only tab deletes the group
		await session.closeTab(page.context);
		const closed = await read();
		return (open && open.checked && !open.unavailable && open.name == GROUP_NAME ? undefined : "the open group is not listed as checked under its name: " + JSON.stringify(open))
			|| (closed && closed.checked && closed.unavailable && closed.name == NOT_OPEN_NAME ? undefined : "the closed group is not listed as checked, dimmed and \"not open\": " + JSON.stringify(closed));
	});

	await test("unchecking a group stops the auto-save of its tabs", async () => {
		const page = await openPage("stopped");
		await group(page.title, { groupName: GROUP_NAME });
		const problem = await select("autoSaveTabGroupsList", GROUP_NAME, false);
		if (problem) {
			return problem;
		}
		clearDownloads(session.downloadDir);
		const nextTitle = title("stopped-next");
		await session.navigate(page.context, fixtures.titledURL(nextTitle));
		const result = await savedFiles({}, { quietPeriod: AUTO_SAVE_DELAY * 1000 + 2000 });
		await session.closeTab(page.context);
		return result.problem;
	});

	if (session.browserName == "firefox") {
		await test("the containers of Firefox are listed with their names", async () => {
			return withOptions((context, lists) => {
				const names = lists.autoSaveContainersList.map(candidate => candidate.name);
				return lists.autoSaveContainersList[0].value == NO_CONTAINER_ID && names.length > 1 ? undefined
					: "expected the tabs without a container and at least one container, got " + JSON.stringify(names);
			});
		});

		await test("with \"tabs without a container\" checked, such a tab is auto-saved and a tab of a container is not", async () => {
			const problem = await select("autoSaveContainersList", NO_CONTAINER_ID, true);
			if (problem) {
				return problem;
			}
			clearDownloads(session.downloadDir);
			// A user context of the test protocol is a container for Firefox. It is made after the
			// options page was used: Firefox fails to list the containers once one of these exists.
			const { userContext } = await session.session.send("browser.createUserContext", {});
			const containerTitle = title("in-container");
			const { context: inContainer } = await session.session.send("browsingContext.create", { type: "tab", userContext });
			await session.navigate(inContainer, fixtures.titledURL(containerTitle));
			const plain = await openPage("no-container");
			const result = await savedFiles({ [plain.title]: 1 }, SAVE_WAIT);
			const stores = JSON.parse(await session.evaluate(control, "browser.tabs.query({}).then(tabs => JSON.stringify(tabs" +
				".filter(tab => tab.title == " + JSON.stringify(containerTitle) + ").map(tab => tab.cookieStoreId)))"));
			await session.closeTab(plain.context);
			await session.closeTab(inContainer);
			await session.session.send("browser.removeUserContext", { userContext });
			return result.problem || (stores.length == 1 && stores[0] != NO_CONTAINER_ID ? undefined
				: "the other tab was not in a container, the test proved nothing: " + JSON.stringify(stores));
		});
	}

	// The tests above load a page in a tab that is already in its group, and the extension asks
	// about the tab when the page starts. Here the page is loaded first: it learns that it is
	// auto-saved only if the extension tells it when its tab joins the group. A page that was
	// not auto-saved while it loaded is saved when it goes away, hence the other mode.
	await configure(MODES.unload);

	await test("a loaded tab that joins a checked group is auto-saved when it is closed", async () => {
		const keeper = await openPage("keeper");
		const groupId = await group(keeper.title, { groupName: GROUP_NAME });
		const problem = await select("autoSaveTabGroupsList", GROUP_NAME, true);
		if (problem) {
			return problem;
		}
		clearDownloads(session.downloadDir);
		const joining = await openPage("joining");
		await group(joining.title, { groupId });
		// the time for the extension to hear about the group and to tell the page
		await sleep(1500);
		await session.closeTab(joining.context);
		const result = await savedFiles({ [joining.title]: 1 }, SAVE_WAIT);
		await session.closeTab(keeper.context);
		return result.problem;
	});

	await session.closeTab(control);
}
