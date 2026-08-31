import { test, expect } from "@playwright/test";
import { mangle } from "../lib/model.js";
import { PAYLOADS, CONTAINERS, parserFixtureName, fixtureURL, TERMINATOR_FIXTURES } from "../lib/fixtures-def.js";

// Asserts that each browser mangles bytes exactly as the writer's model
// predicts: windows-1252 decoding, NUL -> U+FFFD, CR/CRLF -> LF, and nothing else.

for (const container of CONTAINERS) {
	for (const [payloadName, payload] of Object.entries(PAYLOADS)) {
		test(`${container} container preserves the model for ${payloadName}`, async ({ page }) => {
			await page.goto(fixtureURL(parserFixtureName(container, payloadName)));
			const actual = await page.evaluate(containerText, container);
			expect(actual).toBe(mangle(payload));
		});
	}
}

for (const fixture of TERMINATOR_FIXTURES) {
	test(`terminator behavior: ${fixture.name}`, async ({ page }) => {
		await page.goto(fixtureURL(fixture.name));
		if (fixture.check.commentAfter) {
			const data = await page.evaluate(id => document.getElementById(id).nextSibling.data, fixture.check.commentAfter);
			expect(data).toBe(fixture.check.expected);
		}
		if (fixture.check.styleText) {
			const text = await page.evaluate(() => document.getElementById("payload").textContent);
			expect(text).toBe(fixture.check.styleText);
		}
		if (fixture.check.compatMode) {
			const mode = await page.evaluate(() => document.compatMode);
			expect(mode).toBe(fixture.check.compatMode);
		}
	});
}

function containerText(container) {
	if (container === "comment") {
		return document.getElementById("start").nextSibling.data;
	} else if (container === "style") {
		return document.getElementById("payload").textContent;
	} else {
		return document.querySelector("plaintext").textContent;
	}
}
