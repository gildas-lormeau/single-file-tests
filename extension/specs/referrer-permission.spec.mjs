// Level 3 spec: a profile that turns on 'pass "Referer" header on cross-origin errors' on a
// browser where the optional "webRequest" permission was never granted.
//
// The options page asks for the permission when the option is ticked, and the Import feature
// switches the option off, so neither leaves a profile in that state. Synchronized settings can:
// the option ticked on one device arrives on another one that has not granted the permission.
// In the Firefox extension the save then stopped before it started, with no error: the button
// did nothing (SingleFile issue 1089 describes the same dead button after an import).
//
// The settings are stored through the message the import and the synchronization end with, sent
// from one of SingleFile's own pages, which is what makes this a level 3 spec. In the Chromium
// extension the option does not rely on that permission, and the test only checks the save.

import { clearDownloads, waitForDownload } from "../expect/saved-page.mjs";

const CONTROL_PAGE = "src/ui/pages/batch-save-urls.html";
const PROFILE_NAME = "__Default_Settings__";
const OPTION_NAME = "passReferrerOnError";
const SAVE_TIMEOUT = 20000;

export const name = "referrer-permission";
export const level = 3;

export async function run({ session, fixtures, test }) {
	await test("a page is saved when the Referer option is on without its permission", async () => {
		const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
		let context;
		try {
			await session.evaluate(control, importExpression({ [OPTION_NAME]: true }));
			const stored = await session.evaluate(control, "browser.runtime.sendMessage({ method: \"config.getProfiles\" })" +
				".then(profiles => String(profiles[" + JSON.stringify(PROFILE_NAME) + "][" + JSON.stringify(OPTION_NAME) + "]))");
			// otherwise the save below would prove nothing
			if (stored != "true") {
				return "the option was not stored as on, found " + JSON.stringify(stored);
			}
			clearDownloads(session.downloadDir);
			context = await session.openTab(fixtures.url("simple.html"));
			await session.dispatch("save-page");
			try {
				await waitForDownload(session.downloadDir, { timeout: SAVE_TIMEOUT });
			} catch (error) {
				return "the page was not saved: " + error.message;
			}
			return undefined;
		} finally {
			// the defaults, for the specs that follow
			await session.evaluate(control, importExpression({}));
			await session.closeTab(control);
			if (context) {
				await session.closeTab(context);
			}
		}
	});
}

function importExpression(profile) {
	const config = { profiles: { [PROFILE_NAME]: profile }, rules: [] };
	return "browser.runtime.sendMessage({ method: \"config.importConfig\", config: " + JSON.stringify(config) + " }).then(() => \"done\")";
}
