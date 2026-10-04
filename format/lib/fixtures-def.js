// Fixture definitions shared by the builder (setup/) and the specs (tests/).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

export function fixturePath(name) {
	return join(FIXTURES_DIR, name);
}

export function fixtureURL(name) {
	return "file://" + fixturePath(name);
}

// deterministic PRNG so fixtures are reproducible across runs
export function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6D2B79F5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// payloads for the parser-model pages; sequential 0..255 never produces
// two consecutive identical bytes, so it cannot contain -->, --!> or </xxx
export const PAYLOADS = {
	"all-bytes": Array.from({ length: 256 }, (_, index) => index),
	"crlf-phases": [13, 10, 13, 13, 10, 10, 13, 10, 13],
	"edges": [0, 13, 10, 0, 10, 13, 0, 0, 13],
	"trailing-cr": [65, 66, 13],
	"specials": [128, 129, 130, 141, 142, 143, 144, 157, 158, 159, 255, 160]
};

export const CONTAINERS = ["comment", "style", "plaintext"];

const HEAD = "<!DOCTYPE html><html><head><meta charset=windows-1252><title>test</title></head><body>";

export function buildParserPage(container, payloadBytes) {
	const payload = Buffer.from(payloadBytes);
	if (container === "comment") {
		return Buffer.concat([
			Buffer.from(HEAD + "<span id=start></span><!--"),
			payload,
			Buffer.from("--><span id=end></span></body></html>")
		]);
	} else if (container === "style") {
		return Buffer.concat([
			Buffer.from(HEAD + "<style id=payload>"),
			payload,
			Buffer.from("</style></body></html>")
		]);
	} else if (container === "plaintext") {
		return Buffer.concat([Buffer.from(HEAD + "<plaintext>"), payload]);
	}
	throw new Error("unknown container " + container);
}

export function parserFixtureName(container, payloadName) {
	return `parser-${container}-${payloadName}.html`;
}

// pages exercising the tokenizer terminators the format must model
export const TERMINATOR_FIXTURES = [
	{
		name: "terminator-comment-bang.html",
		content: HEAD + "<span id=start></span><!--A--!>B<span id=end></span></body></html>",
		check: { commentAfter: "start", expected: "A" }
	},
	{
		name: "terminator-style-space.html",
		content: HEAD + "<style id=payload>x</style >y</body></html>",
		check: { styleText: "x" }
	},
	{
		name: "terminator-style-notclosed.html",
		content: HEAD + "<style id=payload>a</styleZb</style></body></html>",
		check: { styleText: "a</styleZb" }
	},
	{
		name: "compat-standards.html",
		content: HEAD + "</body></html>",
		check: { compatMode: "CSS1Compat" }
	},
	{
		name: "compat-quirks.html",
		content: "X<!DOCTYPE html><html><head><meta charset=windows-1252></head><body></body></html>",
		check: { compatMode: "BackCompat" }
	}
];

export const MARKER_TEXT = "SFZ_TEST_OK";

// The containers the writer can hide the zip data in, cheapest first. This mirrors
// EMBEDDED_DATA_TAGS in single-file-core's compression.js: a container is unusable when
// the payload contains the token that would close it early, so the writer walks down this
// list until it finds one the payload cannot break. <plaintext> is last because it is the
// only rung that cannot be closed at all.
//
// `detect` is what the container looks like immediately before the zip data. The writer
// adds an id to some of them, so these are prefixes rather than exact tags.
export const WRAPPER_LADDER = [
	{ name: "comment", detect: "<!--", closedBy: ["-->", "--!>"] },
	{ name: "script", detect: "<script type=sfz-data", closedBy: ["</script"] },
	{ name: "style", detect: "<style type=sfz-data", closedBy: ["</style"] },
	{ name: "noframes", detect: "<noframes", closedBy: ["</noframes"] },
	{ name: "noembed", detect: "<noembed", closedBy: ["</noembed"] },
	{ name: "iframe", detect: "<iframe", closedBy: ["</iframe"] },
	{ name: "xmp", detect: "<xmp", closedBy: ["</xmp"] },
	{ name: "cdata", detect: "<![CDATA[", closedBy: ["]]>"] },
	{ name: "plaintext", detect: "<plaintext", closedBy: [] }
];

// Each archive fixture exists to force the writer a given distance down the ladder, so the
// hostile payload and the expectation belong together. build-fixtures.js composes the page
// around `payload`, which keeps the content and the assertions from drifting apart.
export const ARCHIVE_FIXTURES = [
	{
		name: "archive-base.html",
		// nothing hostile: the writer should stay on the cheapest container
		payload: ""
	},
	{
		name: "archive-fallback-tag.html",
		payload: "--&gt; here is a literal --> comment close"
	},
	{
		name: "archive-plaintext.html",
		payload: "--> --!> </noscript> </noframes> </noembed> </script> </style> </iframe> </xmp>"
	}
];

// Pages whose stylesheet is pulled in by an @import in a <style> element. Firefox applied it
// empty in a self-extracting archive: the display parsed the page with DOMParser before showing
// it, and in Firefox that parse leaves an empty sheet behind for the imported URL, which the
// @import of the displayed page then gets. A <link> to the same URL was not affected. The page
// with a script is displayed by document.write instead of by swapping the document element in
// place, and both paths parsed first.
export const IMPORTED_COLOR = "rgb(1, 2, 3)";
export const IMPORT_FIXTURES = [
	{ name: "archive-style-import.html", script: false },
	{ name: "archive-style-import-script.html", script: true }
];

// The polyglot faces (doc/singlefile-archive.md §2). Every archive has the ZIP face; the
// HTML, PDF and PNG faces are enabled independently, and the point of these fixtures is
// the combinations — the PNG face owns both ends of the file, the PDF face has to land in
// a scan window, and the HTML face has to keep self-extracting with either of them there.
//
// Naming follows §7 of the spec: an archive with no HTML face is a plain ZIP and gets the
// .zip extension, because that is the only name under which anything will open it.
//
// `renames` are the extensions the same bytes are copied to. That copy is the thing under
// test: §1.2 promises the file opens in a PDF reader or an image viewer once renamed, and
// a face that was silently dropped fails there and nowhere else. dropUnhiddenFace() in
// compression.js is allowed to drop one whenever no wrapper rung fits its payload, so the
// archive still saves, still self-extracts, and quietly is not a PNG any more.
export const FACE_FIXTURES = [
	{
		name: "faces-png.html",
		faces: ["html", "zip", "png"],
		renames: ["png"],
		options: { selfExtractingArchive: true, extractDataFromPage: true, embeddedImage: true }
	},
	{
		name: "faces-pdf.html",
		faces: ["html", "zip", "pdf"],
		renames: ["pdf"],
		options: { selfExtractingArchive: true, extractDataFromPage: true, embeddedPdf: true }
	},
	{
		name: "faces-all.html",
		faces: ["html", "zip", "pdf", "png"],
		renames: ["png", "pdf"],
		options: { selfExtractingArchive: true, extractDataFromPage: true, embeddedImage: true, embeddedPdf: true }
	},
	{
		// no HTML face: the PDF document simply starts the file, as prepended data the ZIP
		// face tolerates, and page.pdf is not an archive entry at all (§3)
		name: "faces-pdf-only.zip",
		faces: ["zip", "pdf"],
		renames: ["pdf"],
		options: { selfExtractingArchive: false, embeddedPdf: true }
	},
	{
		name: "faces-png-only.zip",
		faces: ["zip", "png"],
		renames: ["png"],
		options: { selfExtractingArchive: false, embeddedImage: true }
	}
];

export function renamedFixtureName(name, extension) {
	return name.replace(/\.[^.]+$/, "") + "." + extension;
}

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

// Identify the container by what sits immediately before the zip data. A substring search
// over the whole file would also match the payload or the bootstrap script, and would pass
// for the wrong reason.
export function wrapperRungOf(buffer) {
	const zipStart = buffer.indexOf(ZIP_LOCAL_HEADER);
	if (zipStart == -1) {
		return { rung: undefined, tail: "" };
	}
	const tail = buffer.subarray(Math.max(0, zipStart - 120), zipStart).toString("latin1");
	const found = WRAPPER_LADDER.find(rung => tail.includes(rung.detect));
	return { rung: found && found.name, tail };
}

export function unusableRungs(payload) {
	return WRAPPER_LADDER
		.filter(rung => rung.closedBy.some(token => payload.includes(token)))
		.map(rung => rung.name);
}

export function cheapestUsableRung(payload) {
	const unusable = unusableRungs(payload);
	const found = WRAPPER_LADDER.find(rung => !unusable.includes(rung.name));
	return found && found.name;
}
