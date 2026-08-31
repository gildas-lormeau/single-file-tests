// The parser-mangling model that compression.js relies on: this is the
// assumption under test. A browser disagreeing with mangle() breaks extraction.

const WINDOWS_1252_SPECIALS = new Map([
	[128, 8364], [130, 8218], [131, 402], [132, 8222], [133, 8230], [134, 8224], [135, 8225], [136, 710], [137, 8240],
	[138, 352], [139, 8249], [140, 338], [142, 381], [145, 8216], [146, 8217], [147, 8220], [148, 8221], [149, 8226],
	[150, 8211], [151, 8212], [152, 732], [153, 8482], [154, 353], [155, 8250], [156, 339], [158, 382], [159, 376]
]);

export const WINDOWS_1252_MAP = new Array(256).fill(0).map((_, byte) => WINDOWS_1252_SPECIALS.get(byte) ?? byte);

// byte stream -> DOM text content, per the model: windows-1252 decoding,
// NUL -> U+FFFD, CR and CRLF -> LF (input stream normalization)
export function mangle(bytes) {
	let text = "";
	for (let index = 0; index < bytes.length; index++) {
		const byte = bytes[index];
		if (byte === 0) {
			text += "�";
		} else if (byte === 13) {
			text += "\n";
			if (bytes[index + 1] === 10) {
				index++;
			}
		} else {
			text += String.fromCharCode(WINDOWS_1252_MAP[byte]);
		}
	}
	return text;
}
