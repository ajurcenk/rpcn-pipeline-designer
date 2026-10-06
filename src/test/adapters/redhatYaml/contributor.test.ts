import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	createRedHatYamlLoader, ExtensionHandle, RedHatYamlApi, RedHatYamlLoader, registerSchemaContributor, SCHEMA_SCHEME, SchemaContributor, schemaUriFor,
} from '../../../adapters/redhatYaml/contributor';
import type { SchemaSnapshot } from '../../../adapters/redpandaConnect/schema';
import { schemaFileName, schemaHash } from '../../../core/schema';

function snapshot(path: string, version: string, json: SchemaSnapshot['json'] = { $schema: 'x', properties: {} }): SchemaSnapshot {
	return { uri: vscode.Uri.file(`/nonexistent/${schemaFileName(path, version)}`), json, path, version };
}

const DETECTED = 'file:///work/pipeline.yaml';
const OTHER = 'file:///work/k8s.yaml';

function contributorWith(current: SchemaSnapshot | undefined) {
	const schemas = { current };
	const detection = { isDetected: (uri: string) => uri === DETECTED };
	return { schemas, contributor: new SchemaContributor(schemas, detection) };
}

suite('adapters/redhatYaml SchemaContributor', () => {
	test('DETECTED: requestSchema returns rpcn-schema://schema/<hash>.json for a detected document', () => {
		const snap = snapshot('/bin/redpanda-connect', '4.112.0');
		const { contributor } = contributorWith(snap);
		const uri = contributor.requestSchema(DETECTED);
		assert.strictEqual(uri, `rpcn-schema://schema/${schemaHash('/bin/redpanda-connect', '4.112.0')}.json`);
		assert.strictEqual(uri, schemaUriFor(snap));
		assert.strictEqual(vscode.Uri.parse(uri).scheme, SCHEMA_SCHEME);
		// The hash is the snapshot's cache-file hash.
		assert.ok(snap.uri.path.endsWith(`schema-${uri.slice('rpcn-schema://schema/'.length)}`));
	});

	test('NOT_DETECTED: requestSchema returns nothing for a document the registry rejects', () => {
		const { contributor } = contributorWith(snapshot('/bin/rc', '4.112.0'));
		assert.strictEqual(contributor.requestSchema(OTHER), undefined);
	});

	test('NO_SCHEMA: requestSchema returns nothing; requestSchemaContent serves an empty schema for a served URI', () => {
		const { contributor } = contributorWith(undefined);
		assert.strictEqual(contributor.requestSchema(DETECTED), undefined);
		assert.strictEqual(contributor.requestSchemaContent('rpcn-schema://schema/0000000000000000.json'), '{}');
	});

	test('requestSchemaContent returns the snapshot JSON, stringified once per snapshot', () => {
		const json = { $schema: 'draft', properties: { input: { type: 'object' } } };
		const snap = snapshot('/bin/rc', '4.112.0', json);
		const { contributor } = contributorWith(snap);
		const first = contributor.requestSchemaContent(schemaUriFor(snap));
		assert.deepStrictEqual(JSON.parse(first!), json);
		// Same snapshot: the cached string is served even if the object were (wrongly) mutated.
		(json.properties as Record<string, unknown>).added = {};
		assert.strictEqual(contributor.requestSchemaContent(schemaUriFor(snap)), first);
	});

	test('SCHEMA_CHANGES: a new snapshot gives a new URI and new content; a stale URI gets the current schema', () => {
		const oldSnap = snapshot('/bin/rc', '4.100.0', { $schema: 'd', title: 'old' });
		const { schemas, contributor } = contributorWith(oldSnap);
		const oldUri = contributor.requestSchema(DETECTED)!;
		assert.strictEqual(JSON.parse(contributor.requestSchemaContent(oldUri)!).title, 'old');

		const newSnap = snapshot('/bin/rc', '4.112.0', { $schema: 'd', title: 'new' });
		schemas.current = newSnap;
		const newUri = contributor.requestSchema(DETECTED)!;
		assert.notStrictEqual(newUri, oldUri);
		assert.strictEqual(JSON.parse(contributor.requestSchemaContent(newUri)!).title, 'new');
		assert.strictEqual(JSON.parse(contributor.requestSchemaContent(oldUri)!).title, 'new');
	});

	test('a refreshed snapshot for the same binary serves the new content', () => {
		const { schemas, contributor } = contributorWith(snapshot('/bin/rc', '4.112.0', { $schema: 'd', title: 'a' }));
		const uri = contributor.requestSchema(DETECTED)!;
		contributor.requestSchemaContent(uri);
		schemas.current = snapshot('/bin/rc', '4.112.0', { $schema: 'd', title: 'b' });
		assert.strictEqual(JSON.parse(contributor.requestSchemaContent(uri)!).title, 'b');
	});
});

suite('adapters/redhatYaml registerSchemaContributor', () => {
	const contributor = contributorWith(undefined).contributor;

	function fakeApi(result: boolean | Error) {
		const calls: { schema: string; label: string | undefined; requestSchema: unknown; requestSchemaContent: unknown }[] = [];
		const api: RedHatYamlApi = {
			registerContributor: (schema, requestSchema, requestSchemaContent, label) => {
				calls.push({ schema, label, requestSchema, requestSchemaContent });
				if (result instanceof Error) {
					throw result;
				}
				return result;
			},
		};
		return { api, calls };
	}

	test('registers exactly one contributor under rpcn-schema with the contributor callbacks', async () => {
		const { api, calls } = fakeApi(true);
		const lines: string[] = [];
		assert.strictEqual(await registerSchemaContributor({ contributor, log: (l) => lines.push(l), load: async () => ({ api }) }), true);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].schema, 'rpcn-schema');
		assert.strictEqual(calls[0].label, undefined);
		assert.strictEqual(calls[0].requestSchema, contributor.requestSchema);
		assert.strictEqual(calls[0].requestSchemaContent, contributor.requestSchemaContent);
		assert.deepStrictEqual(lines, []);
	});

	test('REGISTER_FALSE: logs one line naming the scheme key and resolves false', async () => {
		const { api } = fakeApi(false);
		const lines: string[] = [];
		assert.strictEqual(await registerSchemaContributor({ contributor, log: (l) => lines.push(l), load: async () => ({ api }) }), false);
		assert.strictEqual(lines.length, 1);
		assert.ok(lines[0].includes('"rpcn-schema"'), lines[0]);
		assert.ok(lines[0].startsWith('Schema'), lines[0]);
	});

	test('NO_REDHAT: an absent or failed Red Hat YAML logs one line and never throws', async () => {
		const loaders: RedHatYamlLoader[] = [
			async () => ({ reason: 'redhat.vscode-yaml is not installed' }),
			async () => { throw new Error('boom'); },
		];
		for (const load of loaders) {
			const lines: string[] = [];
			assert.strictEqual(await registerSchemaContributor({ contributor, log: (l) => lines.push(l), load }), false);
			assert.strictEqual(lines.length, 1, lines.join('\n'));
			assert.ok(lines[0].includes('redhat.vscode-yaml'), lines[0]);
		}
	});

	test('a throwing registerContributor logs one line and resolves false', async () => {
		const { api } = fakeApi(new Error('bad'));
		const lines: string[] = [];
		assert.strictEqual(await registerSchemaContributor({ contributor, log: (l) => lines.push(l), load: async () => ({ api }) }), false);
		assert.strictEqual(lines.length, 1);
		assert.ok(lines[0].includes('bad'), lines[0]);
	});
});

suite('adapters/redhatYaml createRedHatYamlLoader', () => {
	const api: RedHatYamlApi = { registerContributor: () => true };

	function handle(overrides: Partial<ExtensionHandle> & { activated?: () => Promise<unknown> }): ExtensionHandle & { activations: number } {
		const h = {
			isActive: overrides.isActive ?? false,
			exports: overrides.exports,
			activations: 0,
			activate: () => {
				h.activations++;
				return overrides.activated ? overrides.activated() : Promise.resolve(api);
			},
		};
		return h;
	}

	test('looks up redhat.vscode-yaml; a missing extension gives a reason', async () => {
		const ids: string[] = [];
		const result = await createRedHatYamlLoader((id) => { ids.push(id); return undefined; })();
		assert.deepStrictEqual(ids, ['redhat.vscode-yaml']);
		assert.ok('reason' in result && result.reason.includes('not installed'), JSON.stringify(result));
	});

	test('an inactive extension is activated and its activation result used', async () => {
		const h = handle({});
		const result = await createRedHatYamlLoader(() => h)();
		assert.strictEqual(h.activations, 1);
		assert.ok('api' in result && result.api === api);
	});

	test('an already active extension uses its exports without activating', async () => {
		const h = handle({ isActive: true, exports: api, activated: () => Promise.reject(new Error('should not activate')) });
		const result = await createRedHatYamlLoader(() => h)();
		assert.strictEqual(h.activations, 0);
		assert.ok('api' in result && result.api === api);
	});

	test('a rejecting activate() gives a reason, never a rejection', async () => {
		const h = handle({ activated: () => Promise.reject(new Error('kaboom')) });
		const result = await createRedHatYamlLoader(() => h)();
		assert.ok('reason' in result && result.reason.includes('failed to activate') && result.reason.includes('kaboom'),
			JSON.stringify(result));
	});

	test('exports without registerContributor give a reason', async () => {
		for (const exports of [undefined, {}, { registerContributor: 'nope' }]) {
			const h = handle({ isActive: true, exports });
			const result = await createRedHatYamlLoader(() => h)();
			assert.ok('reason' in result && result.reason.includes('registerContributor'), JSON.stringify(result));
		}
	});
});
