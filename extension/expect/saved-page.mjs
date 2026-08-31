// Assertions run in Node against the file on disk, never inside the browser. That is
// what keeps these tests functional: they check what a user would end up with, not how
// SingleFile got there.

import { readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

// browsers write to a .part/.crdownload name first and rename on completion, so this
// is only a short guard against catching a rename mid-flight
const SETTLE_DELAY = 125;

export {
	waitForDownload, clearDownloads, readSavedPage, expectSelfContained, includesDeclaration,
	listDownloads, elementWithId
};

// The opening tag of the element carrying this id, or undefined. Assertions about an
// embedded resource need this: searching the whole page for "data:image" passes as soon
// as any image was inlined, including when the element under test was dropped entirely.
// SingleFile writes compressed markup, so the id may or may not be quoted.
function elementWithId(content, id) {
	const marker = new RegExp("\\sid=[\"']?" + id + "[\"'\\s>]");
	const found = marker.exec(content);
	if (!found) {
		return undefined;
	}
	const start = content.lastIndexOf("<", found.index);
	if (start == -1) {
		return undefined;
	}
	// walk to the closing angle bracket, skipping any that sits inside an attribute value
	let quote;
	for (let index = start; index < content.length; index++) {
		const character = content[index];
		if (quote) {
			if (character == quote) {
				quote = undefined;
			}
		} else if (character == "\"" || character == "'") {
			quote = character;
		} else if (character == ">") {
			return content.slice(start, index + 1);
		}
	}
	return undefined;
}

// SingleFile minifies CSS by default, so "rgb(17, 85, 204)" is written "rgb(17,85,204)".
// Compare with whitespace removed rather than pinning the assertion to one option's output.
function includesDeclaration(content, declaration) {
	const squeeze = text => text.replace(/\s+/g, "");
	return squeeze(content).includes(squeeze(declaration));
}

function clearDownloads(downloadDir) {
	rmSync(downloadDir, { recursive: true, force: true });
	mkdirSync(downloadDir, { recursive: true });
}

// Every completed download under the directory, as paths relative to it. Recursive
// because a filename template may legitimately contain a "/" and save into a subfolder,
// and a spec that only looked at the top level would report that as "nothing was saved".
// Names starting with "." are kept: a leading dot is one of the cases worth asserting on,
// so hiding it here would make that test pass for the wrong reason.
function listDownloads(downloadDir) {
	const found = [];
	walk(downloadDir);
	return found;

	function walk(directory) {
		readdirSync(directory, { withFileTypes: true }).forEach(entry => {
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(entryPath);
			} else if (!entry.name.endsWith(".crdownload") && !entry.name.endsWith(".part")) {
				found.push(relative(downloadDir, entryPath));
			}
		});
	}
}

// a save is finished when a non-temporary file appears and stops growing
async function waitForDownload(downloadDir, { timeout = 45000, includeHidden = false } = {}) {
	const deadline = Date.now() + timeout;
	let lastSize = -1;
	let stableFor = 0;
	while (Date.now() < deadline) {
		const names = listDownloads(downloadDir).filter(name => includeHidden || !name.startsWith("."));
		if (names.length) {
			const filePath = join(downloadDir, names[0]);
			const size = readFileSync(filePath).length;
			if (size > 0 && size == lastSize) {
				stableFor += SETTLE_DELAY;
				if (stableFor >= SETTLE_DELAY * 2) {
					return filePath;
				}
			} else {
				stableFor = 0;
			}
			lastSize = size;
		}
		await new Promise(resolve => setTimeout(resolve, SETTLE_DELAY));
	}
	throw new Error("no download appeared in " + downloadDir + " within " + timeout + "ms");
}

function readSavedPage(filePath) {
	return readFileSync(filePath, "utf8");
}

// the properties that make a save a SingleFile save, independent of any option
function expectSelfContained(content, { markerText }) {
	const problems = [];
	if (!content.includes(markerText)) {
		problems.push("the page content is missing (no " + markerText + ")");
	}
	if (!/Page saved with SingleFile/i.test(content)) {
		problems.push("the SingleFile comment is missing");
	}
	const externalReferences = findExternalReferences(content);
	if (externalReferences.length) {
		problems.push("resources were left external: " + externalReferences.slice(0, 3).join(", "));
	}
	return problems;
}

// Stylesheets and images must have been inlined; anchors legitimately stay absolute, and
// so does the canonical link, which is a pointer back to the original page rather than a
// resource the saved copy depends on.
//
// SingleFile compresses its output, so an attribute value is only quoted when it has to
// be. Reading quoted values alone silently skipped nearly every reference in a real save.
function findExternalReferences(content) {
	const found = [];
	const tagPattern = /<(link|img)\b([^>]*)>/gi;
	let match = tagPattern.exec(content);
	while (match) {
		const [, tagName, attributes] = match;
		const isCanonical = /\brel\s*=\s*["']?canonical\b/i.test(attributes);
		const reference = attributeValue(attributes, tagName.toLowerCase() == "link" ? "href" : "src");
		if (reference && !isCanonical && /^https?:/i.test(reference)) {
			found.push(reference.slice(0, 60));
		}
		match = tagPattern.exec(content);
	}
	return found;
}

function attributeValue(attributes, name) {
	const pattern = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
	const match = pattern.exec(attributes);
	if (!match) {
		return undefined;
	}
	return (match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]).trim();
}
