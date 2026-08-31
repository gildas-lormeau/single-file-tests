import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./format/specs",
	timeout: 60000,
	expect: { timeout: 15000 },
	fullyParallel: true,
	globalSetup: "./format/setup/global-setup.js",
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } }
	]
});
