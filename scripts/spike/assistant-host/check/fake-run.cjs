// Spike 65: the in-host offline run (run by check/run-refusal.mjs --fake-run, no ADP call). The SDK
// runs in the extension host against a fake Messages API on 127.0.0.1. The fake scripts the main
// conversation as a series of tool_use turns, one decision each, then a final text turn:
//   ask        AskUserQuestion            -> canUseTool, answered here by a scripted pick
//   rpcn-ok    Bash: the skills' rpcn_check.py binary  -> allowed by the hook
//   chained    Bash: the same, `; echo chained`        -> asks (canUseTool), denied here
//   ws-script  Bash: an rpcn_check.py in the workspace -> asks, denied here
//   write-out  Write outside the workspace             -> denied by the hook
//   fields     mcp__rpcn__rpcn_componentFields         -> allowed by the hook, an envelope back
//   bottleneck mcp__rpcn__metrics_bottleneck           -> allowed; "not running" (its core loads)
//   write-in   Write <workspace>/orders.design.md      -> allowed (canUseTool, inside)
// It also shows: the init message (the plugin's skills, the in-process tools), the endpoints and
// headers Claude Code calls, the time to the first stream message, that the key, its start and the
// extra header value stay out of the captures, and that nothing new appears in HOME.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vscode = require('vscode');

/** Every path under `dir` (files and folders), relative. */
function tree(dir) {
	const out = [];
	const walk = (d) => {
		let ents = [];
		try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of ents) { const p = path.join(d, e.name); out.push(path.relative(dir, p)); if (e.isDirectory() && !e.isSymbolicLink()) walk(p); }
	};
	walk(dir);
	return new Set(out);
}

exports.run = async function run() {
	const failures = [];
	const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
	const KEY = 'adpfake-run-key-0000aaaa1111bbbb'; // not sk-: only the prefix redaction can catch its start
	const HDR = ['X-Adp-Tenant', 'tenant-value-secret-77'];
	const home = os.homedir();
	check(home.includes('fake-home'), 'HOME is the launcher\'s fake home, not yours');
	const repo = path.resolve(__dirname, '../../../..');
	const skills = path.resolve(repo, '../rpcn-skills');
	const script = path.join(skills, 'skills/rpcn-design/scripts/rpcn_check.py');
	const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const outside = path.join(path.dirname(ws), 'outside-the-workspace.txt');
	fs.mkdirSync(path.join(ws, 'evil'), { recursive: true });
	fs.writeFileSync(path.join(ws, 'evil/rpcn_check.py'), 'print("not the skills")\n');
	fs.writeFileSync(path.join(ws, 'orders.yaml'), 'input:\n  generate:\n    mapping: root = {}\noutput:\n  drop: {}\n');
	const note = '---\nartifact: design\nformat: design@1\npipeline: orders\nstatus: ready\nproduced_by: rpcn-design@0.1.0\nrpcn_version: 4.112.0\ninputs: []\nupdated: 2026-11-23\n---\n\n# orders (fake)\n';

	const steps = [
		['ask', 'AskUserQuestion', { questions: [{ question: 'Where should failed messages go?', header: 'Failures', multiSelect: false, options: [{ label: 'orders.dlq', description: 'A dead-letter topic beside the input' }, { label: 'Drop them', description: 'At-most-once, no DLQ' }] }] }],
		['rpcn-ok', 'Bash', { command: `uv run ${script} binary`, description: 'Check the binary' }],
		['chained', 'Bash', { command: `uv run ${script} binary; echo chained`, description: 'Chained' }],
		['ws-script', 'Bash', { command: `uv run ${path.join(ws, 'evil/rpcn_check.py')} binary`, description: 'A script in the workspace' }],
		['write-out', 'Write', { file_path: outside, content: 'outside' }],
		['fields', 'mcp__rpcn__rpcn_componentFields', { category: 'inputs', component: 'generate' }],
		['bottleneck', 'mcp__rpcn__metrics_bottleneck', { file: 'orders.yaml' }],
		['write-in', 'Write', { file_path: path.join(ws, 'orders.design.md'), content: note }],
	];
	const ids = new Map(steps.map(([n], i) => [`toolu_fake_${String(i).padStart(2, '0')}`, n]));
	const results = {}; // step name -> { is_error, text }
	const seen = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (d) => { raw += d; });
		req.on('end', () => {
			let body = {};
			try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
			const tools = Array.isArray(body.tools) ? body.tools.map((t) => t.name) : [];
			const main = tools.includes('AskUserQuestion');
			const step = main ? (body.messages ?? []).filter((m) => m.role === 'assistant').length : null;
			for (const m of body.messages ?? []) {
				if (m.role !== 'user' || !Array.isArray(m.content)) continue;
				for (const b of m.content) if (b.type === 'tool_result' && ids.has(b.tool_use_id)) results[ids.get(b.tool_use_id)] = { is_error: !!b.is_error, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) };
			}
			seen.push({ method: req.method, path: req.url.replace(/\?.*$/, ''), headers: Object.keys(req.headers).sort(), auth: req.headers['x-api-key'] === KEY ? 'x-api-key' : req.headers.authorization === `Bearer ${KEY}` ? 'bearer' : 'none', tenant: req.headers[HDR[0].toLowerCase()] === HDR[1], model: body.model, stream: !!body.stream, main, step, tools, mentions: Object.fromEntries(['rpcn-design', 'rpcn-author', 'rpcn-test', 'deep-research', 'dataviz', 'claude-api'].map((w) => [w, raw.includes(w)])) });
			const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
			if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 10 })); return; }
			if (!req.url.startsWith('/v1/messages')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } })); return; }
			const s = main && step < steps.length ? steps[step] : null;
			const id = s ? `toolu_fake_${String(step).padStart(2, '0')}` : null;
			const block = s ? { type: 'tool_use', id, name: s[1], input: s[2] } : { type: 'text', text: 'Fake answer: done.' };
			const stop = s ? 'tool_use' : 'end_turn';
			const msg = { id: `msg_fake_${seen.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage };
			if (body.stream) {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
				ev('message_start', { type: 'message_start', message: msg });
				if (s) {
					ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: s[1], input: {} } });
					ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(s[2]) } });
				} else {
					ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
					ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } });
				}
				ev('content_block_stop', { type: 'content_block_stop', index: 0 });
				ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
				ev('message_stop', { type: 'message_stop' });
				res.end();
			} else {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ...msg, content: [block], stop_reason: stop }));
			}
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const port = server.address().port;
	const file = path.join(home, '.config/rpcn-spike/adp.env');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `ADP_BASE_URL=http://127.0.0.1:${port}\nadp_api_key=${KEY}\nADP_HEADERS=${HDR[0]}: ${HDR[1]}\n`);
	fs.chmodSync(file, 0o600);
	// VS Code creates folders in HOME while it starts (.vscode/cli, …), and the Pipeline Designer's
	// own binary calls create ~/.cache/snowflake (Redpanda Connect's Snowflake driver): activate it
	// and let both settle first, so any entry that appears during the run is the spike's.
	const designer = await vscode.extensions.getExtension('ajurcenk.rpcn-pipeline-designer').activate();
	await designer.activationResolved;
	await new Promise((r) => setTimeout(r, 5000));
	const homeBefore = tree(home);

	// The scripted user: Run to start, the first option of each question, Deny to every approval.
	const asked = [];
	const origInput = vscode.window.showInputBox, origWarn = vscode.window.showWarningMessage, origPick = vscode.window.showQuickPick, origErr = vscode.window.showErrorMessage;
	vscode.window.showInputBox = (o) => Promise.resolve(o?.value);
	const warnings = [];
	vscode.window.showWarningMessage = (m, o, ...items) => { if (items.includes('Run')) return Promise.resolve('Run'); if (items.includes('Allow')) { asked.push(String(m)); return Promise.resolve('Deny'); } warnings.push(String(m)); return Promise.resolve(undefined); };
	vscode.window.showQuickPick = (items) => Promise.resolve(Array.isArray(items) ? items[0] : undefined);
	const errors = [];
	vscode.window.showErrorMessage = (m) => { errors.push(String(m)); return Promise.resolve(undefined); };
	await vscode.extensions.getExtension('ajurcenk.rpcn-spike-assistant-host').activate();
	// A second run started while the first one is still in its dialogs is refused as busy.
	const first = vscode.commands.executeCommand('rpcnSpike.runAssistant');
	const second = await vscode.commands.executeCommand('rpcnSpike.runAssistant');
	const r = await first;
	vscode.window.showInputBox = origInput; vscode.window.showWarningMessage = origWarn; vscode.window.showQuickPick = origPick; vscode.window.showErrorMessage = origErr;
	server.close();
	check(r?.outcome === 'ran', `the command ran (${r?.outcome}; ${errors.join(' | ')})`);
	check(second?.outcome === 'busy' && warnings.some((w) => /already going/.test(w)), `a second run started during the first one's dialogs is busy (${second?.outcome})`);
	const spikeDir = path.join(ws, '.spike-65');
	const runDir = fs.readdirSync(spikeDir).filter((d) => d.startsWith('run-')).map((d) => path.join(spikeDir, d))[0];
	const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
	const eventsText = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
	const events = eventsText.trim().split('\n').map((l) => JSON.parse(l));
	console.log(`run.json: ${JSON.stringify({ times: run.times, counts: run.counts, result: run.result && { subtype: run.result.subtype, num_turns: run.result.num_turns }, error: run.error, design_notes: run.design_notes }, null, 1)}`);
	console.log(`tool results: ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { is_error: v.is_error, text: v.text.slice(0, 160) }])), null, 1)}`);
	console.log(`asked: ${JSON.stringify(asked)}`);

	console.log('== the SDK in the host');
	check(!run.error, `no SDK error (${JSON.stringify(run.error)})`);
	check(run.init && ['rpcn-design', 'rpcn-author', 'rpcn-test'].every((s) => run.init.skills.some((x) => x === s || x.endsWith(`:${s}`))), 'the init message lists the three skills');
	check(run.init?.plugins?.some((p) => p.name === 'rpcn-skills'), 'the init message lists the rpcn-skills plugin');
	check(run.init?.mcp_tools?.includes('mcp__rpcn__rpcn_componentFields') && run.init.mcp_tools.includes('mcp__rpcn__metrics_bottleneck'), 'the init message lists both in-process tools');
	check(run.result?.subtype === 'success', `the run ends with a result (${run.result?.subtype})`);
	const mainReqs = seen.filter((s) => s.main);
	check(mainReqs.length >= steps.length + 1, `the conversation went through every scripted turn (${mainReqs.length} main-loop requests)`);
	check(mainReqs[0]?.tools.includes('mcp__rpcn__rpcn_componentFields') && mainReqs[0].tools.includes('mcp__rpcn__metrics_bottleneck'), 'the in-process tools are in the model\'s tool list from the first request (alwaysLoad)');
	check(seen.length > 0 && seen.every((s) => s.auth === 'x-api-key' && s.tenant), 'every request carried the key as x-api-key and ADP_HEADERS');
	check(seen.filter((s) => s.path === '/v1/messages').every((s) => s.model === 'claude-opus-5-5'), 'every Messages call named the ADP model');
	check(mainReqs.every((s) => s.mentions['rpcn-design'] && !s.mentions['deep-research'] && !s.mentions.dataviz), 'the model sees the rpcn skills and not the unlisted bundled ones');
	check(typeof run.times?.first_message_ms === 'number', `the time to the first stream message is recorded (${run.times?.first_message_ms} ms after query())`);

	console.log('== each decision');
	const ev = (kind, pred = () => true) => events.filter((e) => e.kind === kind && pred(e));
	check(ev('question').length === 1 && ev('answer').length === 1 && results.ask && !results.ask.is_error && results.ask.text.includes('orders.dlq'), 'ask: AskUserQuestion reached canUseTool with its options, and the scripted answer went back');
	check(ev('question')[0]?.options?.length === 2, 'ask: the question arrived as data, with 2 options');
	check(ev('hook.PreToolUse', (e) => e.tool === 'Bash' && e.decision === 'allow').length === 1 && results['rpcn-ok'] && !results['rpcn-ok'].is_error && /"command":\s*"binary"/.test(results['rpcn-ok'].text), 'rpcn-ok: the skills\' rpcn_check call is allowed by the hook and runs');
	check(asked.some((m) => m.includes('echo chained')) && results.chained?.is_error, 'chained: a chained command asks (canUseTool), and is denied');
	check(asked.some((m) => m.includes('evil/rpcn_check.py')) && results['ws-script']?.is_error, 'ws-script: an rpcn_check.py in the workspace asks, and is denied');
	check(ev('hook.PreToolUse', (e) => e.tool === 'Write' && e.decision === 'deny').length === 1 && results['write-out']?.is_error && !fs.existsSync(outside) && !asked.some((m) => m.includes('Write')), 'write-out: a write outside the workspace is denied by the hook, without asking');
	// An MCP result comes back as its content blocks; the envelope is the first block's text.
	let fieldsEnvelope = null;
	try { const t = results.fields?.text ?? ''; fieldsEnvelope = JSON.parse(t.startsWith('[') ? JSON.parse(t)[0].text : t); } catch { /* not JSON */ }
	check(ev('tool.rpcn_componentFields', (e) => e.ok === true && e.fields > 0).length === 1 && fieldsEnvelope?.schema === 1 && fieldsEnvelope.command === 'fields' && fieldsEnvelope.data?.fields?.length > 0 && !results.fields.is_error, `fields: rpcn_componentFields was called and returned rpcn_check's envelope (${fieldsEnvelope?.data?.fields?.length} fields)`);
	check(!(results.fields?.text ?? '').includes(home + path.sep) && !(results.fields?.text ?? '').includes(repo), 'fields: the result is masked (no home or repository path)');
	const bn = ev('tool.metrics_bottleneck.error')[0];
	check(!!bn && /is not running/.test(bn.error) && !/compiled core is missing/.test(bn.error) && results.bottleneck?.is_error, `bottleneck: metrics_bottleneck was called, its core loaded, and it reports the file is not running (${bn?.error})`);
	check(fs.existsSync(path.join(ws, 'orders.design.md')) && run.design_notes?.some((n) => n.file === 'orders.design.md' && n.status === 'ready'), 'write-in: a write inside the workspace is allowed; the note is found with status ready');
	check(asked.length === 2, `only the two shell commands asked (${asked.length})`);

	console.log('== nothing leaks, nothing outside the workspace');
	const all = `${eventsText}\n${JSON.stringify(run)}`;
	check(!all.includes(KEY) && !all.includes(KEY.slice(0, 8)) && !all.includes(HDR[1]) && !all.includes(HDR[1].slice(0, 8)), 'the key, its start and the header value are not in the captures');
	check(run.leak_scan?.clean === true, 'the run\'s leak self-scan is clean');
	check(['UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_TOOL_DIR', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'].every((k) => run.env_names?.includes(k)), 'the env moves uv, XDG and Claude Code\'s folders into the workspace and names the ADP model for every alias');
	const added = [...tree(home)].filter((p) => !homeBefore.has(p));
	check(added.length === 0, `nothing new in HOME during the run (${JSON.stringify(added.slice(0, 20))})`);
	fs.writeFileSync(path.join(path.dirname(home), 'fake-run-result.json'), JSON.stringify({ run, requests: seen, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { is_error: v.is_error, chars: v.text.length }])), asked: asked.length }, null, 1));
	if (failures.length) throw new Error(`${failures.length} check(s) failed: ${failures.join('; ')}`);
	console.log('fake run: all checks passed');
};
