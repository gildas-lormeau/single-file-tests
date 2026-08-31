import { existsSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { fixtureURL, fixturePath } from "../lib/fixtures-def.js";

// Closes the loop between the two suites. Everything else here checks archives built by
// compression.js in Node; these check archives a real *extension* saved in a real
// browser, and that they self-extract in every engine.
//
// The artifacts are written by extension/specs/archive.spec.mjs. They are absent until
// that suite has run, so these tests skip rather than fail — the two suites are run
// separately and neither should break the other.

const MARKER_TEXT = "FUNCTIONAL_FIXTURE_MARKER";
const BROWSERS = ["chromium", "firefox"];

for (const savedBy of BROWSERS) {
	const name = `extension-saved-${savedBy}.html`;

	test(`archive saved by the ${savedBy} extension self-extracts`, async ({ page }) => {
		test.skip(!existsSync(fixturePath(name)), `run the extension suite first to produce ${name}`);
		await page.goto(fixtureURL(name));
		await expect(page.locator("#marker")).toHaveText(MARKER_TEXT);
		expect(await page.evaluate(() => document.compatMode)).toBe("CSS1Compat");
	});

	test(`archive saved by the ${savedBy} extension keeps its inlined stylesheet`, async ({ page }) => {
		test.skip(!existsSync(fixturePath(name)), `run the extension suite first to produce ${name}`);
		await page.goto(fixtureURL(name));
		// extraction is asynchronous, so assert on the locator rather than reading the
		// computed style once; toHaveCSS retries until the element exists
		await expect(page.locator(".styled")).toHaveCSS("color", "rgb(17, 85, 204)");
	});
}
