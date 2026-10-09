// The fixture models (ticket 3.2; README in src/test/fixtures/models): hand-written configs
// with the PipelineModel the core builds from each. Shared by the protocol and graph tests.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { isPipelineModel, type PipelineModel } from '../../shared/protocol';
import { REPO_ROOT } from './fakeBinary';

export const FIXTURES = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'models');

export const FIXTURE_NAMES = [
	'flat', 'labels', 'switch-processor', 'switch-output', 'broker-output',
	'branch', 'try-catch', 'workflow', 'nested', 'resources',
	'fallback', 'retry', 'while', 'parallel', 'shared-processors', 'batching',
];

export interface Fixture {
	readonly name: string;
	readonly yaml: string;
	readonly model: PipelineModel;
}

/** Reads a fixture pair; the JSON must pass the protocol's own model check to be typed. */
export function fixture(name: string): Fixture {
	const yaml = fs.readFileSync(path.join(FIXTURES, `${name}.yaml`), 'utf8');
	const json: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.model.json`), 'utf8'));
	assert.ok(isPipelineModel(json), `${name}.model.json is a PipelineModel`);
	return { name, yaml, model: json };
}
