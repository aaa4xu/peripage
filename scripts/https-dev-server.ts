import { createServer, type Server } from 'node:https';
import type { Socket } from 'node:net';
import path from 'node:path';
import { getCertificate } from '@vitejs/plugin-basic-ssl';
import type { Plugin } from 'vite';

/** Serve the same Vite middleware and HMR over a second, TLS-enabled port. */
export function httpsDevServer(port = 5174): Plugin {
	let https: Server | undefined;
	const sockets = new Set<Socket>();
	return {
		name: 'https-dev-server',
		apply: (_config, { command, mode, isPreview }) =>
			command === 'serve' && mode !== 'test' && !isPreview,
		config: () => ({ server: { port: 5173, strictPort: true } }),
		async configureServer(vite) {
			const http = vite.httpServer;
			if (!http) return;
			const certificate = await getCertificate(path.join(vite.config.cacheDir, 'basic-ssl'));
			const server = createServer({ key: certificate, cert: certificate }, vite.middlewares);
			https = server;
			// Keep Vite's host/token checks and share its existing WebSocket clients.
			server.on('upgrade', (request, socket, head) => {
				http.emit('upgrade', request, socket, head);
			});
			server.on('connection', (socket) => {
				sockets.add(socket);
				socket.once('close', () => sockets.delete(socket));
			});
			// Vite prepares the new instance before closing the old one on restart.
			// Bind only when it starts listening, after the old HTTPS port is released.
			const listen = vite.listen;
			vite.listen = async (...args) => {
				await listen(...args);
				const address = http.address();
				if (!address || typeof address === 'string') throw new Error('Expected a TCP dev server');
				try {
					await new Promise<void>((resolve, reject) => {
						server.once('error', reject);
						server.listen(port, address.address, () => {
							server.off('error', reject);
							resolve();
						});
					});
				} catch (error) {
					await vite.close();
					throw error;
				}
				return vite;
			};
			const printUrls = vite.printUrls;
			vite.printUrls = () => {
				printUrls();
				for (const address of [
					...(vite.resolvedUrls?.local ?? []),
					...(vite.resolvedUrls?.network ?? [])
				]) {
					const url = new URL(address);
					url.protocol = 'https:';
					url.port = String(port);
					vite.config.logger.info(`  ➜  HTTPS:   ${url.href}`);
				}
			};
		},
		async closeServer() {
			const server = https;
			https = undefined;
			if (!server) return;
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
				sockets.clear();
			});
		}
	};
}
