import js from "@eslint/js";

export default [
	{
		ignores: [
			"fixtures/**",
			"test-results/**",
			"playwright-report/**",
			"extension/fixtures/pages/**"
		]
	},
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2025,
			sourceType: "module",
			globals: {
				console: "readonly",
				process: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				fetch: "readonly",
				WebSocket: "readonly",
				URL: "readonly",
				Buffer: "readonly",
				AbortSignal: "readonly"
			}
		},
		rules: {
			"indent": ["error", "tab"],
			"linebreak-style": ["error", "unix"],
			"quotes": ["error", "double"],
			"semi": ["error", "always"],
			"no-console": ["warn"]
		}
	},
	{
		// the bodies passed to page.evaluate() run in the browser, not in Node
		files: ["format/specs/**"],
		languageOptions: {
			globals: {
				document: "readonly",
				getComputedStyle: "readonly",
				window: "readonly"
			}
		}
	},
	{
		// the relay runs inside the browser, not in Node
		files: ["extension/relay/relay.js"],
		languageOptions: {
			globals: {
				chrome: "readonly",
				fetch: "readonly",
				setTimeout: "readonly"
			}
		}
	}
];
