// Run by `npm run pretest`: removes the cached schemas and leftover live-parse files from the test
// profile's extension storage. Each test run makes new fake binaries, and each gets its own
// `schema-<16 hex>.json` (about 2 MB), all younger than the extension's 30-day cleanup, so the
// profile grows by hundreds of megabytes a day. Only those two file patterns are removed; the
// `env-setting` folder cleans itself.
import * as fs from 'fs';
import * as path from 'path';

const dir = path.join('.vscode-test', 'user-data', 'User', 'globalStorage', 'ajurcenk.rpcn-pipeline-designer');
const CACHED = /^(schema-[0-9a-f]{16}\.json|bloblang-parse-[0-9a-f]{16}\.blobl)$/;

let names = [];
try {
	names = fs.readdirSync(dir);
} catch {
	// No test profile yet.
}
for (const name of names.filter((n) => CACHED.test(n))) {
	fs.rmSync(path.join(dir, name), { force: true });
}
