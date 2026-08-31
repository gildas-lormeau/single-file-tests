// Level 2 spec: what a save is actually called on disk.
//
// This is worth testing functionally because the name is produced by two stages that
// cannot be checked in isolation. single-file-core builds it from the template and
// substitutes lookalikes for characters a filesystem rejects; then download-util.js walks
// a retry ladder, re-sanitizing and calling downloads.download again each time the
// browser refuses the name. Which rung fires depends on the engine's own rules, so only
// a real download in a real browser says whether the ladder ends in a file.
//
// #1971 was exactly this: Firefox rejecting format characters that Chromium accepted.
//
// The template is reduced to "{page-title}.{filename-extension}" for the duration, so the
// basename is the sanitized title and nothing else. Restored at the end, because the
// session is shared with the specs that run after this one.

import { waitForDownload, clearDownloads, listDownloads } from "../expect/saved-page.mjs";

const TITLE_TEMPLATE = { filenameTemplate: "{page-title}.{filename-extension}" };
const DEFAULT_TEMPLATE = { filenameTemplate: "%if-empty<{page-title}|No title> ({date-locale} {time-locale}).{filename-extension}" };
// mirrors filenameMaxLength in the extension's DEFAULT_CONFIG, counted in bytes
const MAX_FILENAME_BYTES = 192;
const SAVE_TIMEOUT = 25000;
// built from code points rather than written literally: these are invisible, and an
// editor or a copy-paste that drops one would silently turn the test into a no-op
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200B);
const WORD_JOINER = String.fromCharCode(0x2060);
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200D);
const NO_BREAK_SPACE = String.fromCharCode(0x00A0);
const THIN_SPACE = String.fromCharCode(0x2009);
const NARROW_NO_BREAK_SPACE = String.fromCharCode(0x202F);

export const name = "filename";
export const level = 2;

export async function run({ session, fixtures, test }) {
	await session.importSettings(TITLE_TEMPLATE);

	await test("a plain title becomes the filename verbatim", async () => {
		const { name } = await saveTitled(session, fixtures, "Plain fixture title");
		return name == "Plain fixture title.html" ? undefined : "saved as " + JSON.stringify(name);
	});

	await test("characters a filesystem rejects become lookalikes, not losses", async () => {
		// the core replaces each of these with its fullwidth twin, so the title stays
		// readable instead of collapsing into underscores
		const { name } = await saveTitled(session, fixtures, "Ratio 1:2 <how?> 100% *ok*");
		const expected = "Ratio 1：2 ＜how？＞ 100％ ＊ok＊.html";
		return name == expected ? undefined : "saved as " + JSON.stringify(name) + ", expected " + JSON.stringify(expected);
	});

	await test("format characters do not stop the download", async () => {
		// the #1971 class: Firefox refuses \p{Cf} in a filename and Chromium does not, so
		// this passes on one engine before any sanitizing and exercises the ladder on the
		// other. Either way a file has to appear, and it must not still carry them.
		const title = "Zero" + ZERO_WIDTH_SPACE + "width" + WORD_JOINER + "joined" + ZERO_WIDTH_JOINER + " title";
		const { name } = await saveTitled(session, fixtures, title);
		if (/\p{Cf}/u.test(name)) {
			return "format characters survived into " + JSON.stringify(name);
		}
		return name.includes("Zero") && name.includes("title") ? undefined : "the title was lost: " + JSON.stringify(name);
	});

	await test("exotic spaces do not stop the download", async () => {
		const title = "Non" + NO_BREAK_SPACE + "breaking" + THIN_SPACE + "thin" + NARROW_NO_BREAK_SPACE + "narrow space";
		const { name } = await saveTitled(session, fixtures, title);
		return name.includes("Non") && name.includes("narrow space") ? undefined : "saved as " + JSON.stringify(name);
	});

	await test("accents and emoji survive the round trip", async () => {
		// non-ASCII is the last rung before the ladder gives up and replaces everything, so
		// a regression here shows up as a name of underscores rather than as an error
		const title = "Café déjà-vu 🎉 naïve";
		const { name } = await saveTitled(session, fixtures, title);
		return name == title + ".html" ? undefined : "saved as " + JSON.stringify(name);
	});

	await test("a title longer than the limit is truncated to the limit", async () => {
		// this was a known failure until core 1.5.119: template-formatter.js truncated to
		// (limit - extension length), then appended an ellipsis and the extension without
		// counting the ellipsis, so the name overran by its 3 bytes. Harmless at the default
		// 192, but a user who set the limit to the filesystem's own maximum got a name the
		// filesystem then refused. Fixed by c8c2e84.
		const { name } = await saveTitled(session, fixtures, "L" + "o".repeat(400) + "ng");
		if (!name.startsWith("Lo") || !name.endsWith(".html")) {
			return "saved as " + JSON.stringify(name);
		}
		const size = Buffer.byteLength(name, "utf8");
		return size > MAX_FILENAME_BYTES
			? "the filename is " + size + " bytes, over the " + MAX_FILENAME_BYTES + " byte limit"
			: undefined;
	});

	await test("a title cannot steer the save out of the download directory", async () => {
		// Slashes coming from a variable are replaced before anything else looks at the
		// name, so only the template can put a save in a subfolder. That is the boundary
		// worth guarding: a page picks its own title, a template is the user's own choice.
		const { name, path } = await saveTitled(session, fixtures, "../../escaped/../../../outside");
		if (name.includes("/")) {
			return "a path separator from the title survived into " + JSON.stringify(name);
		}
		return path.startsWith(session.downloadDir) ? undefined : "saved outside the download directory: " + path;
	});

	await session.importSettings(DEFAULT_TEMPLATE);
}

// One save per case, named by what the page calls itself. Hidden files are included
// because a leading dot is one of the things that can go wrong, and filtering them out
// would turn a bad name into a missing download.
async function saveTitled(session, fixtures, title) {
	clearDownloads(session.downloadDir);
	await session.openTab(fixtures.titledURL(title));
	await session.dispatch("save-page");
	const path = await waitForDownload(session.downloadDir, { timeout: SAVE_TIMEOUT, includeHidden: true });
	const [name] = listDownloads(session.downloadDir);
	return { name, path };
}
