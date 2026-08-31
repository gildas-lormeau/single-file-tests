// Chrome has no built-in BiDi endpoint, so chromedriver provides one: asking for
// webSocketUrl:true in the capabilities returns a BiDi socket that speaks exactly the
// same commands as Firefox's. webExtension.install additionally needs
// --enable-unsafe-extension-debugging and --remote-debugging-pipe.

import { execFileSync, spawn } from "node:child_process";
import { guardProcess, releaseProcess, guardDirectory, releaseDirectory } from "./process-guard.mjs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { connectBiDi } from "./bidi.mjs";
import { freePort } from "./free-port.mjs";

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium"
];

export { launchChromium };

async function launchChromium({ downloadDir, headless = true }) {
	const binary = process.env.SF_CHROME_PATH || findChrome();
	const driverBinary = process.env.SF_CHROMEDRIVER_PATH || findChromedriver(binary);
	if (!binary) {
		throw new Error("Chrome not found, set SF_CHROME_PATH");
	}
	if (!driverBinary) {
		throw new Error("chromedriver not found, set SF_CHROMEDRIVER_PATH");
	}
	const userDataDir = mkdtempSync(join(tmpdir(), "sf-fn-cr-"));
	mkdirSync(downloadDir, { recursive: true });
	// chromedriver does not expose a download-directory capability, so preseed the profile
	mkdirSync(join(userDataDir, "Default"), { recursive: true });
	writeFileSync(join(userDataDir, "Default", "Preferences"), JSON.stringify({
		download: { default_directory: downloadDir, prompt_for_download: false },
		profile: { default_content_setting_values: { automatic_downloads: 1 } }
	}));

	const port = await freePort();
	const driverProcess = spawn(driverBinary, ["--port=" + port, "--allowed-ips="], { stdio: ["ignore", "pipe", "pipe"] });
	// chromedriver owns the browser process, so killing it takes the whole Chrome tree with it
	guardProcess(driverProcess);
	guardDirectory(userDataDir);
	let driverLog = "";
	driverProcess.stdout.on("data", data => driverLog = (driverLog + data).slice(-4096));
	driverProcess.stderr.on("data", data => driverLog = (driverLog + data).slice(-4096));

	const args = [
		"--enable-unsafe-extension-debugging",
		"--remote-debugging-pipe",
		"--user-data-dir=" + userDataDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding"
	];
	if (headless) {
		args.unshift("--headless=new");
	}
	if (process.env.CI) {
		args.unshift("--no-sandbox", "--disable-dev-shm-usage");
	}

	let sessionId;
	try {
		const created = await createSession(port, binary, args);
		sessionId = created.sessionId;
		const session = await connectBiDi(created.webSocketUrl, { timeout: 30000 });
		return { name: "chromium", session, close };
	} catch (error) {
		await close();
		throw new Error(error.message + (driverLog ? "\nchromedriver: " + driverLog.slice(-800) : ""), { cause: error });
	}

	// chromedriver owns the browser process, so deleting the session is the only thing
	// that closes Chrome; killing chromedriver first orphans the whole process tree
	async function close() {
		if (sessionId) {
			await fetch("http://127.0.0.1:" + port + "/session/" + sessionId, {
				method: "DELETE",
				signal: AbortSignal.timeout(10000)
			}).catch(() => undefined);
			sessionId = undefined;
		}
		if (driverProcess.exitCode === null) {
			const exited = new Promise(resolve => driverProcess.once("exit", resolve));
			driverProcess.kill("SIGTERM");
			const killer = setTimeout(() => driverProcess.kill("SIGKILL"), 3000);
			await exited;
			clearTimeout(killer);
		}
		releaseProcess(driverProcess);
		releaseDirectory(userDataDir);
	}
}

async function createSession(port, binary, args) {
	const deadline = Date.now() + 30000;
	let lastBody;
	while (Date.now() < deadline) {
		try {
			const response = await fetch("http://127.0.0.1:" + port + "/session", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					capabilities: {
						alwaysMatch: {
							browserName: "chrome",
							webSocketUrl: true,
							"goog:chromeOptions": { binary, args }
						}
					}
				})
			});
			const body = await response.json();
			if (body.value && body.value.capabilities && body.value.capabilities.webSocketUrl) {
				return { sessionId: body.value.sessionId, webSocketUrl: body.value.capabilities.webSocketUrl };
			}
			lastBody = body;
			break;
		} catch {
			await new Promise(resolve => setTimeout(resolve, 300));
		}
	}
	throw new Error("chromedriver refused the BiDi session: " + JSON.stringify(lastBody).slice(0, 500));
}

function findChrome() {
	return CHROME_CANDIDATES.find(path => existsSync(path));
}

function findChromedriver(chromeBinary) {
	const roots = [
		join(homedir(), ".cache", "selenium", "chromedriver"),
		join(homedir(), ".cache", "puppeteer", "chromedriver")
	];
	const found = [];
	roots.forEach(root => collectChromedrivers(root, 0, found));
	if (!found.length) {
		return;
	}
	// the cache holds several versions and their paths do not sort by version, so rank
	// them numerically and prefer the one whose major matches the browser
	const chromeMajor = majorVersion(browserVersion(chromeBinary));
	const ranked = found
		.map(path => ({ path, version: versionOf(path) }))
		.sort((left, right) => compareVersions(right.version, left.version));
	const matching = ranked.find(entry => majorVersion(entry.version.join(".")) == chromeMajor);
	return (matching || ranked[0]).path;
}

function browserVersion(binary) {
	try {
		return execFileSync(binary, ["--version"], { encoding: "utf8" });
	} catch {
		return "";
	}
}

function majorVersion(text) {
	const match = /(\d+)\./.exec(String(text));
	return match ? Number(match[1]) : undefined;
}

function versionOf(path) {
	const match = /(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(path);
	return match ? match.slice(1).map(Number) : [0, 0, 0, 0];
}

function compareVersions(left, right) {
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] || 0) - (right[index] || 0);
		if (difference) {
			return difference;
		}
	}
	return 0;
}

function collectChromedrivers(root, depth, found) {
	if (depth > 4) {
		return;
	}
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	entries.forEach(entry => {
		const entryPath = join(root, entry.name);
		if (entry.isFile() && entry.name == "chromedriver") {
			found.push(entryPath);
		} else if (entry.isDirectory()) {
			collectChromedrivers(entryPath, depth + 1, found);
		}
	});
}
