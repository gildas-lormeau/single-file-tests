import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import {
	fixtureURL, fixturePath, MARKER_TEXT,
	ARCHIVE_FIXTURES, WRAPPER_LADDER, wrapperRungOf, unusableRungs, cheapestUsableRung
} from "../lib/fixtures-def.js";

// End-to-end: archives built by the real process() must self-extract from
// file:// (the path where fetching the page is blocked) in every engine,
// and hand standards mode to the displayed page.
//
// The container assertions below check the rule rather than a remembered tag name: the
// writer must never pick a container the payload can close, and having ruled those out it
// must take the cheapest one left. Naming the expected tag instead is what let these tests
// rot — they asked for <noscript>, a rung single-file-core does not even have.

for (const { name, payload } of ARCHIVE_FIXTURES) {
	test(`${name} self-extracts`, async ({ page }) => {
		await page.goto(fixtureURL(name));
		await expect(page.locator("#marker")).toHaveText(MARKER_TEXT);
		expect(await page.evaluate(() => document.compatMode)).toBe("CSS1Compat");
	});

	test(`${name} hides its data in a container the payload cannot close`, () => {
		const { rung, tail } = wrapperRungOf(readFileSync(fixturePath(name)));
		expect(rung, `unrecognised container before the zip data: ${JSON.stringify(tail.slice(-70))}`)
			.toBeDefined();
		expect(unusableRungs(payload)).not.toContain(rung);
	});

	test(`${name} takes the cheapest container left to it`, () => {
		const { rung, tail } = wrapperRungOf(readFileSync(fixturePath(name)));
		expect(rung, `container tail: ${JSON.stringify(tail.slice(-70))}`)
			.toBe(cheapestUsableRung(payload));
	});
}

test("every rung the ladder knows about is closed by its own terminator", () => {
	// guards the table itself: a rung whose closedBy does not match its tag would silently
	// make the two tests above pass for the wrong reason
	for (const { name, detect, closedBy } of WRAPPER_LADDER) {
		if (name == "plaintext") {
			expect(closedBy).toEqual([]);
		} else if (detect.startsWith("<!--") || detect.startsWith("<![CDATA[")) {
			expect(closedBy.length).toBeGreaterThan(0);
		} else {
			expect(closedBy.some(token => token.includes(name))).toBe(true);
		}
	}
});
