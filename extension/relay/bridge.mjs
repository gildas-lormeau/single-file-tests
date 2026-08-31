// Node side of the relay. A plain HTTP server on loopback: the relay long-polls
// GET /command, the harness queues commands, the relay POSTs /result. No dependency,
// and nothing here is reachable from outside the machine.

import { createServer } from "node:http";

const POLL_HOLD = 20000;
const READY_TIMEOUT = 30000;
const DISPATCH_TIMEOUT = 60000;

export { startBridge };

function startBridge() {
	const queued = [];
	const waiting = [];
	const pending = new Map();
	let nextId = 1;
	let relayReady;
	const ready = new Promise(resolve => relayReady = resolve);

	const server = createServer((request, response) => {
		const url = new URL(request.url, "http://127.0.0.1");
		if (request.method == "GET" && url.pathname == "/command") {
			handOutCommand(response);
		} else if (request.method == "POST" && url.pathname == "/result") {
			readBody(request).then(body => {
				settle(body);
				respond(response, 200, { ok: true });
			});
		} else if (request.method == "POST" && url.pathname == "/ready") {
			readBody(request).then(body => {
				relayReady(body);
				respond(response, 200, { ok: true });
			});
		} else {
			respond(response, 404, { error: "not found" });
		}
	});

	return new Promise(resolve => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				url: "http://127.0.0.1:" + port + "/",
				dispatch,
				waitForRelay,
				close
			});
		});
	});

	function handOutCommand(response) {
		if (queued.length) {
			respond(response, 200, queued.shift());
			return;
		}
		// hold the request open so a command reaches the relay without polling churn
		const holder = { response, timer: undefined };
		holder.timer = setTimeout(() => {
			const index = waiting.indexOf(holder);
			if (index != -1) {
				waiting.splice(index, 1);
			}
			respond(response, 204, null);
		}, POLL_HOLD);
		waiting.push(holder);
	}

	function dispatch(targetId, message, expectResponse, responseTimeout) {
		const id = nextId++;
		const command = { id, targetId, message, expectResponse, responseTimeout };
		const holder = waiting.shift();
		if (holder) {
			clearTimeout(holder.timer);
			respond(holder.response, 200, command);
		} else {
			queued.push(command);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("relay did not answer " + JSON.stringify(message).slice(0, 80)));
			}, DISPATCH_TIMEOUT);
			pending.set(id, { resolve, reject, timer });
		});
	}

	function settle(body) {
		const entry = body && pending.get(body.id);
		if (!entry) {
			return;
		}
		pending.delete(body.id);
		clearTimeout(entry.timer);
		if (body.ok) {
			entry.resolve(body.value);
		} else {
			entry.reject(new Error("SingleFile rejected the message: " + body.error));
		}
	}

	async function waitForRelay() {
		const timeout = new Promise((resolve, reject) =>
			setTimeout(() => reject(new Error("the relay extension never reported ready")), READY_TIMEOUT));
		return Promise.race([ready, timeout]);
	}

	function close() {
		waiting.forEach(holder => {
			clearTimeout(holder.timer);
			respond(holder.response, 204, null);
		});
		waiting.length = 0;
		pending.forEach(entry => {
			clearTimeout(entry.timer);
			entry.reject(new Error("bridge closed"));
		});
		pending.clear();
		return new Promise(resolve => server.close(resolve));
	}
}

function respond(response, status, body) {
	if (body === null) {
		response.writeHead(status).end();
		return;
	}
	const payload = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
	response.end(payload);
}

function readBody(request) {
	return new Promise(resolve => {
		let body = "";
		request.on("data", chunk => body += chunk);
		request.on("end", () => {
			try {
				resolve(JSON.parse(body));
			} catch {
				resolve(null);
			}
		});
	});
}
