/* eslint-disable no-console */

// Runner for the functional extension suite. The browser matrix lives here so specs
// never mention a browser: each spec receives a session and runs unchanged on both.
//
//   node extension/run.mjs                    both browsers, every spec
//   node extension/run.mjs --browser=firefox  one browser
//   node extension/run.mjs --spec=save-page   one spec
//   node extension/run.mjs --shard=2/3        the second of three groups of specs
//   node extension/run.mjs --headful          watch it happen
//   node extension/run.mjs --release          test the packaged build, not the working tree

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openSession, BROWSERS } from "./driver/session.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const SPECS_DIR = fileURLToPath(new URL("./specs", import.meta.url));

// Rough duration of the slow specs, in seconds, measured on a CI runner. It only serves
// to split the specs into groups of similar length for --shard: a wrong or missing
// figure makes a group slower, it never drops a spec. Add a spec here when it takes
// more than about 15 seconds.
const SPEC_WEIGHTS = {
	"autosave": 120,
	"archive-builder": 64,
	"autosave-navigation": 44,
	"tabs-archive": 41,
	"options": 34,
	"filename": 20,
	"autosave-discard": 18
};
const DEFAULT_SPEC_WEIGHT = 8;

const options = parseArguments(process.argv.slice(2));
const browsers = options.browser ? [options.browser] : BROWSERS;
const specNames = selectSpecs();
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
		session = await openSession(browserName, { headless: !options.headful, release: Boolean(options.release) });
	} catch (error) {
		failures++;
		console.log("FAIL [" + browserName + "] could not open a session: " + error.message);
		return;
	}
	// say which build was graded: a run that is going to gate a release is a record, and
	// "it passed" means nothing without this line
	console.log("   testing " + (session.releaseZip || session.extensionPath));
	if (session.releaseStaleness) {
		console.log("   WARNING this package is stale: " + session.releaseStaleness);
	}
	try {
		for (const specName of specNames) {
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

// --shard=i/n keeps one group out of n, so that n runs started with i from 1 to n cover
// every spec exactly once. The CI workflows of the extensions use it to run the suite on
// several machines at the same time. The groups are built by handing the specs out from
// the slowest to the fastest, each one to the group that is the shortest so far, which
// gives the same groups on every machine. A group runs its specs in the usual order.
function selectSpecs() {
	const names = listSpecs();
	if (options.shard === undefined) {
		return names;
	}
	const match = /^(\d+)\/(\d+)$/.exec(options.shard);
	const index = match && Number(match[1]);
	const count = match && Number(match[2]);
	if (!match || index < 1 || index > count) {
		console.log("FAILED: --shard expects i/n with 1 <= i <= n, got " + options.shard);
		process.exit(1);
	}
	const weight = name => SPEC_WEIGHTS[name.replace(/\.spec\.mjs$/, "")] || DEFAULT_SPEC_WEIGHT;
	const groups = Array.from({ length: count }, () => ({ names: [], weight: 0 }));
	[...names].sort((first, second) => weight(second) - weight(first) || (first < second ? -1 : 1)).forEach(name => {
		const group = groups.reduce((shortest, candidate) => candidate.weight < shortest.weight ? candidate : shortest);
		group.names.push(name);
		group.weight += weight(name);
	});
	const selected = groups[index - 1].names.sort();
	console.log("shard " + options.shard + ": " + selected.map(name => name.replace(/\.spec\.mjs$/, "")).join(", "));
	return selected;
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
