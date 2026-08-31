/* eslint-disable no-console */

// Runner for the functional extension suite. The browser matrix lives here so specs
// never mention a browser: each spec receives a session and runs unchanged on both.
//
//   node extension/run.mjs                    both browsers, every spec
//   node extension/run.mjs --browser=firefox  one browser
//   node extension/run.mjs --spec=save-page   one spec
//   node extension/run.mjs --headful          watch it happen

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openSession, BROWSERS } from "./driver/session.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const SPECS_DIR = fileURLToPath(new URL("./specs", import.meta.url));

const options = parseArguments(process.argv.slice(2));
const browsers = options.browser ? [options.browser] : BROWSERS;
let failures = 0;
let passes = 0;
let known = 0;

const fixtures = await startFixtureServer();
try {
	for (const browserName of browsers) {
		await runBrowser(browserName);
	}
} finally {
	await fixtures.close();
}
console.log("\n" + (failures ? "FAILED" : "PASSED") + " (" + passes + " passed, " + failures + " failed"
	+ (known ? ", " + known + " known" : "") + ")");
process.exit(failures ? 1 : 0);

async function runBrowser(browserName) {
	console.log("\n=== " + browserName + " ===");
	let session;
	try {
		session = await openSession(browserName, { headless: !options.headful });
	} catch (error) {
		failures++;
		console.log("FAIL [" + browserName + "] could not open a session: " + error.message);
		return;
	}
	try {
		for (const specName of listSpecs()) {
			const spec = await import(new URL("./specs/" + specName, import.meta.url));
			console.log("-- " + spec.name + " (level " + spec.level + ")");
			try {
				await spec.run({ session, fixtures, test });
			} catch (error) {
				failures++;
				console.log("FAIL [" + browserName + "] " + spec.name + " aborted: " + error.message);
			}
		}
	} finally {
		await session.close();
	}
}

// A spec reports a failure by returning a reason; returning nothing means it passed.
//
// A test may be marked `known`, meaning it asserts the behaviour SingleFile should have
// and documents the defect that stops it. Failing then reports KNOWN and does not make
// the run red. Passing does, because a known failure that starts passing means the defect
// is fixed and the marker is now lying about the code.
async function test(label, body, { known: knownReason } = {}) {
	const started = Date.now();
	let problem;
	try {
		problem = await body();
	} catch (error) {
		problem = error.message;
	}
	const elapsed = Math.round((Date.now() - started) / 100) / 10 + "s";
	if (problem && knownReason) {
		known++;
		console.log("  KNOWN " + label + " (" + elapsed + ")\n        " + problem + "\n        known: " + knownReason);
	} else if (problem) {
		failures++;
		console.log("  FAIL " + label + " (" + elapsed + ")\n        " + problem);
	} else if (knownReason) {
		failures++;
		console.log("  FAIL " + label + " (" + elapsed + ")\n        this is marked known but passed; drop the marker: "
			+ knownReason);
	} else {
		passes++;
		console.log("  PASS " + label + " (" + elapsed + ")");
	}
}

function listSpecs() {
	return readdirSync(SPECS_DIR)
		.filter(name => name.endsWith(".spec.mjs"))
		.filter(name => !options.spec || name.startsWith(options.spec))
		.sort();
}

function parseArguments(argv) {
	const parsed = { headful: false };
	argv.forEach(argument => {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
		if (match) {
			parsed[match[1]] = match[2] === undefined ? true : match[2];
		}
	});
	return parsed;
}
