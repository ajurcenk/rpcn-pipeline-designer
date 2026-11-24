// Spike 65: starts VS Code 1.143.1 from the repository's .vscode-test with both extensions (the
// Pipeline Designer and this spike) and runs check/refusal.cjs in it. HOME is a fresh folder under
// .cache/assistant-host/, so your own ~/.config/rpcn-spike/adp.env is never read and ADP is never
// called. `--fake-run` runs check/fake-run.cjs instead: the SDK against a fake Messages API on
// 127.0.0.1. Run it under xvfb (see README.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.resolve(here, '..');
const repo = path.resolve(spike, '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const { runTests } = require('@vscode/test-electron');

const fake = process.argv.includes('--fake-run');
const base = path.join(repo, '.cache/assistant-host', fake ? 'fake-run' : 'refusal');
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'fake-home');
const ws = path.join(base, 'workspace');
const exts = path.join(base, 'extensions');
for (const d of [home, ws, exts]) fs.mkdirSync(d, { recursive: true });
const yaml = fs.readdirSync(path.join(repo, '.vscode-test/extensions')).find((d) => d.startsWith('redhat.vscode-yaml-'));
if (yaml) fs.cpSync(path.join(repo, '.vscode-test/extensions', yaml), path.join(exts, yaml), { recursive: true });

await runTests({
	vscodeExecutablePath: path.join(repo, '.vscode-test/vscode-linux-x64-1.143.1/code'),
	extensionDevelopmentPath: [repo, spike],
	extensionTestsPath: path.join(here, fake ? 'fake-run.cjs' : 'refusal.cjs'),
	extensionTestsEnv: { HOME: home },
	launchArgs: [ws, '--user-data-dir', path.join(base, 'user'), '--extensions-dir', exts, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
});
