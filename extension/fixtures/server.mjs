// Saves need a real http:// origin: file:// pages behave differently and data: pages
// have no filename to derive. A loopback static server keeps fixtures realistic.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PAGES_DIR = fileURLToPath(new URL("./pages", import.meta.url));
const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ttf": "font/ttf"
};
// pages whose title has to be chosen by the test rather than baked into a file
const TITLED_PATH = "/titled";
// a navigation that goes nowhere: the browser asks the page whether it may unload, gets this
// answer and leaves the page where it is, as it does for a link that turns into a download
const NO_CONTENT_PATH = "/no-content";

export { startFixtureServer };

// only & and < can end the title element or start a reference; everything else has to
// reach the document byte for byte, because the filename is derived from it
function titledPage(title) {
	const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>" + escaped
		+ "</title>\n</head>\n<body>\n<h1 id=\"marker\">FUNCTIONAL_FIXTURE_MARKER</h1>\n</body>\n</html>\n";
}

function startFixtureServer() {
	const server = createServer((request, response) => {
		const url = new URL(request.url, "http://127.0.0.1");
		// a policy passed in the query lets one fixture be served under many CSPs
		const extraHeaders = {};
		if (url.searchParams.has("csp")) {
			extraHeaders["content-security-policy"] = url.searchParams.get("csp");
		}
		if (url.pathname == NO_CONTENT_PATH) {
			response.writeHead(204).end();
			return;
		}
		if (url.pathname == TITLED_PATH) {
			response.writeHead(200, { ...extraHeaders, "content-type": CONTENT_TYPES[".html"] });
			response.end(titledPage(url.searchParams.get("title") || ""));
			return;
		}
		// normalize before joining so a crafted path cannot escape the fixtures directory
		const relativePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
		const filePath = join(PAGES_DIR, relativePath);
		if (!filePath.startsWith(PAGES_DIR)) {
			response.writeHead(403).end();
			return;
		}
		try {
			const content = readFileSync(filePath);
			response.writeHead(200, {
				...extraHeaders,
				"content-type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream"
			});
			response.end(content);
		} catch {
			response.writeHead(404).end();
		}
	});
	return new Promise(resolve => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			const origin = "http://127.0.0.1:" + port;
			resolve({
				url: path => origin + "/" + String(path).replace(/^\//, ""),
				// a page whose <title> is exactly what the caller asked for, which is what
				// the default filename template is built from
				titledURL: title => origin + TITLED_PATH + "?title=" + encodeURIComponent(title),
				noContentURL: () => origin + NO_CONTENT_PATH,
				close: () => new Promise(done => server.close(done))
			});
		});
	});
}
