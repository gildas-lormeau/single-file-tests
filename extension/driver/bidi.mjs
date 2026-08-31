// Minimal WebDriver BiDi client. The protocol is one WebSocket carrying
// {id, method, params} commands and {type, id, result} replies, so a real client
// fits in this file and we avoid pulling in a full automation stack.

const DEFAULT_TIMEOUT = 15000;

export { connectBiDi };

async function connectBiDi(webSocketURL, { timeout = DEFAULT_TIMEOUT } = {}) {
	const socket = await openSocket(webSocketURL, timeout);
	const pending = new Map();
	const listeners = new Map();
	let nextId = 1;
	let closed;
	socket.addEventListener("close", () => {
		closed = new Error("BiDi socket closed");
		pending.forEach(({ reject }) => reject(closed));
		pending.clear();
	});
	socket.addEventListener("message", event => {
		const message = JSON.parse(event.data);
		if (message.id !== undefined && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.type == "success") {
				resolve(message.result);
			} else {
				reject(new Error(message.error + ": " + message.message));
			}
		} else if (message.type == "event") {
			const handlers = listeners.get(message.method);
			if (handlers) {
				handlers.forEach(handler => handler(message.params));
			}
		}
	});
	return { send, on, subscribe, close };

	function send(method, params = {}, commandTimeout = timeout) {
		if (closed) {
			return Promise.reject(closed);
		}
		const id = nextId++;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(method + " timed out after " + commandTimeout + "ms"));
			}, commandTimeout);
			pending.set(id, {
				resolve: value => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: error => {
					clearTimeout(timer);
					reject(error);
				}
			});
		});
	}

	function on(eventName, handler) {
		if (!listeners.has(eventName)) {
			listeners.set(eventName, []);
		}
		listeners.get(eventName).push(handler);
	}

	async function subscribe(events) {
		await send("session.subscribe", { events });
	}

	function close() {
		try {
			socket.close();
		} catch {
			// already gone
		}
	}
}

async function openSocket(webSocketURL, timeout) {
	const deadline = Date.now() + timeout;
	let lastError;
	while (Date.now() < deadline) {
		const socket = new WebSocket(webSocketURL);
		const opened = await new Promise(resolve => {
			const timer = setTimeout(() => resolve(false), 500);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				resolve(true);
			});
			socket.addEventListener("error", error => {
				clearTimeout(timer);
				lastError = error;
				resolve(false);
			});
		});
		if (opened) {
			return socket;
		}
		try {
			socket.close();
		} catch {
			// never opened
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error("could not open " + webSocketURL + (lastError ? " (" + lastError.type + ")" : ""));
}
