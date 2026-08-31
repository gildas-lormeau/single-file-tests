// The PNG and PDF documents the face fixtures are built around.
//
// They are generated rather than committed as binaries, for the same reason the parser
// payloads are: a fixture whose bytes nobody can read is a fixture nobody can debug. Both
// are the smallest thing their reader will accept, and both carry a value the specs assert
// on — the image its dimensions, the document its text — so a face that renders the wrong
// payload fails as loudly as a face that does not render at all.

import { crc32, deflateSync } from "node:zlib";

export { buildPNG, buildPDF, IMAGE_WIDTH, IMAGE_HEIGHT, PDF_TEXT, PNG_SIGNATURE, PDF_SIGNATURE };

// asserted by the specs, so they have to be something no default could be mistaken for
const IMAGE_WIDTH = 123;
const IMAGE_HEIGHT = 47;
const PDF_TEXT = "SFZ_PDF_FACE_OK";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PDF_SIGNATURE = Buffer.from("%PDF-");

// An 8-bit RGB image, no interlacing: the plainest thing that is still a real PNG, with
// every chunk length and CRC computed rather than copied, so the fixture stays valid if
// the dimensions above are changed.
function buildPNG(width = IMAGE_WIDTH, height = IMAGE_HEIGHT) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	// bit depth 8, colour type 2 (truecolour), deflate, adaptive filtering, no interlace
	header.set([8, 2, 0, 0, 0], 8);
	// one filter byte per scanline, then three bytes a pixel; a gradient rather than a flat
	// fill so that a viewer showing the image shows something recognisable
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let row = 0; row < height; row++) {
		const start = row * (1 + width * 3);
		raw[start] = 0;
		for (let column = 0; column < width; column++) {
			const pixel = start + 1 + column * 3;
			raw[pixel] = (column * 2) & 0xFF;
			raw[pixel + 1] = (row * 5) & 0xFF;
			raw[pixel + 2] = 0x80;
		}
	}
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	]);
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body) >>> 0, 0);
	return Buffer.concat([length, body, checksum]);
}

// A one-page document with a single line of text in a base-14 font, so no font has to be
// embedded and any reader can extract the string. The cross-reference table is built from
// the real offsets: a reader that repairs a broken xref would hide a fixture that is not
// actually a valid PDF, and then the face tests would be measuring poppler's tolerance.
function buildPDF(text = PDF_TEXT) {
	// no trailing newline inside the stream: Length counts to the last byte before the EOL
	// that precedes endstream, and poppler reports an incorrect length when the two disagree
	const stream = "BT /F1 18 Tf 20 40 Td (" + text + ") Tj ET";
	const objects = [
		"<</Type/Catalog/Pages 2 0 R>>",
		"<</Type/Pages/Kids[3 0 R]/Count 1>>",
		"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
		"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
		"<</Length " + stream.length + ">>\nstream\n" + stream + "\nendstream"
	];
	let body = "%PDF-1.4\n";
	const offsets = [];
	objects.forEach((object, index) => {
		offsets.push(body.length);
		body += (index + 1) + " 0 obj\n" + object + "\nendobj\n";
	});
	const startxref = body.length;
	body += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
	offsets.forEach(offset => body += String(offset).padStart(10, "0") + " 00000 n \n");
	body += "trailer<</Size " + (objects.length + 1) + "/Root 1 0 R>>\nstartxref\n" + startxref + "\n%%EOF\n";
	return Buffer.from(body, "latin1");
}
