// Pure, versioned schema transform (AD-10). Input: the binary's `list --format jsonschema`
// output plus, optionally, its `list --format json-full` docs. Output: the schema served to
// Red Hat YAML (epic 2) and read by the ComponentCatalog (epic 3).
//
// Raw schema shape (spike 1.1, Q4): top-level `definitions` + `properties`; components at
// `definitions.<cat>.allOf[0].anyOf[i].properties.<name>`; `$ref`s to `#/definitions/<cat>`;
// custom `is_*` keys on every node; no `$schema`, `description`, `examples` or `default`.
//
// The transform:
//   1. adds `"$schema": "http://json-schema.org/draft-07/schema#"` (first key);
//   2. lets every `number` / `integer` / `boolean` node also accept a `${VAR}` string;
//   3. drops every `required`: Red Hat drops a component's `anyOf` branch while a required
//      field is missing, and with it every completion for that component; lint on save is the
//      validation for missing fields (AD-12; ticket 2.13);
//   4. keeps every other key (including `is_*`) as is;
//   5. merges json-full docs: field `description` + `examples` → `markdownDescription`,
//      field `default` → `default`, component `summary` → the component's `markdownDescription`,
//      field `options` / `annotated_options` → value suggestions on a string node (or the
//      string items of an array field):
//      `anyOf: [{type: string, enum, markdownEnumDescriptions}, {type: string}]` (any string
//      stays valid, e.g. `delim:foobar`; ticket 2.13).
// A field or component missing on either side is skipped, never an error.
//
// Bump TRANSFORM_VERSION whenever the output for the same input changes: it is part of the
// schema cache key, so a new extension version never serves a schema cached by an old one.

import { createHash } from 'crypto';

export const TRANSFORM_VERSION = 2;

export const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** `${VAR}` / `${VAR:default}` env-var interpolation (whole value). */
export const INTERPOLATION_PATTERN = '^\\$\\{[^}]+\\}$';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

/** json-full category key → jsonschema `definitions` key. */
export const DOC_CATEGORIES: Readonly<Record<string, string>> = {
	buffers: 'buffer',
	caches: 'cache',
	inputs: 'input',
	metrics: 'metrics',
	outputs: 'output',
	processors: 'processor',
	'rate-limits': 'rate_limit',
	scanners: 'scanner',
	tracers: 'tracer',
};

const INTERPOLATED_TYPES = new Set(['number', 'integer', 'boolean']);

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses `list --format jsonschema` stdout. Returns `undefined` unless it is a JSON object
 * with an object `definitions` or `properties`.
 */
export function parseRawSchema(stdout: string): JsonObject | undefined {
	const parsed = tryParse(stdout);
	if (!isJsonObject(parsed) || !(isJsonObject(parsed.definitions) || isJsonObject(parsed.properties))) {
		return undefined;
	}
	return parsed;
}

/** Parses `list --format json-full` stdout. Returns `undefined` unless it is a JSON object. */
export function parseDocs(stdout: string): JsonObject | undefined {
	const parsed = tryParse(stdout);
	return isJsonObject(parsed) ? parsed : undefined;
}

/**
 * Parses a cached, already transformed schema. Returns `undefined` unless it parses and
 * carries this transform's `$schema`.
 */
export function parseCachedSchema(text: string): JsonObject | undefined {
	const parsed = tryParse(text);
	return isJsonObject(parsed) && parsed.$schema === DRAFT_07 ? parsed : undefined;
}

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The cache-key hash: `hash(path + version + TRANSFORM_VERSION)`, 16 hex characters. */
export function schemaHash(binaryPath: string, version: string, transformVersion = TRANSFORM_VERSION): string {
	return createHash('sha256')
		.update(`${binaryPath}\0${version}\0${transformVersion}`)
		.digest('hex')
		.slice(0, 16);
}

/** The cache file name for a binary: `schema-<hash>.json`. */
export function schemaFileName(binaryPath: string, version: string): string {
	return `schema-${schemaHash(binaryPath, version)}.json`;
}

/** Matches exactly the cache file names `schemaFileName` produces (`schema-<16 hex>.json`), for cleanup. */
export const SCHEMA_FILE_PATTERN = /^schema-[0-9a-f]{16}\.json$/;

/**
 * The transform. Pure and deterministic: `raw` and `docs` are not modified, and the same
 * input always yields the same output (key order included).
 */
export function transformSchema(raw: JsonObject, docs?: JsonObject): JsonObject {
	const body = structuredClone(raw);
	delete body.$schema;
	allowInterpolation(body);
	dropRequired(body);
	if (docs) {
		mergeDocs(body, docs);
	}
	return { $schema: DRAFT_07, ...body };
}

// ---- interpolation -------------------------------------------------------------------

/** Schema-node children: the keywords whose values are sub-schemas. */
function forEachSubSchema(node: JsonObject, visit: (child: JsonObject) => void): void {
	for (const key of ['properties', 'patternProperties', 'definitions'] as const) {
		const map = node[key];
		if (isJsonObject(map)) {
			for (const child of Object.values(map)) {
				if (isJsonObject(child)) {
					visit(child);
				}
			}
		}
	}
	for (const key of ['items', 'additionalProperties', 'not'] as const) {
		const child = node[key];
		if (isJsonObject(child)) {
			visit(child);
		} else if (key === 'items' && Array.isArray(child)) {
			child.filter(isJsonObject).forEach(visit);
		}
	}
	for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
		const list = node[key];
		if (Array.isArray(list)) {
			list.filter(isJsonObject).forEach(visit);
		}
	}
}

/**
 * Rewrites every node whose `type` is `number`, `integer` or `boolean` in place:
 * `{type: T, ...rest}` → `{...rest, anyOf: [{type: T}, {type: 'string', pattern: '^\$\{[^}]+\}$'}]}`.
 * `rest` (the `is_*` keys, later the docs) stays on the outer node, where editors read it.
 */
function allowInterpolation(node: JsonObject): void {
	forEachSubSchema(node, allowInterpolation);
	const type = node.type;
	if (typeof type !== 'string' || !INTERPOLATED_TYPES.has(type) || node.anyOf !== undefined) {
		return;
	}
	const typed: JsonObject = { type };
	for (const key of ['enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const) {
		if (node[key] !== undefined) {
			typed[key] = node[key];
			delete node[key];
		}
	}
	delete node.type;
	node.anyOf = [typed, { type: 'string', pattern: INTERPOLATION_PATTERN }];
}

/** Removes `required` from every node (step 3). */
function dropRequired(node: JsonObject): void {
	forEachSubSchema(node, dropRequired);
	delete node.required;
}

// ---- json-full doc merge -------------------------------------------------------------

function mergeDocs(schema: JsonObject, docs: JsonObject): void {
	// Top-level config fields (`http`, `input`, `pipeline`, `logger`, …) → `properties.<name>`.
	const rootFields = docs.config;
	if (Array.isArray(rootFields) && isJsonObject(schema.properties)) {
		applyChildren(schema, rootFields);
	}

	const definitions = schema.definitions;
	if (!isJsonObject(definitions)) {
		return;
	}
	for (const [docKey, category] of Object.entries(DOC_CATEGORIES)) {
		const components = docs[docKey];
		const nodes = componentNodes(definitions[category]);
		if (!Array.isArray(components) || nodes.size === 0) {
			continue;
		}
		for (const component of components) {
			if (!isJsonObject(component) || typeof component.name !== 'string') {
				continue;
			}
			const node = nodes.get(component.name);
			if (!node) {
				continue;
			}
			if (typeof component.summary === 'string' && component.summary.trim()) {
				node.markdownDescription = component.summary.trim();
			}
			if (isJsonObject(component.config)) {
				// The config root describes the component node's own shape (scalar, array of objects, …).
				applyChildrenByKind(node, component.config);
			}
		}
	}
}

/** `definitions.<cat>.allOf[0].anyOf[i].properties.<name>` → node, by component name. */
function componentNodes(category: JsonValue | undefined): Map<string, JsonObject> {
	const nodes = new Map<string, JsonObject>();
	if (!isJsonObject(category) || !Array.isArray(category.allOf)) {
		return nodes;
	}
	for (const part of category.allOf) {
		if (!isJsonObject(part) || !Array.isArray(part.anyOf)) {
			continue;
		}
		for (const option of part.anyOf) {
			if (!isJsonObject(option) || !isJsonObject(option.properties)) {
				continue;
			}
			for (const [name, node] of Object.entries(option.properties)) {
				if (isJsonObject(node) && !nodes.has(name)) {
					nodes.set(name, node);
				}
			}
		}
	}
	return nodes;
}

/** Applies one json-full field's docs to its schema node, then recurses into its children. */
function applyField(node: JsonObject, field: JsonObject): void {
	const markdown = fieldMarkdown(field);
	if (markdown) {
		node.markdownDescription = markdown;
	}
	if (field.default !== undefined) {
		node.default = structuredClone(field.default);
	}
	applyOptions(node, field);
	applyChildrenByKind(node, field);
}

interface FieldOption {
	readonly value: string;
	readonly description?: string;
}

/** A field's `annotated_options` (`[value, description]` pairs), else its `options` (strings). */
function optionsOf(field: JsonObject): FieldOption[] {
	const seen = new Set<string>();
	const out: FieldOption[] = [];
	const add = (value: unknown, description?: unknown) => {
		if (typeof value === 'string' && value !== '' && !seen.has(value)) {
			seen.add(value);
			out.push({ value, description: typeof description === 'string' && description.trim() ? description.trim() : undefined });
		}
	};
	if (Array.isArray(field.annotated_options)) {
		for (const pair of field.annotated_options) {
			if (Array.isArray(pair)) {
				add(pair[0], pair[1]);
			}
		}
	}
	if (out.length === 0 && Array.isArray(field.options)) {
		field.options.forEach((value) => add(value));
	}
	return out;
}

/**
 * Value suggestions (step 5): a string scalar, or the string items of an array field, gains
 * `anyOf: [{type: string, enum, markdownEnumDescriptions?}, {type: string}]`. Nodes of another
 * type, or that already have `anyOf` / `enum`, are left alone.
 */
function applyOptions(node: JsonObject, field: JsonObject): void {
	const options = optionsOf(field);
	if (options.length === 0) {
		return;
	}
	const kind = typeof field.kind === 'string' ? field.kind : 'scalar';
	const target = kind === 'scalar' ? node : kind === 'array' && isJsonObject(node.items) ? node.items : undefined;
	if (!target || target.type !== 'string' || target.anyOf !== undefined || target.enum !== undefined) {
		return;
	}
	const suggestion: JsonObject = { type: 'string', enum: options.map((o) => o.value) };
	if (options.some((o) => o.description)) {
		suggestion.markdownEnumDescriptions = options.map((o) => o.description ?? '');
	}
	target.anyOf = [suggestion, { type: 'string' }];
}

/** Descends from a field's node to the node holding its children, according to `kind`. */
function applyChildrenByKind(node: JsonObject, field: JsonObject): void {
	if (!Array.isArray(field.children) || field.children.length === 0) {
		return;
	}
	const element = elementNode(node, typeof field.kind === 'string' ? field.kind : 'scalar');
	if (element) {
		applyChildren(element, field.children);
	}
}

function elementNode(node: JsonObject, kind: string): JsonObject | undefined {
	switch (kind) {
		case 'array':
			return isJsonObject(node.items) ? node.items : undefined;
		case '2darray':
			return isJsonObject(node.items) && isJsonObject(node.items.items) ? node.items.items : undefined;
		case 'map': {
			const pattern = node.patternProperties;
			if (isJsonObject(pattern) && isJsonObject(pattern['.'])) {
				return pattern['.'];
			}
			return isJsonObject(node.additionalProperties) ? node.additionalProperties : undefined;
		}
		default:
			return node;
	}
}

function applyChildren(parent: JsonObject, children: JsonValue[]): void {
	const properties = parent.properties;
	if (!isJsonObject(properties)) {
		return;
	}
	for (const child of children) {
		if (!isJsonObject(child) || typeof child.name !== 'string' || !child.name) {
			continue;
		}
		const node = properties[child.name];
		if (isJsonObject(node)) {
			applyField(node, child);
		}
	}
}

/** `description`, then the `examples` as a fenced YAML list. `undefined` when both are empty. */
export function fieldMarkdown(field: JsonObject): string | undefined {
	const parts: string[] = [];
	if (typeof field.description === 'string' && field.description.trim()) {
		parts.push(field.description.trim());
	}
	if (Array.isArray(field.examples) && field.examples.length > 0) {
		parts.push(`Examples:\n\n\`\`\`yaml\n${toYamlList(field.examples)}\n\`\`\``);
	}
	return parts.length ? parts.join('\n\n') : undefined;
}

// ---- minimal YAML emitter for examples ---------------------------------------------

/** Renders `items` as a block YAML sequence (one `- ` entry per item). */
export function toYamlList(items: readonly JsonValue[]): string {
	return emitSequence(items, '');
}

function emitSequence(items: readonly JsonValue[], indent: string): string {
	if (items.length === 0) {
		return `${indent}[]`;
	}
	return items.map((item) => `${indent}- ${emitNested(item, `${indent}  `)}`).join('\n');
}

/** The text after `- ` or `key: `, whose continuation lines start with `indent`. */
function emitNested(value: JsonValue, indent: string): string {
	if (Array.isArray(value)) {
		return value.length === 0 ? '[]' : emitSequence(value, indent).slice(indent.length);
	}
	if (isJsonObject(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) {
			return '{}';
		}
		return entries.map(([key, v], i) => `${i === 0 ? '' : indent}${emitKey(key)}:${emitValueAfterKey(v, indent)}`)
			.join('\n');
	}
	return emitScalar(value, indent);
}

function emitValueAfterKey(value: JsonValue, indent: string): string {
	const childIndent = `${indent}  `;
	if (Array.isArray(value) && value.length > 0) {
		return `\n${emitSequence(value, childIndent)}`;
	}
	if (isJsonObject(value) && Object.keys(value).length > 0) {
		return `\n${childIndent}${emitNested(value, childIndent)}`;
	}
	return ` ${emitNested(value, childIndent)}`;
}

function emitKey(key: string): string {
	return isPlainSafe(key) ? key : JSON.stringify(key);
}

function emitScalar(value: null | boolean | number | string, indent: string): string {
	if (value === null) {
		return 'null';
	}
	if (typeof value !== 'string') {
		return String(value);
	}
	// Multi-line text (Bloblang mappings, …) as a block literal: `|-` without a trailing
	// newline, `|` with exactly one. Anything a block literal cannot carry exactly is quoted.
	const body = value.endsWith('\n') ? value.slice(0, -1) : value;
	if (body.includes('\n') && !body.endsWith('\n') && !/^\s/.test(body) && !/[\r\t]|[ ]\n|[ ]$/.test(body)) {
		const lines = body.split('\n').map((line) => (line ? `${indent}${line}` : ''));
		return `|${body === value ? '-' : ''}\n${lines.join('\n')}`;
	}
	return isPlainSafe(value) ? value : JSON.stringify(value);
}

const YAML_RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const NUMBER_LIKE = /^[-+]?(?:\.?\d|0x|0o|\.inf|\.nan)/i;

/** A conservative plain-scalar test: anything doubtful is double-quoted (JSON is valid YAML). */
function isPlainSafe(value: string): boolean {
	return value.length > 0
		&& /^[A-Za-z0-9_/.(][^\n]*$/.test(value)
		&& !/[:#]\s|\s#|\s$|:$|[{}[\],&*!|>'"%@`]/.test(value)
		&& !YAML_RESERVED.test(value)
		&& !NUMBER_LIKE.test(value);
}
