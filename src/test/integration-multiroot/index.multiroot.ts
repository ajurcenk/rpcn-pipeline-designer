// The multi-root run (ticket 28, `npx vscode-test --label multiroot`): VS Code opens the two-folder
// `test/multiroot/multiroot.code-workspace`, and this entry loads the suites that need it. It is not
// a `*.test.js` file, so the stable and floor runs (which open no folder) never load it.
import * as vscode from 'vscode';
import './suites/settings';

// As the stable run's root hook: the suites open detected YAML, so the graph does not auto-open.
suiteSetup(async () => {
	await vscode.workspace.getConfiguration('redpandaConnect').update('autoOpenGraph', false, vscode.ConfigurationTarget.Global);
});
