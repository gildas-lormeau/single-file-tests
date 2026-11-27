// Level 3 spec: the message that stores the default profile is answered.
//
// The options page shown in the side panel stores the profile picked in its list with the message
// "tabsData.set", waits for the answer, and only then asks for the context menus to be rebuilt. In
// Chromium the background script answered nothing to that message, and a message without an
// answer never ends for the page that waits for it: the menus were not rebuilt, and the entry
// checked under "Select the default profile" stayed the old one.
//
// Level 3 because the message is sent from one of SingleFile's own pages. The context menu itself
// is browser chrome, out of reach of the suite, so the test checks what the page waits for.

const SIDE_PANEL_PAGE = "src/ui/pages/options.html#side-panel";
const ANSWER_TIMEOUT = 3000;
const STORE_TABS_DATA = "(async () => { const tabsData = await browser.runtime.sendMessage({ method: \"tabsData.get\" });" +
	" return Promise.race([browser.runtime.sendMessage({ method: \"tabsData.set\", tabsData }).then(() => \"answered\", error => \"rejected: \" + error.message)," +
	" new Promise(resolve => setTimeout(() => resolve(\"no answer\"), " + ANSWER_TIMEOUT + "))]); })()";

export const name = "tabs-data";
export const level = 3;

export async function run({ session, test }) {
	await test("storing the default profile from the side panel is answered", async () => {
		const context = await session.openTab(session.singlefileURL(SIDE_PANEL_PAGE));
		// the data read is stored back as it is, nothing changes for the specs that follow
		const outcome = await session.evaluate(context, STORE_TABS_DATA);
		await session.closeTab(context);
		return outcome == "answered" ? undefined : "the message that stores the tabs data got " + outcome + " after " + ANSWER_TIMEOUT + " ms";
	});
}
