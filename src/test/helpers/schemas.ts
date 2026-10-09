// The pinned schemas (spike 1.1 recordings) as production serves them: the AD-10 transform of
// `list --format jsonschema` with the `json-full` docs merged.
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { transformSchema, type JsonObject } from '../../core/schema';
import { SCHEMA_FIXTURES } from './fakeBinary';

export const PINNED_VERSIONS = ['4.100.0', '4.112.0'] as const;
export type PinnedVersion = typeof PINNED_VERSIONS[number];

/** The raw `list --format jsonschema` recording of `version` (a fresh copy). */
export function rawSchema(version: PinnedVersion): JsonObject {
	return JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, `jsonschema-${version}.json`), 'utf8')) as JsonObject;
}

/** The `list --format json-full` recording of `version`. */
export function schemaDocs(version: PinnedVersion): JsonObject {
	return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, `json-full-${version}.json.gz`))).toString('utf8')) as JsonObject;
}

const transformed = new Map<PinnedVersion, JsonObject>();

/** The transformed schema of `version`, read once per test run. */
export function servedSchema(version: PinnedVersion): JsonObject {
	let schema = transformed.get(version);
	if (!schema) {
		schema = transformSchema(rawSchema(version), schemaDocs(version));
		transformed.set(version, schema);
	}
	return schema;
}
