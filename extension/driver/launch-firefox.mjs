// Firefox speaks BiDi natively on --remote-debugging-port. Two things are easy to
// miss: -remote-allow-system-access (single dash) is what allows navigating to and
// evaluating in moz-extension: pages, and the moz-extension UUID is random per
// profile, so it has to be pinned in the profile before first launch.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectBiDi } from "./bidi.mjs";
import { freePort } from "./free-port.mjs";

const FIREFOX_CANDIDATES = [
	"/Applications/Firefox.app/Contents/MacOS/firefox",
	"/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
	"/usr/bin/firefox",
	"/usr/local/bin/firefox"
];
// any fixed value works; pinning it makes moz-extension: URLs predictable
const SINGLEFILE_UUID = "5e1f7f8a-3d5b-4c2e-9a41-0b6d2f8c1a37";

export { launchFirefox, SINGLEFILE_UUID };

async function launchFirefox({ singlefileId, downloadDir, headless = true }) {
	const binary = process.env.SF_FIREFOX_PATH || FIREFOX_CANDIDATES.find(exists);
	if (!binary) {
		throw new Error("Firefox not found, set SF_FIREFOX_PATH");
	}
	const profileDir = mkdtempSync(join(tmpdir(), "sf-fn-ff-"));
	mkdirSync(downloadDir, { recursive: true });
	writeFileSync(join(profileDir, "user.js"), [
		// pin the extension origin so the tests can build moz-extension: URLs
		prefLine("extensions.webextensions.uuids", JSON.stringify({ [singlefileId]: SINGLEFILE_UUID })),
		prefLine("browser.download.folderList", 2),
		prefLine("browser.download.dir", downloadDir),
		prefLine("browser.download.useDownloadDir", true),
		prefLine("browser.download.alwaysOpenPanel", false),
		prefLine("browser.helperApps.neverAsk.saveToDisk", "text/html,application/octet-stream,application/zip"),
		prefLine("browser.shell.checkDefaultBrowser", false),
		prefLine("datareporting.policy.dataSubmissionEnabled", false),
		prefLine("toolkit.telemetry.enabled", false),
		""
	].join("\n"));

	const port = await freePort();
	const args = [
		"--remote-debugging-port=" + port,
		// without this, navigate + evaluate on moz-extension: pages are refused
		"-remote-allow-system-access",
		"--profile", profileDir,
		// never join or disturb an already running Firefox
		"--no-remote",
		"--new-instance"
	];
	if (headless) {
		args.unshift("--headless");
	}
	const browserProcess = spawn(binary, args, {
		stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env, MOZ_NO_REMOTE: "1" }
	});
	let stderr = "";
	browserProcess.stderr.on("data", data => stderr = (stderr + data).slice(-4096));

	try {
		const session = await connectBiDi("ws://127.0.0.1:" + port + "/session", { timeout: 30000 });
		await session.send("session.new", { capabilities: {} });
		return { name: "firefox", session, close };
	} catch (error) {
		await close();
		throw new Error(error.message + (stderr ? "\nfirefox stderr: " + stderr : ""), { cause: error });
	}

	async function close() {
		if (browserProcess.exitCode === null) {
			const exited = new Promise(resolve => browserProcess.once("exit", resolve));
			browserProcess.kill("SIGKILL");
			await exited;
		}
		rmSync(profileDir, { recursive: true, force: true });
	}
}

function prefLine(name, value) {
	return "user_pref(" + JSON.stringify(name) + ", " + JSON.stringify(value) + ");";
}

function exists(path) {
	return existsSync(path);
}
