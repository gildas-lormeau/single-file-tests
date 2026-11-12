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

// An MV3 service worker is stopped after 30 seconds without an extension event or API call,
// and a fetch that is waiting does not count: a spec that sent nothing for that long came
// back to a relay that was gone, and every later dispatch timed out. The bridge holds a
// poll for 20 seconds at most, so one API call per poll keeps the worker alive.
async function poll() {
	chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
	const response = await fetch(BRIDGE_URL + "command");
	if (response.status == IDLE_RESPONSE) {
		return;
	}
	return response.json();
}

async function run({ id, targetId, message, expectResponse, responseTimeout }) {
	try {
		const value = await sendExternal(targetId, message, expectResponse, responseTimeout);
		return { id, ok: true, value: serializable(value) };
	} catch (error) {
		return { id, ok: false, error: String(error && error.message || error) };
	}
}

// Only wait when the caller actually wants a value back (capture-page); otherwise hand
// back as soon as the message is away and let the test wait for the observable outcome.
//
// That is the right shape for a save regardless, but be aware it also steps around a
// defect: SingleFile's Chromium polyfill returns true from its onMessage/onMessageExternal
// wrappers, promising an async response, then skips sendResponse when the handler resolves
// with undefined or rejects. The save actions resolve with undefined, so on Chromium a
// waiting caller gets no answer at all and burns its whole timeout. Do not "fix" this by
// waiting again — the fix belongs in chrome-browser-polyfill.js.
function sendExternal(targetId, message, expectResponse, responseTimeout) {
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
			setTimeout(() => done({ noResponse: true, detail: "timeout" }), responseTimeout || RESPONSE_TIMEOUT);
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
