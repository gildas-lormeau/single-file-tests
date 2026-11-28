// Level 2 spec: a save routed to a REST Form API destination, with "open saved pages in a new
// tab" checked. The page lives on the server once it is uploaded, and the server says where in
// its answer: when the JSON it returns holds an http(s) "url", that address is what the new tab
// shows (SingleFile issue 1745). An answer without a usable "url" keeps the former behaviour,
// the tab shows the copy SingleFile holds, in its own viewer page.
//
// The destination is a stub: it stores the form it receives, answers with the JSON chosen by
// the test and serves the page its "url" points to.

import { createServer } from "node:http";

const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const ZIP_SIGNATURE = "PK\x03\x04";
const HTML_PROFILE = { compressContent: false, selfExtractingArchive: false, extractDataFromPage: false };
const ZIP_PROFILE = { compressContent: true, selfExtractingArchive: false, extractDataFromPage: false };
const SERVER_PAGE_PATH = "/saved/1";
const SERVER_PAGE_TITLE = "Page served by the REST stub";
const UPLOAD_PATH = "/upload";
const VIEWER_PAGE = "viewer.html";
const FILE_FIELD_NAME = "file";
const URL_FIELD_NAME = "url";
const TOKEN = "functional-token";
const WAIT_TIMEOUT = 30000;
const POLL_DELAY = 250;

export const name = "rest-form-api";
export const level = 2;

export async function run({ session, fixtures, test }) {
	const api = await startApiStub();
	const destination = {
		saveToRestFormApi: true,
		saveToRestFormApiUrl: api.url + UPLOAD_PATH,
		saveToRestFormApiToken: TOKEN,
		saveToRestFormApiFileFieldName: FILE_FIELD_NAME,
		saveToRestFormApiUrlFieldName: URL_FIELD_NAME,
		openSavedPage: true,
		...HTML_PROFILE
	};
	const openedTabs = [];
	try {
		// the two formats are saved, and their tab opened, by two different functions
		for (const [label, format, marker] of [["", {}, MARKER_TEXT], [", for a page saved as a ZIP file", ZIP_PROFILE, ZIP_SIGNATURE]]) {
			await test("the new tab shows the URL returned by the API" + label, async () => {
				await closeTabs(session, openedTabs);
				await session.closeTab(await session.importSettings({ ...destination, ...format }));
				api.answer = { url: api.url + SERVER_PAGE_PATH };
				const failure = await saveFixture(session, fixtures, api, openedTabs, marker);
				if (failure) {
					return failure;
				}
				const tab = await waitForTab(session, url => url == api.url + SERVER_PAGE_PATH || url.includes(VIEWER_PAGE));
				if (!tab) {
					return "no tab was opened after the upload";
				}
				openedTabs.push(tab.context);
				return tab.url == api.url + SERVER_PAGE_PATH ? undefined : "the new tab shows " + tab.url.split("?")[0];
			});
		}
		await session.closeTab(await session.importSettings(destination));

		// what the server returns is not trusted: only an http(s) address is opened
		for (const [label, answer] of [["no URL", { id: 1 }], ["a URL that is not http(s)", { url: "file:///etc/hosts" }]]) {
			await test("the new tab shows the local copy when the API returns " + label, async () => {
				await closeTabs(session, openedTabs);
				api.answer = answer;
				const failure = await saveFixture(session, fixtures, api, openedTabs);
				if (failure) {
					return failure;
				}
				const tab = await waitForTab(session, url => url.includes(VIEWER_PAGE) || url == answer.url);
				if (!tab) {
					return "no tab was opened after the upload";
				}
				openedTabs.push(tab.context);
				return tab.url.includes(VIEWER_PAGE) ? undefined : "the new tab shows " + tab.url;
			});
		}
	} finally {
		await closeTabs(session, openedTabs);
		await session.closeTab(await session.importSettings({ ...HTML_PROFILE, saveToRestFormApi: false, openSavedPage: false }));
		api.close();
	}
}

async function saveFixture(session, fixtures, api, openedTabs, marker = MARKER_TEXT) {
	api.uploads.length = 0;
	openedTabs.push(await session.openTab(fixtures.url("simple.html")));
	await session.dispatch("save-page");
	const upload = await waitFor(() => api.uploads[0]);
	if (!upload) {
		return "nothing was uploaded";
	}
	if (upload.authorization != "Bearer " + TOKEN) {
		return "unexpected authorization header: " + JSON.stringify(upload.authorization);
	}
	return upload.body.includes(marker) ? undefined : "the uploaded form does not hold the expected content";
}

async function waitForTab(session, matches) {
	return waitFor(async () => {
		const { contexts } = await session.session.send("browsingContext.getTree", { maxDepth: 0 });
		return contexts.find(({ url }) => matches(url));
	});
}

async function closeTabs(session, openedTabs) {
	for (const context of openedTabs.splice(0)) {
		await session.closeTab(context);
	}
}

async function waitFor(getValue) {
	const deadline = Date.now() + WAIT_TIMEOUT;
	let value = await getValue();
	while (!value && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, POLL_DELAY));
		value = await getValue();
	}
	return value;
}

function startApiStub() {
	const stub = { uploads: [], answer: {} };
	const server = createServer((request, response) => {
		if (request.method == "POST" && request.url == UPLOAD_PATH) {
			const chunks = [];
			request.on("data", chunk => chunks.push(chunk));
			request.on("end", () => {
				stub.uploads.push({ authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("latin1") });
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(stub.answer));
			});
		} else if (request.method == "GET" && request.url == SERVER_PAGE_PATH) {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>" + SERVER_PAGE_TITLE + "</title></head><body></body></html>");
		} else {
			response.writeHead(404).end();
		}
	});
	return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
		stub.url = "http://127.0.0.1:" + server.address().port;
		stub.close = () => server.close();
		resolve(stub);
	}));
}
