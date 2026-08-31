// Reading an archive the way each face's own readers do.
//
// The ZIP and PDF faces are checked with real external readers rather than with a parser
// written here, because the claim under test is that stock tools open the file — a parser
// of our own would only prove the bytes match what we expected to write. doc/singlefile-
// archive.md §8.1 measured the same faces with the same tools.
//
// The PNG face is the exception: its chunk framing is parsed here, because the invariant
// that matters is one no viewer reports. The archive rides inside a tEXt chunk whose
// length and CRC are patched after the archive bytes are final (§5.3), and a viewer shows
// the image happily whether or not the bytes past the pixel data are still inside a chunk
// it can account for. Walking the chunks is what catches that.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";

export { hasTool, zipEntries, zipIntegrity, zipEntryText, pdfText, pdfPageCount, readPNGChunks, pngHeader };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const toolCache = new Map();

function hasTool(name) {
	if (!toolCache.has(name)) {
		try {
			execFileSync("command", ["-v", name], { shell: "/bin/sh", stdio: "ignore" });
			toolCache.set(name, true);
		} catch {
			toolCache.set(name, false);
		}
	}
	return toolCache.get(name);
}

function run(name, args, { binary = false } = {}) {
	return execFileSync(name, args, { encoding: binary ? "buffer" : "utf8", maxBuffer: 32 * 1024 * 1024 });
}

// zipinfo -1 prints one entry name per line, in central directory order, which is the
// order the entries are meant to be listed in (§4.4)
function zipEntries(path) {
	return run("zipinfo", ["-1", path]).split("\n").map(line => line.trim()).filter(Boolean);
}

// unzip -t inflates every entry and checks its CRC, so this covers the entry data as well
// as the framing. Its exit status is what says whether the archive is intact.
function zipIntegrity(path) {
	try {
		return { ok: true, output: run("unzip", ["-t", path]) };
	} catch (error) {
		return { ok: false, output: String(error.stdout || "") + String(error.stderr || "") };
	}
}

function zipEntryText(path, entry) {
	return run("unzip", ["-p", path, entry]);
}

function pdfText(path) {
	return run("pdftotext", [path, "-"]);
}

function pdfPageCount(path) {
	const match = /^Pages:\s+(\d+)$/m.exec(run("pdfinfo", [path]));
	return match ? Number(match[1]) : undefined;
}

// Every chunk from the signature to IEND, each with its declared length checked against
// the CRC that follows it. `trailing` is whatever sits after IEND: a PNG stream must end
// there (§5.3), so anything else is the face leaking bytes past its own end.
function readPNGChunks(path) {
	const buffer = readFileSync(path);
	if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
		return { signed: false, chunks: [], trailing: 0 };
	}
	const chunks = [];
	let offset = 8;
	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("latin1", offset + 4, offset + 8);
		const end = offset + 8 + length;
		if (end + 4 > buffer.length) {
			chunks.push({ type, length, overruns: true });
			return { signed: true, chunks, trailing: 0 };
		}
		chunks.push({ type, length, validCRC: buffer.readUInt32BE(end) == (crc32(buffer.subarray(offset + 4, end)) >>> 0) });
		offset = end + 4;
		if (type == "IEND") {
			break;
		}
	}
	return { signed: true, chunks, trailing: buffer.length - offset };
}

function pngHeader(path) {
	const buffer = readFileSync(path);
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
