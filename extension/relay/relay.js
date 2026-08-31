// The relay is a throwaway extension installed next to SingleFile. It exists so the
// harness can call SingleFile's public runtime.onMessageExternal API as a genuine
// external caller, without injecting anything into SingleFile itself.
//
// It long-polls the harness over HTTP rather than holding a WebSocket, because an MV3
// service worker can be terminated between commands and an in-flight fetch is the
// simplest thing that keeps it alive while work is pending.

const BRIDGE_URL = "__BRIDGE_URL__";
const IDLE_RESPONSE = 204;
const RESPONSE_TIMEOUT = 5000;

start();

async function start() {
	await post("ready", { id: chrome.runtime.id });
	for (;;) {
		let command;
		try {
			command = await poll();
		} catch {
			// the harness went away; stop quietly so the browser can shut down
			return;
		}
		if (command) {
			const result = await run(command);
			try {
				await post("result", result);
			} catch {
				return;
			}
		}
	}
}

async function poll() {
	const response = await fetch(BRIDGE_URL + "command");
	if (response.status == IDLE_RESPONSE) {
		return;
	}
	return response.json();
}

async function run({ id, targetId, message, expectResponse }) {
	try {
		const value = await sendExternal(targetId, message, expectResponse);
		return { id, ok: true, value: serializable(value) };
	} catch (error) {
		return { id, ok: false, error: String(error && error.message || error) };
	}
}

// SingleFile's save actions never answer: on Chromium the callback simply never fires, so
// waiting for one costs the full timeout on every single dispatch. Only wait when the
// caller actually wants a value back (capture-page); otherwise hand back as soon as the
// message is away and let the test wait for the observable outcome instead.
function sendExternal(targetId, message, expectResponse) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const done = value => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let returned;
		try {
			returned = chrome.runtime.sendMessage(targetId, message, response => {
				const error = chrome.runtime.lastError;
				done(error ? { noResponse: true, detail: error.message } : response);
			});
		} catch (error) {
			reject(error);
			return;
		}
		if (returned && typeof returned.then == "function") {
			returned.then(done, error => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			});
		}
		if (expectResponse) {
			setTimeout(() => done({ noResponse: true, detail: "timeout" }), RESPONSE_TIMEOUT);
		} else {
			done({ dispatched: true });
		}
	});
}

function serializable(value) {
	try {
		return JSON.parse(JSON.stringify(value === undefined ? null : value));
	} catch {
		return String(value);
	}
}

function post(path, body) {
	return fetch(BRIDGE_URL + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
}
