/* eslint-disable no-console */

// Tries a change in the real extension: installs the working tree of the extension in a browser,
// opens a page, asks SingleFile to save it the way a menu entry does, and hands back the saved file
// with screenshots of the page and of the saved file. It is the manual check ("load the extension,
// save this page, look at the result") made repeatable, for a page and options chosen on the spot.
// The specs next to this file are the suite, with fixed pages and assertions, this script asserts
// nothing: it produces what there is to look at.
//
//   node extension/verify.mjs --url=https://example.com/
//   node extension/verify.mjs --url=... --browser=firefox        chromium (default), firefox or both
//   node extension/verify.mjs --url=... --select=article          select the content of the first
//                                                                 matching element, save the selection
//   node extension/verify.mjs --url=... --action=edit-and-save-page   open the annotation editor
//   node extension/verify.mjs --url=... --options='{"compressContent":true}'
//   node extension/verify.mjs --url=... --out=/some/dir --headful --release
//
// The extension installed is the sibling checkout as it is on disk, so what is tried is what
// `lib/` holds: run `./build.sh` in the extension repository after a change in its `src/`, or
// `npm run dev` there to try a local checkout of single-file-core (and restore `lib/` afterwards).
//
// The actions are the ones of the external API (see README.md, level 1), which funnel into the same
// handlers as the menu entries. A menu entry that has no external action cannot be triggered here.

import { copyFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { openSession, BROWSERS } from "./driver/session.mjs";
import { waitForDownload, clearDownloads } from "./expect/saved-page.mjs";

const ACTION_SAVE_PAGE = "save-page";
const ACTION_SAVE_SELECTION = "save-selected-content";
const EDITOR_ACTION_PREFIX = "edit-";
const EDITOR_PAGE = "/src/ui/pages/editor.html";
const VIEWPORT = { width: 1280, height: 900 };
const RESPONSE_TIMEOUT = 30000;
const DEFAULT_SAVE_TIMEOUT = 120000;
const EDITOR_TIMEOUT = 60000;
const POLL_DELAY = 500;
// the saved file and the editor draw after their load event: fonts, frames, the page unpacked from
// an archive
const SETTLE_DELAY = 2000;

const options = parseArguments(process.argv.slice(2));
if (!options.url) {
	console.error("usage: node extension/verify.mjs --url=<url> [--browser=chromium|firefox|both] [--select=<selector>] [--action=<action>] [--options=<json>] [--out=<dir>] [--timeout=<ms>] [--headful] [--release]");
	process.exit(2);
}
const browserNames = !options.browser || options.browser == "chromium" ? ["chromium"] : options.browser == "both" ? BROWSERS : [options.browser];
const action = options.action || (options.select ? ACTION_SAVE_SELECTION : ACTION_SAVE_PAGE);
const profile = options.options ? JSON.parse(options.options) : undefined;
const outputDirectory = options.out ? resolve(options.out) : mkdtempSync(join(tmpdir(), "sf-verify-"));
mkdirSync(outputDirectory, { recursive: true });

const results = [];
let failed = false;
for (const browserName of browserNames) {
	try {
		results.push(await verify(browserName));
	} catch (error) {
		failed = true;
		results.push({ browser: browserName, error: error.message });
	}
}
console.log(JSON.stringify(results, null, "\t"));
process.exit(failed ? 1 : 0);

async function verify(browserName) {
	const session = await openSession(browserName, { headless: !options.headful, release: Boolean(options.release) });
	const result = { browser: browserName, extension: session.releaseZip || session.extensionPath, action };
	if (session.releaseStaleness) {
		result.warning = "this package is stale: " + session.releaseStaleness;
	}
	try {
		if (profile) {
			await session.importSettings(profile);
		}
		const context = await session.openTab(options.url);
		await session.setViewport(context, VIEWPORT.width, VIEWPORT.height);
		result.original = await screenshot(session, context, browserName + "-original.png");
		if (options.select) {
			result.selectedText = await session.evaluate(context, getSelectExpression(options.select));
		}
		clearDownloads(session.downloadDir);
		await session.dispatch(action, { expectResponse: true, responseTimeout: RESPONSE_TIMEOUT });
		if (action.startsWith(EDITOR_ACTION_PREFIX)) {
			const editorContext = await waitForContext(session, EDITOR_PAGE, EDITOR_TIMEOUT);
			await session.setViewport(editorContext, VIEWPORT.width, VIEWPORT.height);
			await delay(SETTLE_DELAY);
			result.editor = await screenshot(session, editorContext, browserName + "-editor.png");
		} else {
			const downloadedPath = await waitForDownload(session.downloadDir, { timeout: Number(options.timeout) || DEFAULT_SAVE_TIMEOUT });
			const savedPath = join(outputDirectory, browserName + "-" + basename(downloadedPath));
			copyFileSync(downloadedPath, savedPath);
			result.saved = savedPath;
			result.bytes = statSync(savedPath).size;
			const savedContext = await session.openTab(pathToFileURL(savedPath).href);
			await session.setViewport(savedContext, VIEWPORT.width, VIEWPORT.height);
			await delay(SETTLE_DELAY);
			result.rendered = await screenshot(session, savedContext, browserName + "-saved.png");
			result.renderedText = await session.evaluate(savedContext, "document.body ? document.body.innerText.trim().length : 0");
		}
	} finally {
		await session.close();
	}
	return result;
}

// One element only: Chromium keeps a single range in a selection.
function getSelectExpression(selector) {
	return "(() => {" +
		"const element = document.querySelector(" + JSON.stringify(selector) + ");" +
		"if (!element) { throw new Error(\"no element matches \" + " + JSON.stringify(selector) + "); }" +
		"const range = document.createRange();" +
		"range.selectNodeContents(element);" +
		"const selection = getSelection();" +
		"selection.removeAllRanges();" +
		"selection.addRange(range);" +
		"return selection.toString().trim().length;" +
		"})()";
}

async function screenshot(session, context, name) {
	const { data } = await session.session.send("browsingContext.captureScreenshot", { context });
	const filePath = join(outputDirectory, name);
	writeFileSync(filePath, Buffer.from(data, "base64"));
	return filePath;
}

async function waitForContext(session, urlPart, timeout) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
		const found = contexts.find(({ url }) => url.includes(urlPart));
		if (found) {
			return found.context;
		}
		await delay(POLL_DELAY);
	}
	throw new Error("no tab showing " + urlPart + " within " + timeout + "ms");
}

function delay(duration) {
	return new Promise(resolvePromise => setTimeout(resolvePromise, duration));
}

function parseArguments(args) {
	const parsed = {};
	args.forEach(arg => {
		const match = arg.match(/^--([^=]+)(?:=(.*))?$/s);
		if (match) {
			parsed[match[1]] = match[2] === undefined ? true : match[2];
		}
	});
	return parsed;
}
