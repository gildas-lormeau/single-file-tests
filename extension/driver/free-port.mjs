import { createServer } from "node:net";

export { freePort };

// ask the OS for an unused port, so parallel runs never collide on a fixed one
function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}
