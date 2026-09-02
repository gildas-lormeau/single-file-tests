// Level 2 spec: a save routed to a WebDAV destination must upload the bytes the
// extension produced. The background hands every destination the saved content, and it
// used to read that content as text first, which mangles an archive.
//
// The destination is a stub answering the client's HEAD probe with 404 so it PUTs.

import { createServer } from "node:http";

const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const SFZ_PRELUDE = /^<!DOCTYPE html>\s?<html data-sfz>/;
const ZIP_LOCAL_HEADER = "PK";
const ARCHIVE_PROFILE = { compressContent: true, selfExtractingArchive: true, extractDataFromPage: true };

export const name = "webdav";
export const level = 2;

export async function run({ session, fixtures, test }) {
	const webDAV = await startWebDAVStub();
	const destination = { saveWithWebDAV: true, webDAVURL: webDAV.url, webDAVUser: "user", webDAVPassword: "password" };
	try {
		await test("a plain save is uploaded to the WebDAV server", async () => {
			await session.importSettings(destination);
			const body = await saveFixture(session, fixtures, webDAV);
			if (!body) {
				return "nothing was uploaded";
			}
			const content = body.toString();
			return content.includes(MARKER_TEXT) && content.startsWith("<!DOCTYPE html>") ? undefined : "the uploaded page is not the fixture";
		});

		await test("an archive save is uploaded byte for byte", async () => {
			await session.importSettings({ ...destination, ...ARCHIVE_PROFILE });
			const body = await saveFixture(session, fixtures, webDAV);
			if (!body) {
				return "nothing was uploaded";
			}
			const head = body.subarray(0, 120).toString("latin1");
			if (!SFZ_PRELUDE.test(head)) {
				return "the uploaded file is not an archive, prelude was " + JSON.stringify(head.slice(0, 60));
			}
			if (!body.toString("latin1").includes(ZIP_LOCAL_HEADER)) {
				return "the uploaded archive has no ZIP local header";
			}
			// a text round trip replaces every invalid UTF-8 sequence with U+FFFD, which
			// the deflated entries are full of
			return body.toString("latin1").includes("ï¿½") ? "the uploaded archive went through a text decode" : undefined;
		});
	} finally {
		await session.importSettings({ saveWithWebDAV: false });
		webDAV.close();
	}
}

async function saveFixture(session, fixtures, webDAV) {
	webDAV.uploads.clear();
	await session.openTab(fixtures.url("simple.html"));
	await session.dispatch("save-page");
	const deadline = Date.now() + 45000;
	while (Date.now() < deadline) {
		const [body] = webDAV.uploads.values();
		if (body) {
			return body;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

function startWebDAVStub() {
	const uploads = new Map();
	const server = createServer((request, response) => {
		if (request.method == "PUT") {
			const chunks = [];
			request.on("data", chunk => chunks.push(chunk));
			request.on("end", () => {
				uploads.set(decodeURIComponent(request.url), Buffer.concat(chunks));
				response.writeHead(201).end();
			});
		} else {
			response.writeHead(404).end();
		}
	});
	return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({
		url: "http://127.0.0.1:" + server.address().port + "/",
		uploads,
		close: () => server.close()
	})));
}
