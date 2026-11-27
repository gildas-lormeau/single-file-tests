// Level 3 spec: an imported settings file that does not hold every option is completed before it
// is stored.
//
// A settings file written by an older version, or by hand, lacks the options added since, and the
// import fills them with their defaults. The profiles used to be stored as they came and completed
// by a second write a moment later. Whatever read the settings between the two writes got a profile
// with holes: an options page being refreshed at that moment stopped on the first option it could
// not read, with "Cannot read properties of undefined" in its console.
//
// The window between the two writes is a few milliseconds, so the test does not try to read inside
// it. It listens to the writes themselves: every value stored for a profile must be complete.
//
// Level 3 because the writes are observed from one of SingleFile's own pages.

import { clearDownloads, waitForDownload } from "../expect/saved-page.mjs";

const CONTROL_PAGE = "src/ui/pages/batch-save-urls.html";
const PROFILE_KEY_PREFIX = "profile_";
// an option every complete profile holds, and that the imported file does not
const WATCHED_OPTION = "acceptHeaders";
const WATCH_WRITES = "(() => { globalThis.profileWrites = []; browser.storage.onChanged.addListener(changes => Object.keys(changes)" +
	".filter(key => key.startsWith(" + JSON.stringify(PROFILE_KEY_PREFIX) + ") && changes[key].newValue)" +
	".forEach(key => globalThis.profileWrites.push(Boolean(changes[key].newValue[" + JSON.stringify(WATCHED_OPTION) + "])))); })()";
const READ_WRITES = "JSON.stringify(globalThis.profileWrites)";

export const name = "settings-import";
export const level = 3;

export async function run({ session, fixtures, test }) {
	await test("a partial settings file is never stored with options missing", async () => {
		const control = await session.openTab(session.singlefileURL(CONTROL_PAGE));
		await session.evaluate(control, WATCH_WRITES);
		// "save raw page" is not the default, so that the import changes the stored profile
		await session.closeTab(await session.importSettings({ saveRawPage: true }));
		const writes = JSON.parse(await session.evaluate(control, READ_WRITES));
		await session.closeTab(control);
		// the defaults, for the specs that follow
		await session.closeTab(await session.importSettings({}));
		const partial = writes.filter(complete => !complete).length;
		return (writes.length ? undefined : "no write of a profile was seen, the test proved nothing")
			|| (partial ? partial + " of the " + writes.length + " write(s) of the profile stored it without \"" + WATCHED_OPTION + "\"" : undefined);
	});

	// In Chromium a save creates the offscreen document, which used to claim every message sent
	// in the extension and to answer only its own. The last message of the import is one that
	// nothing answers: with the document open it stayed pending for ever, the import handler of
	// the options page never ended, and the file input kept its file, so that choosing the same
	// file again did nothing. `importSettings` waits for that input to be emptied.
	await test("the import ends in the options page after a page was saved", async () => {
		clearDownloads(session.downloadDir);
		const context = await session.openTab(fixtures.url("simple.html"));
		await session.dispatch("save-page");
		await waitForDownload(session.downloadDir);
		await session.closeTab(context);
		await session.closeTab(await session.importSettings({}));
	});
}
