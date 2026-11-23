import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import * as zlib from 'zlib';
import {
	CLOUD_ADDRESS_FALLBACK, CLOUD_READ_TIMEOUT_MS, CLOUD_REFUSED_TEXT, cloudAddress, cloudMetricsSource, DEFAULT_PROMETHEUS_USER, freePort, isMetricsReadError, localMetricsSource, MetricsReadError,
	testCloudMetricsAccess,
} from '../../../adapters/metrics/source';

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

// Ticket 7.4 (AD-25): the Cloud source and the metrics access's test read, against a local HTTP server
// answering as spike 7.1's endpoint did (basic auth, gzip when asked, the whole cluster's body).
const CLUSTER_BODY = [
	'# HELP redpanda_kafka_partitions Configured number of partitions',
	'# TYPE redpanda_kafka_partitions gauge',
	'redpanda_kafka_partitions{redpanda_topic="orders"} 3',
	'# TYPE input_received counter',
	'input_received{instance="10.0.0.1:9",label="",path="root.input",pipeline_id="d3orders",pod="a-d3orders-1"} 197',
	'input_received{instance="10.0.0.2:9",label="",path="root.input",pipeline_id="d3clicks",pod="a-d3clicks-1"} 55',
	'# TYPE processor_latency_ns summary',
	'processor_latency_ns{label="fast",path="root.pipeline.processors.0",pipeline_id="d3orders",quantile="0.5"} 5.163878e+06',
	'processor_latency_ns{label="fast",path="root.pipeline.processors.0",pipeline_id="d3clicks",quantile="0.5"} 4700',
	'',
].join('\n');
const PASSWORD = 'prom-password-7-4';

suite('adapters/metrics Cloud source (ticket 7.4)', () => {
	type Seen = { readonly url: string; readonly auth: string; readonly encoding: string };
	/** An endpoint at /api/cloud/prometheus/public_metrics: 401 (empty) unless the basic auth is prometheus:PASSWORD. */
	async function endpoint(options: { status?: number; gzip?: boolean; body?: string; hang?: boolean } = {}) {
		const seen: Seen[] = [];
		const server = await serve((req, res) => {
			seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', encoding: String(req.headers['accept-encoding'] ?? '') });
			if (options.hang) {
				return;
			}
			if (req.headers.authorization !== `Basic ${Buffer.from(`prometheus:${PASSWORD}`).toString('base64')}`) {
				res.writeHead(401, { 'content-length': 0, 'www-authenticate': 'Basic realm="Redpanda Cloud"' });
				res.end();
				return;
			}
			if (options.status) {
				res.writeHead(options.status, { 'content-length': 0 });
				res.end();
				return;
			}
			const text = Buffer.from(options.body ?? CLUSTER_BODY);
			const gzip = (options.gzip ?? true) && /gzip/.test(String(req.headers['accept-encoding']));
			res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
			res.end(gzip ? zlib.gzipSync(text) : text);
		});
		const url = `http://127.0.0.1:${server.port}/api/cloud/prometheus/public_metrics`;
		return { ...server, seen, url };
	}

	test('the defaults: user prometheus, a 15 s timeout', () => {
		assert.strictEqual(DEFAULT_PROMETHEUS_USER, 'prometheus');
		assert.strictEqual(CLOUD_READ_TIMEOUT_MS, 15_000);
	});

	test('AUTH and GZIP: basic auth, Accept-Encoding gzip, the gzip answer read; FILTER: only the pipeline\'s series, # lines kept', async () => {
		const server = await endpoint();
		try {
			const source = cloudMetricsSource(server.url, 'prometheus', PASSWORD, 'd3orders', { now: () => 42 });
			assert.strictEqual(source.address, `127.0.0.1:${server.port}`, 'the host only, no path');
			const reading = await source.read();
			assert.strictEqual(reading.time, 42);
			assert.deepStrictEqual(server.seen.map((x) => x.url), ['/api/cloud/prometheus/public_metrics']);
			assert.strictEqual(server.seen[0].auth, `Basic ${Buffer.from(`prometheus:${PASSWORD}`).toString('base64')}`);
			assert.match(server.seen[0].encoding, /\bgzip\b/);
			assert.deepStrictEqual(reading.samples.map((x) => [x.name, x.labels.pipeline_id, x.value]),
				[['input_received', 'd3orders', 197], ['processor_latency_ns', 'd3orders', 5_163_878]]);
			assert.strictEqual(reading.types.get('processor_latency_ns'), 'summary', 'from its # TYPE line');
			assert.strictEqual(reading.types.get('redpanda_kafka_partitions'), 'gauge', '# lines are kept');
		} finally {
			await server.close();
		}
	});

	test('PLAIN: an answer that is not gzip is read too', async () => {
		const server = await endpoint({ gzip: false });
		try {
			const reading = await cloudMetricsSource(server.url, 'prometheus', PASSWORD, 'd3clicks').read();
			assert.deepStrictEqual(reading.samples.map((x) => x.value), [55, 4700]);
		} finally {
			await server.close();
		}
	});

	test('REFUSED: a 401 with an empty body is refused, said without the password, and read once (not retried)', async () => {
		const server = await endpoint();
		try {
			const err = await readError(cloudMetricsSource(server.url, 'prometheus', 'wrong-password-7-4', 'd3orders').read());
			assert.strictEqual(err.kind, 'refused');
			assert.ok(err.message.includes(CLOUD_REFUSED_TEXT), err.message);
			assert.ok(!err.message.includes('wrong-password-7-4'), err.message);
			assert.strictEqual(server.seen.length, 1);
			const test = await readError(testCloudMetricsAccess(server.url, 'prometheus', 'wrong-password-7-4'));
			assert.strictEqual(test.kind, 'refused');
			assert.strictEqual(server.seen.length, 2);
		} finally {
			await server.close();
		}
	});

	test('NO_SERIES: the pipeline has no series in the cluster\'s body: notServed, noSeries', async () => {
		const server = await endpoint();
		try {
			const err = await readError(cloudMetricsSource(server.url, 'prometheus', PASSWORD, 'd3gone').read());
			assert.deepStrictEqual([err.kind, err.noSeries], ['notServed', true]);
		} finally {
			await server.close();
		}
	});

	test('TEST_READ: a 200 is accepted, whatever the body; a 503 is unreachable', async () => {
		let server = await endpoint({ body: '# nothing\n' });
		try {
			await testCloudMetricsAccess(server.url, 'prometheus', PASSWORD);
		} finally {
			await server.close();
		}
		server = await endpoint({ status: 503 });
		try {
			const err = await readError(testCloudMetricsAccess(server.url, 'prometheus', PASSWORD));
			assert.strictEqual(err.kind, 'unreachable');
			assert.ok(err.message.includes('HTTP 503'), err.message);
		} finally {
			await server.close();
		}
	});

	test('TIMEOUT: no answer within the timeout is unreachable, said with the wait', async () => {
		const server = await endpoint({ hang: true });
		try {
			const err = await readError(cloudMetricsSource(server.url, 'prometheus', PASSWORD, 'd3orders', { timeoutMs: 200 }).read());
			assert.strictEqual(err.kind, 'unreachable');
			assert.ok(err.message.includes('within 0.2 s'), err.message);
			const test = await readError(testCloudMetricsAccess(server.url, 'prometheus', PASSWORD, { timeoutMs: 200 }));
			assert.strictEqual(test.kind, 'unreachable');
		} finally {
			await server.close();
		}
	});

	test('UNREACHABLE: a refused connection', async () => {
		const port = await freePort();
		const err = await readError(testCloudMetricsAccess(`http://127.0.0.1:${port}/x`, 'prometheus', PASSWORD));
		assert.strictEqual(err.kind, 'unreachable');
		assert.ok(err.message.includes('connection refused'), err.message);
	});

	test('ABORT_ONE: two callers share a read; the first aborts, only its wait rejects, the second still gets the reading', async () => {
		const server = await endpoint();
		try {
			const source = cloudMetricsSource(server.url, 'prometheus', PASSWORD, 'd3orders');
			const abort = new AbortController();
			const first = source.read(abort.signal);
			const second = source.read(new AbortController().signal);
			abort.abort();
			assert.strictEqual((await readError(first)).kind, 'unreachable');
			assert.strictEqual((await second).samples.length, 2);
			assert.strictEqual(server.seen.length, 1, 'one shared read');
		} finally {
			await server.close();
		}
	});

	test('ABORTED_BEFORE: a signal aborted before the call rejects at once, for the Cloud and the local source', async () => {
		const server = await endpoint({ hang: true });
		try {
			const abort = new AbortController();
			abort.abort();
			const started = Date.now();
			assert.strictEqual((await readError(cloudMetricsSource(server.url, 'prometheus', PASSWORD, 'd3orders').read(abort.signal))).kind, 'unreachable');
			assert.strictEqual((await readError(localMetricsSource(server.port).read(abort.signal))).kind, 'unreachable');
			assert.ok(Date.now() - started < 2_000, 'not waiting for a timeout');
		} finally {
			await server.close();
		}
	});

	test('ONE_IN_FLIGHT: a read asked while one is in flight gets that read\'s answer; the next one reads again', async () => {
		const server = await endpoint();
		try {
			const source = cloudMetricsSource(server.url, 'prometheus', PASSWORD, 'd3orders');
			const [a, b] = await Promise.all([source.read(), source.read()]);
			assert.strictEqual(a, b);
			assert.strictEqual(server.seen.length, 1);
			await source.read();
			assert.strictEqual(server.seen.length, 2);
		} finally {
			await server.close();
		}
	});
});

suite('adapters/metrics cloudAddress (story 62)', () => {
	test('story 62 C11: a URL that does not parse, carrying credentials, is shown as a fixed text, never as it is', () => {
		for (const url of ['https://user:hunter2-62@[not-a-host/metrics', 'user:hunter2-62@prom example', '://user:hunter2-62@']) {
			const shown = cloudAddress(url);
			assert.strictEqual(shown, CLOUD_ADDRESS_FALLBACK, url);
			assert.ok(!shown.includes('hunter2-62') && !shown.includes('user'), shown);
		}
	});

	test('story 62 C11: a URL that parses is shown as its host alone (no credentials, path or query)', () => {
		assert.strictEqual(cloudAddress('https://user:hunter2-62@prom.example:9090/api/cloud/prometheus/public_metrics?x=1'), 'prom.example:9090');
	});
});
