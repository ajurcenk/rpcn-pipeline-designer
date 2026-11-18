import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { freePort, isMetricsReadError, localMetricsSource, MetricsReadError } from '../../../adapters/metrics/source';

// Ticket 7.2 (AD-25): the local source against a local HTTP server, and the port helper.
const BODY = [
	'# TYPE input_received counter',
	'input_received{label="",path="root.input"} 197',
	'# TYPE processor_latency_ns summary',
	'processor_latency_ns{label="fast",path="root.pipeline.processors.0",quantile="0.5"} 2426',
	'',
].join('\n');

/** A server on 127.0.0.1 answering every request with `handler`; resolves with its port. */
async function serve(handler: http.RequestListener): Promise<{ readonly port: number; close(): Promise<void>; readonly paths: string[] }> {
	const paths: string[] = [];
	const server = http.createServer((req, res) => {
		paths.push(req.url ?? '');
		handler(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as net.AddressInfo).port;
	return { port, paths, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

async function readError(promise: Promise<unknown>): Promise<{ kind: string; message: string; noSeries?: true }> {
	try {
		await promise;
	} catch (err) {
		assert.ok(isMetricsReadError(err), String(err));
		return err;
	}
	assert.fail('the read resolved');
}

suite('adapters/metrics source', () => {
	test('freePort: a port free on 127.0.0.1, a different one each time', async () => {
		const ports = await Promise.all([freePort(), freePort(), freePort()]);
		for (const port of ports) {
			assert.ok(Number.isInteger(port) && port > 0 && port < 65_536, String(port));
			// Free: it can be bound on 127.0.0.1 again.
			const server = net.createServer();
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, '127.0.0.1', resolve);
			});
			await new Promise((resolve) => server.close(resolve));
		}
		assert.strictEqual(new Set(ports).size, ports.length, JSON.stringify(ports));
	});

	test('READ: GET /metrics of 127.0.0.1:<port>, parsed, with the read time', async () => {
		const server = await serve((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
			res.end(BODY);
		});
		try {
			const source = localMetricsSource(server.port, undefined, () => 1234);
			assert.strictEqual(source.address, `127.0.0.1:${server.port}`);
			const reading = await source.read();
			assert.strictEqual(reading.time, 1234);
			assert.strictEqual(reading.samples.length, 2);
			assert.strictEqual(reading.types.get('processor_latency_ns'), 'summary');
			assert.deepStrictEqual(server.paths, ['/metrics']);
		} finally {
			await server.close();
		}
	});

	test('UNREACHABLE: a refused connection', async () => {
		const port = await freePort();
		const err = await readError(localMetricsSource(port).read());
		assert.strictEqual(err.kind, 'unreachable');
		assert.ok(err.message.includes(`127.0.0.1:${port}`), err.message);
	});

	test('NOT_SERVED: a 404, JSON (json_api), and Prometheus text with no component series', async () => {
		let answer: [number, string, string] = [404, 'text/plain', '404 page not found'];
		const server = await serve((_req, res) => {
			res.writeHead(answer[0], { 'content-type': answer[1] });
			res.end(answer[2]);
		});
		try {
			const source = localMetricsSource(server.port);
			let err = await readError(source.read());
			assert.deepStrictEqual([err.kind, err.noSeries], ['notServed', undefined]);
			answer = [200, 'application/json', '{"input_received{label=\\"\\",path=\\"root.input\\"}":1}'];
			err = await readError(source.read());
			assert.deepStrictEqual([err.kind, err.noSeries], ['notServed', undefined]);
			answer = [200, 'text/plain', 'go_goroutines 7\n'];
			err = await readError(source.read());
			assert.deepStrictEqual([err.kind, err.noSeries], ['notServed', true]);
			answer = [401, 'text/plain', ''];
			err = await readError(source.read());
			assert.strictEqual(err.kind, 'refused');
			answer = [503, 'text/plain', 'busy'];
			err = await readError(source.read());
			assert.strictEqual(err.kind, 'unreachable');
		} finally {
			await server.close();
		}
	});

	test('ABORT: an aborted read rejects as unreachable', async () => {
		const server = await serve(() => undefined); // never answers
		try {
			const abort = new AbortController();
			const pending = localMetricsSource(server.port).read(abort.signal);
			setTimeout(() => abort.abort(), 50);
			const err = await readError(pending);
			assert.strictEqual(err.kind, 'unreachable');
		} finally {
			await server.close();
		}
	});

	test('isMetricsReadError tells the kinds apart by name', () => {
		assert.ok(isMetricsReadError(new MetricsReadError('refused', 'x')));
		assert.ok(isMetricsReadError({ name: 'MetricsReadError', kind: 'notServed', message: 'm', noSeries: true }));
		assert.ok(!isMetricsReadError({ name: 'MetricsReadError', kind: 'odd', message: 'm' }));
		assert.ok(!isMetricsReadError(new Error('x')));
	});
});
