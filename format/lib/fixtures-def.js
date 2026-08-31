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

export const ARCHIVE_FIXTURES = ["archive-base.html", "archive-fallback-tag.html", "archive-plaintext.html", "archive-corrupted.html"];
