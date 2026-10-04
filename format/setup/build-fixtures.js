import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { configure } from "../../../single-file-core/vendor/zip/zip.js";
import { process as processPage } from "../../../single-file-core/processors/compression/compression.js";
import { FIXTURES_DIR, PAYLOADS, CONTAINERS, buildParserPage, parserFixtureName, TERMINATOR_FIXTURES, MARKER_TEXT, mulberry32, ARCHIVE_FIXTURES, IMPORT_FIXTURES, IMPORTED_COLOR, FACE_FIXTURES, renamedFixtureName } from "../lib/fixtures-def.js";
import { buildPNG, buildPDF } from "../lib/face-payloads.js";

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "single-file-core");

export default async function buildFixtures() {
	mkdirSync(FIXTURES_DIR, { recursive: true });
	buildParserFixtures();
	await buildArchiveFixtures();
	await buildFaceFixtures();
}

function buildParserFixtures() {
	for (const container of CONTAINERS) {
		for (const [payloadName, payload] of Object.entries(PAYLOADS)) {
			writeFileSync(join(FIXTURES_DIR, parserFixtureName(container, payloadName)), buildParserPage(container, payload));
		}
	}
	for (const fixture of TERMINATOR_FIXTURES) {
		writeFileSync(join(FIXTURES_DIR, fixture.name), fixture.content);
	}
}

async function buildArchiveFixtures() {
	configure({ useWebWorkers: false });
	const zipScript = readFileSync(join(CORE_DIR, "vendor", "zip", "zip.min.js"), "utf8");
	const binaryResource = makeBinaryResource();
	const baseContent = "<!DOCTYPE html><html><head><meta charset=utf-8><title>base</title></head>" +
		`<body><h1 id=marker>${MARKER_TEXT}</h1><img src="images/blob.bin"></body></html>`;
	await buildArchive("archive-base.html", baseContent, { resources: { images: [binaryResource] } });
	// the hostile payloads live beside their expectations in fixtures-def.js so the two
	// cannot drift apart; each one forces the writer a known distance down the ladder
	for (const { name, payload } of ARCHIVE_FIXTURES) {
		if (name == "archive-base.html") {
			continue;
		}
		await buildArchive(name, pageAround(payload, name), { disableCompression: true });
	}
	for (const { name, script } of IMPORT_FIXTURES) {
		const content = "<!DOCTYPE html><html><head><meta charset=utf-8><title>" + name + "</title>" +
			"<style>@import url(stylesheet_0.css);</style></head>" +
			`<body><h1 id=marker>${MARKER_TEXT}</h1>` + (script ? "<script>document.title += \" \";</script>" : "") + "</body></html>";
		const stylesheet = { name: "stylesheet_0.css", content: `#marker{color:${IMPORTED_COLOR}}`, extension: ".css", url: "https://example.com/style.css" };
		await buildArchive(name, content, { resources: { stylesheets: [stylesheet] } });
	}
	const base = readFileSync(join(FIXTURES_DIR, "archive-base.html"));
	const zipStart = base.indexOf(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
	if (zipStart === -1) {
		throw new Error("local file header not found in archive-base.html");
	}
	const nameLength = base.readUInt16LE(zipStart + 26);
	const extraLength = base.readUInt16LE(zipStart + 28);
	const corruptedOffset = zipStart + 30 + nameLength + extraLength + 10;
	base[corruptedOffset] = base[corruptedOffset] === 0x41 ? 0x42 : 0x41;
	writeFileSync(join(FIXTURES_DIR, "archive-corrupted.html"), base);

	function pageAround(payload, title) {
		return "<!DOCTYPE html><html><head><meta charset=utf-8><title>" + title + "</title></head>" +
			`<body><h1 id=marker>${MARKER_TEXT}</h1><textarea hidden>${payload}</textarea></body></html>`;
	}

	async function buildArchive(name, content, { resources = {}, disableCompression = false }) {
		const pageData = {
			content,
			title: name,
			doctype: "<!DOCTYPE html>",
			resources
		};
		const options = {
			selfExtractingArchive: true,
			extractDataFromPage: true,
			zipScript,
			disableCompression,
			url: "https://example.com/"
		};
		const blob = await processPage(pageData, options);
		writeFileSync(join(FIXTURES_DIR, name), Buffer.from(await blob.arrayBuffer()));
	}
}

// One archive per face combination, plus the renamed copies §1.2 promises will open. The
// copy is made here rather than in the spec because the three Playwright projects run in
// parallel workers and would otherwise race to write the same file.
async function buildFaceFixtures() {
	configure({ useWebWorkers: false });
	const zipScript = readFileSync(join(CORE_DIR, "vendor", "zip", "zip.min.js"), "utf8");
	const embeddedImage = Array.from(buildPNG());
	const embeddedPdf = Array.from(buildPDF());
	for (const { name, options } of FACE_FIXTURES) {
		const content = "<!DOCTYPE html><html><head><meta charset=utf-8><title>" + name + "</title></head>" +
			`<body><h1 id=marker>${MARKER_TEXT}</h1></body></html>`;
		const pageData = { content, title: name, doctype: "<!DOCTYPE html>", resources: {} };
		const blob = await processPage(pageData, {
			...options,
			// the option carries the bytes, so each archive gets its own copy: process()
			// replaces embeddedImage with a Uint8Array view of whatever it was handed
			embeddedImage: options.embeddedImage ? embeddedImage.slice() : undefined,
			embeddedPdf: options.embeddedPdf ? embeddedPdf.slice() : undefined,
			zipScript,
			url: "https://example.com/"
		});
		writeFileSync(join(FIXTURES_DIR, name), Buffer.from(await blob.arrayBuffer()));
	}
	for (const { name, renames } of FACE_FIXTURES) {
		for (const extension of renames) {
			copyFileSync(join(FIXTURES_DIR, name), join(FIXTURES_DIR, renamedFixtureName(name, extension)));
		}
	}
}

function makeBinaryResource() {
	const random = mulberry32(42);
	const bytes = new Uint8Array(4096);
	for (let index = 0; index < bytes.length; index++) {
		const value = random();
		bytes[index] = value < 0.1 ? [0, 10, 13][Math.floor(random() * 3)] : Math.floor(value * 256);
	}
	return { name: "images/blob.bin", content: Array.from(bytes), extension: ".bin", url: "https://example.com/blob.bin" };
}
