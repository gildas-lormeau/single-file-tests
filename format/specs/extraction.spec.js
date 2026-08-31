import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { fixtureURL, fixturePath, MARKER_TEXT } from "../lib/fixtures-def.js";

// End-to-end: archives built by the real process() must self-extract from
// file:// (the path where fetching the page is blocked) in every engine,
// and hand standards mode to the displayed page.

const CASES = [
	{ name: "archive-base.html", wrapper: null },
	{ name: "archive-fallback-tag.html", wrapper: "<noscript>" },
	{ name: "archive-plaintext.html", wrapper: "<plaintext>" }
];

for (const { name, wrapper } of CASES) {
	test(`${name} self-extracts`, async ({ page }) => {
		await page.goto(fixtureURL(name));
		await expect(page.locator("#marker")).toHaveText(MARKER_TEXT);
		expect(await page.evaluate(() => document.compatMode)).toBe("CSS1Compat");
	});

	if (wrapper) {
		test(`${name} selected the expected wrapper`, () => {
			const content = readFileSync(fixturePath(name), "latin1");
			expect(content.includes(wrapper)).toBe(true);
		});
	}
}
