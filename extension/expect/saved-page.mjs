// Assertions run in Node against the file on disk, never inside the browser. That is
// what keeps these tests functional: they check what a user would end up with, not how
// SingleFile got there.

import { readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// browsers write to a .part/.crdownload name first and rename on completion, so this
// is only a short guard against catching a rename mid-flight
const SETTLE_DELAY = 125;

export { waitForDownload, clearDownloads, readSavedPage, expectSelfContained, includesDeclaration };

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

// a save is finished when a non-temporary file appears and stops growing
async function waitForDownload(downloadDir, { timeout = 45000 } = {}) {
	const deadline = Date.now() + timeout;
	let lastSize = -1;
	let stableFor = 0;
	while (Date.now() < deadline) {
		const names = readdirSync(downloadDir)
			.filter(name => !name.startsWith(".") && !name.endsWith(".crdownload") && !name.endsWith(".part"));
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

function findExternalReferences(content) {
	const found = [];
	// stylesheets and images must have been inlined; anchors legitimately stay absolute
	const linkPattern = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
	const imagePattern = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
	[linkPattern, imagePattern].forEach(pattern => {
		let match = pattern.exec(content);
		while (match) {
			const reference = match[1].trim();
			if (/^https?:/i.test(reference)) {
				found.push(reference.slice(0, 60));
			}
			match = pattern.exec(content);
		}
	});
	return found;
}
