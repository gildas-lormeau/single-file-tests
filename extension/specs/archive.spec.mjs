// Level 2 spec: switch the save format to a self-extracting archive through the options
// page's own Import feature, then check the extension really produced an SFZ.
//
// The archive format lives in a <select>, and a <select> cannot be driven by synthetic
// input on macOS: the click opens a native menu that swallows the keys. Import sidesteps
// the widget rather than faking a gesture, and it works for every option, so no
// test-only code path had to be added to the extension.
//
// The archives this spec saves are also copied into fixtures/ so the format suite can
// load them. That is the only place where a page the *extension* produced gets checked
// for self-extraction in a real engine.

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { waitForDownload, clearDownloads } from "../expect/saved-page.mjs";

const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures", import.meta.url));
// the "universal" variant (extractDataFromPage) is the one that self-extracts from
// file://; the plain self-extracting archive fetches its own URL, which file:// blocks
const ARCHIVE_PROFILE = { compressContent: true, selfExtractingArchive: true, extractDataFromPage: true };
const PLAIN_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false };
const SFZ_PRELUDE = /^<!DOCTYPE html>\s?<html data-sfz>/;

export const name = "archive";
export const level = 2;

export async function run({ session, fixtures, test }) {
	await session.closeTab(await session.importSettings(ARCHIVE_PROFILE));

	// only set once the file really is an archive, so the publish step cannot pass vacuously
	let archivePath;
	await test("importing the archive profile makes the extension save an SFZ", async () => {
		const savedPath = await saveFixture(session, fixtures);
		const head = readFileSync(savedPath).subarray(0, 120).toString("latin1");
		if (!SFZ_PRELUDE.test(head)) {
			return "the saved file is not an SFZ archive, prelude was " + JSON.stringify(head.slice(0, 60));
		}
		if (!savedPath.endsWith(".zip.html")) {
			return "unexpected extension on " + savedPath;
		}
		archivePath = savedPath;
		return undefined;
	});

	await test("the archive is published for the format suite to self-extract", async () => {
		if (!archivePath) {
			return "no archive was saved to publish";
		}
		mkdirSync(FIXTURES_DIR, { recursive: true });
		// named per browser: the format suite then checks every engine's output
		const target = join(FIXTURES_DIR, "extension-saved-" + session.browserName + ".html");
		copyFileSync(archivePath, target);
		return undefined;
	});

	await test("switching back to plain HTML stops producing archives", async () => {
		await session.closeTab(await session.importSettings(PLAIN_PROFILE));
		const plainPath = await saveFixture(session, fixtures);
		const head = readFileSync(plainPath).subarray(0, 120).toString("latin1");
		return SFZ_PRELUDE.test(head) ? "still saving an archive after switching back" : undefined;
	});
}

async function saveFixture(session, fixtures) {
	clearDownloads(session.downloadDir);
	await session.openTab(fixtures.url("simple.html"));
	await session.dispatch("save-page");
	return waitForDownload(session.downloadDir);
}
