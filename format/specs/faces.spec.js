import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { fixtureURL, fixturePath, MARKER_TEXT, FACE_FIXTURES, renamedFixtureName } from "../lib/fixtures-def.js";
import { IMAGE_WIDTH, IMAGE_HEIGHT, PDF_TEXT } from "../lib/face-payloads.js";
import { hasTool, zipEntries, zipIntegrity, zipEntryText, pdfText, pdfPageCount, readPNGChunks, pngHeader } from "../lib/readers.js";

// The polyglot faces: doc/singlefile-archive.md §1.2 promises that the same bytes open as
// an archive, and, renamed, in a PDF reader or an image viewer. Nothing tested that until
// now — every other spec here reaches the archive through the HTML bootstrap, which is the
// one face that cannot tell you the others are gone.
//
// That is the failure this spec exists for. dropUnhiddenFace() in compression.js drops a
// face whenever no wrapper rung fits its payload, which is correct behaviour: §7.4 says a
// face is a convenience and the archive is not. But the file still saves, still
// self-extracts, and every HTML-face assertion still passes. The only thing that changes
// is that it is not a PNG any more.
//
// Renaming to .zip is deliberately not a browser test: a browser hands a .zip to the
// download manager, so there is nothing rendered to assert. The ZIP face is checked with
// zipinfo and unzip, which is what actually reads it.

const PDF_HEADER_WINDOW = 1024;
const PDF_SIGNATURE = Buffer.from("%PDF-");

for (const fixture of FACE_FIXTURES) {
	const { name, faces } = fixture;
	const path = fixturePath(name);

	test.describe(`${name} (${faces.join(" + ")})`, () => {
		test("the archive is intact and lists the entries the format requires", () => {
			test.skip(!hasTool("unzip") || !hasTool("zipinfo"), "needs unzip and zipinfo");
			const integrity = zipIntegrity(path);
			expect(integrity.ok, integrity.output).toBe(true);
			const entries = zipEntries(path);
			expect(entries).toContain("index.html");
			expect(entries).toContain("manifest.json");
			expect(() => JSON.parse(zipEntryText(path, "manifest.json"))).not.toThrow();
		});

		test("page.pdf is an entry only when the PDF face has the HTML face to ride in", () => {
			test.skip(!hasTool("zipinfo"), "needs zipinfo");
			// with the HTML face the document is wrapped inside the prologue and gets a
			// hand-built local header plus a central record injected before the writer's own
			// directory, which makes it the first entry a ZIP tool lists (§6). Without the
			// HTML face it simply starts the file as prepended data, and is not an entry at
			// all — no local header, no central record (§3).
			const entries = zipEntries(path);
			const expected = faces.includes("pdf") && faces.includes("html");
			expect(entries.includes("page.pdf"),
				expected ? `page.pdf missing from ${entries.join(", ")}` : `page.pdf should not be an entry: ${entries.join(", ")}`)
				.toBe(expected);
			if (expected) {
				expect(entries[0]).toBe("page.pdf");
				expect(entries[1]).toBe("index.html");
			} else {
				expect(entries[0]).toBe("index.html");
			}
		});

		if (faces.includes("pdf")) {
			test("a PDF reader extracts the document's text", () => {
				test.skip(!hasTool("pdftotext"), "needs poppler's pdftotext");
				expect(pdfText(renamed(name, "pdf"))).toContain(PDF_TEXT);
			});

			test("a PDF reader sees one page, not a damaged document", () => {
				test.skip(!hasTool("pdfinfo"), "needs poppler's pdfinfo");
				expect(pdfPageCount(renamed(name, "pdf"))).toBe(1);
			});

			test("the %PDF- header falls inside the window readers scan", () => {
				// §4.3, and §8.1 measured it rather than assuming it: PDFium loads the
				// document while the header starts at offset 1024 or lower and fails from
				// 1025 on. This is the assertion that catches a prologue growing past it,
				// which is a silent loss of the face on every Chromium-based reader.
				const offset = readFileSync(path).indexOf(PDF_SIGNATURE);
				expect(offset, "no %PDF- header at all: the PDF face was dropped").toBeGreaterThanOrEqual(0);
				expect(offset).toBeLessThanOrEqual(PDF_HEADER_WINDOW);
			});
		}

		if (faces.includes("png")) {
			test("the file is a PNG stream from its first byte to its last", () => {
				// the PNG face owns both ends of the file: the signature is the first 8
				// bytes and IEND must be the last chunk, which is why the HTML face gives
				// up its doctype and its end tags in these variants (§5.3)
				const { signed, chunks, trailing } = readPNGChunks(renamed(name, "png"));
				expect(signed, "no PNG signature: the PNG face was dropped").toBe(true);
				expect(chunks.at(-1)?.type).toBe("IEND");
				expect(trailing, "bytes after IEND are outside the PNG stream").toBe(0);
			});

			test("every chunk declares a length its own CRC agrees with", () => {
				// the archive rides in a tEXt chunk whose length is patched once the archive
				// bytes are final, and whose CRC is computed after that (§5.3). Get either
				// wrong and viewers still show the image, because the damage is past the
				// pixel data — this is the only check that looks.
				const { chunks } = readPNGChunks(renamed(name, "png"));
				const broken = chunks.filter(chunk => chunk.overruns || !chunk.validCRC);
				expect(broken.map(chunk => chunk.type + (chunk.overruns ? " overruns the file" : " has a bad CRC"))).toEqual([]);
			});

			test("the whole archive is accounted for by the chunks that carry it", () => {
				// a tEXt chunk whose declared length stops short would leave the rest of the
				// archive outside the PNG stream, where a decoder reads it as a chunk header
				const { chunks } = readPNGChunks(renamed(name, "png"));
				expect(chunks.map(chunk => chunk.type)).toContain("IDAT");
				expect(chunks.filter(chunk => chunk.type == "tEXt").length).toBeGreaterThan(0);
			});

			test("an image viewer reports the source image's true dimensions", () => {
				expect(pngHeader(renamed(name, "png"))).toEqual({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT });
			});
		}

		for (const extension of fixture.renames) {
			test(`renaming to .${extension} changes the name and nothing else`, () => {
				// the promise is about one file under several names, so the copies have to be
				// the same bytes; a test that silently graded a re-encoded file would pass
				// while the claim it stands for was false
				expect(readFileSync(renamed(name, extension)).equals(readFileSync(path))).toBe(true);
			});
		}
	});
}

// The HTML face has to keep working with the others present, which is where the
// combinations actually bite: the PNG face takes the doctype and the end tags away from
// it, and the PDF face sits in the middle of its head.
//
// These two rows were expected failures when this spec was written: with the PDF face,
// universal mode threw "Local file header not found" in every engine. page.pdf reaches the
// extractor with an offset outside the recovered region, which compression-extract.js
// means to skip — but its test compares the decoded filename, and page.pdf is the one
// entry whose record carries no UTF-8 flag, so in a page decoded as windows-1252 its name
// came back as mojibake and the skip missed. Fixed in core 1.5.119 by keeping the inlined
// zip build free of non-ASCII characters, which is what made that decoding wrong.
for (const { name, faces } of FACE_FIXTURES.filter(fixture => fixture.faces.includes("html"))) {
	const others = faces.filter(face => face != "html" && face != "zip");
	test(`${name} still self-extracts with the ${others.join(" and ")} face present`, async ({ page }) => {
		await page.goto(fixtureURL(name));
		await expect(page.locator("#marker")).toHaveText(MARKER_TEXT);
	});
}

// The rename test §1.2 actually describes, in a real engine rather than through a library.
for (const { name } of FACE_FIXTURES.filter(fixture => fixture.renames.includes("png"))) {
	test(`${renamedFixtureName(name, "png")} renders as an image in the browser`, async ({ page }) => {
		await page.goto(fixtureURL(renamedFixtureName(name, "png")));
		const size = await page.evaluate(() => {
			const image = document.images[0];
			return image ? { width: image.naturalWidth, height: image.naturalHeight } : undefined;
		});
		expect(size, "the browser did not display the file as an image").toEqual({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT });
	});
}

function renamed(name, extension) {
	return fixturePath(renamedFixtureName(name, extension));
}
