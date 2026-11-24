// Spike 65: the in-host check of the refusal (run by check/run-refusal.mjs, no ADP call). With HOME
// pointing at a folder of the launcher's, the ADP file is missing, then 0644, then a symlink; each
// time the command must refuse naming the file, before any request: no fetch, no SDK import, no
// .spike-65 folder in the workspace.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

exports.run = async function run() {
	const failures = [];
	const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
	const ext = vscode.extensions.getExtension('ajurcenk.rpcn-spike-assistant-host');
	check(!!ext, 'the spike extension is loaded in the dev host');
	const main = vscode.extensions.getExtension('ajurcenk.rpcn-pipeline-designer');
	check(!!main, 'the Pipeline Designer is loaded beside it');
	await ext.activate();
	check(ext.isActive, 'the spike extension activates');
	const cmds = await vscode.commands.getCommands(true);
	check(cmds.includes('rpcnSpike.runAssistant'), 'the "Spike: run the assistant" command is registered');

	const errors = [];
	const origErr = vscode.window.showErrorMessage;
	vscode.window.showErrorMessage = (m, ...rest) => { errors.push(String(m)); return Promise.resolve(undefined); };
	let fetches = 0;
	const origFetch = globalThis.fetch;
	globalThis.fetch = (...a) => { fetches++; return origFetch(...a); };
	const prompts = [];
	const origInput = vscode.window.showInputBox;
	vscode.window.showInputBox = (o) => { prompts.push(o); return Promise.resolve(undefined); };

	const home = os.homedir();
	const file = path.join(home, '.config/rpcn-spike/adp.env');
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	check(home.includes('fake-home'), `HOME is the launcher's fake home (${home}), not yours`);
	const cases = [
		['missing', () => fs.rmSync(file, { force: true }), /ADP file not found: .*adp\.env \(create it, mode 0600\)/],
		['mode 0644', () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'ADP_BASE_URL=https://adp.invalid\nadp_api_key=sk-dry-run-not-a-key-0000\n'); fs.chmodSync(file, 0o644); }, /mode 644, must be 600: .*adp\.env \(run: chmod 600 /],
		['a symlink', () => { const t = path.join(home, 'real.env'); fs.renameSync(file, t); fs.chmodSync(t, 0o600); fs.symlinkSync(t, file); }, /not a regular file \(symlinks are refused\): .*adp\.env/],
		['no ADP_API_KEY', () => { fs.rmSync(file); fs.writeFileSync(file, 'ADP_BASE_URL=https://adp.invalid\n'); fs.chmodSync(file, 0o600); }, /needs ADP_API_KEY[=] line\(s\): .*adp\.env/],
	];
	for (const [label, setup, re] of cases) {
		setup();
		errors.length = 0;
		const r = await vscode.commands.executeCommand('rpcnSpike.runAssistant');
		check(r?.outcome === 'refused', `${label}: the command refuses (${r?.outcome})`);
		check(errors.length === 1 && re.test(errors[0]) && errors[0].includes(file), `${label}: the message names the file and the fix (${errors[0]})`);
		check(!errors.join('').includes('sk-dry-run'), `${label}: the message holds no key`);
	}
	check(fetches === 0, 'no request was made');
	check(prompts.length === 0, 'nothing was asked (the refusal comes first)');
	check(ws && !fs.existsSync(path.join(ws, '.spike-65')), 'nothing was written in the workspace');
	vscode.window.showErrorMessage = origErr;
	vscode.window.showInputBox = origInput;
	globalThis.fetch = origFetch;
	if (failures.length) throw new Error(`${failures.length} check(s) failed: ${failures.join('; ')}`);
	console.log('refusal check: all checks passed');
};
