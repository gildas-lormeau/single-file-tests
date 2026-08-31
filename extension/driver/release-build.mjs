// Unpacks the zip that build-extension.sh produces, so the suite can test the artifact
// that actually ships rather than the working tree next to it.
//
// The two differ in ways that matter. The Edge and Chromium packages are built from
// patched sources, the packaging step is where the Woleet key is injected, and the zip
// contains only the files listed in build-extension.sh — a file present in the checkout
// but missing from that list works in every test and is absent from the release.
//
// The unpacked copy carries the real Woleet API key when one was injected. It lives in a
// temp directory and is removed when the session closes; do not copy it anywhere.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export { unpackRelease, RELEASE_PACKAGES };

const RELEASE_PACKAGES = {
	firefox: { directory: "single-file", zip: "singlefile-extension-firefox.zip" },
	chromium: { directory: "single-file-mv3", zip: "singlefile-extension-chromium.zip" }
};
// The hand-edited inputs, deliberately not lib/, which build-extension.sh regenerates
// after packaging and which would therefore always look newer than the zip.
const SOURCE_DIRECTORIES = ["src", "_locales"];
// A build touches its own inputs while it runs: the MV3 script patches config.js and
// manifest.json for the Edge package and moves the originals back afterwards, which dates
// them after the Chromium zip. Rather than hard-code which files a build script happens to
// restore, ignore anything that changed around the time of the build itself. Wide enough
// for npm ci and two rollup passes, tight enough that a rebuild forgotten since the last
// work session still shows up.
const BUILD_WINDOW = 15 * 60 * 1000;

function unpackRelease(browserName, repoRoot) {
	const { directory, zip } = RELEASE_PACKAGES[browserName];
	const packageRoot = join(repoRoot, directory);
	const zipPath = join(packageRoot, zip);
	if (!existsSync(zipPath)) {
		throw new Error("no release package at " + zipPath + " — run ./build-extension.sh in " + directory + " first");
	}
	const staleness = describeStaleness(zipPath, packageRoot);
	registerCleanup();
	const target = mkdtempSync(join(tmpdir(), "sf-release-" + browserName + "-"));
	try {
		execFileSync("unzip", ["-q", zipPath, "-d", target]);
	} catch (error) {
		rmSync(target, { recursive: true, force: true });
		throw new Error("could not unpack " + zipPath + ": " + error.message, { cause: error });
	}
	if (!existsSync(join(target, "manifest.json"))) {
		rmSync(target, { recursive: true, force: true });
		throw new Error(zipPath + " has no manifest.json at its root");
	}
	unpacked.add(target);
	return { path: target, zipPath, staleness, dispose: () => dispose(target) };
}

// The unpacked copy holds the injected Woleet key, so it must not survive the process
// even when the process does not end the way it meant to — an interrupted run, a pipe
// closing early, a spec throwing past the session teardown.
const unpacked = new Set();
let cleanupRegistered = false;

function dispose(target) {
	rmSync(target, { recursive: true, force: true });
	unpacked.delete(target);
}

function registerCleanup() {
	if (cleanupRegistered) {
		return;
	}
	cleanupRegistered = true;
	process.on("exit", () => unpacked.forEach(target => rmSync(target, { recursive: true, force: true })));
	["SIGINT", "SIGTERM", "SIGHUP"].forEach(signal => process.on(signal, () => {
		unpacked.forEach(target => rmSync(target, { recursive: true, force: true }));
		process.exit(1);
	}));
}

// A release gate that silently tests last week's package is worse than no gate, so say so
// when the sources have moved since the package was built. It is a warning rather than an
// error: testing an older package on purpose is a legitimate thing to want.
function describeStaleness(zipPath, packageRoot) {
	const builtAt = statSync(zipPath).mtimeMs;
	let newest = 0;
	let newestPath;
	SOURCE_DIRECTORIES.forEach(name => {
		const directory = join(packageRoot, name);
		if (existsSync(directory)) {
			walk(directory);
		}
	});
	return newest > builtAt + BUILD_WINDOW
		? "built " + Math.round((newest - builtAt) / 60000) + " minutes before the last change to " + newestPath
		: undefined;

	function walk(directory) {
		readdirSync(directory, { withFileTypes: true }).forEach(entry => {
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(entryPath);
			} else {
				const { mtimeMs } = statSync(entryPath);
				if (mtimeMs > newest) {
					newest = mtimeMs;
					newestPath = entryPath;
				}
			}
		});
	}
}
