// Red Hat YAML schema contributor (AD-11): serves the binary's schema (AD-10) as content under
// our own `rpcn-schema` URI scheme, to the documents the DetectionRegistry (AD-18) accepts only.
// The JSON comes from the in-memory SchemaStore snapshot; the cache file is never read here.
//
// Red Hat YAML (>= 1.24.0) calls `requestSchema` and `requestSchemaContent` on every
// validation, hover and completion and caches neither, so both answer from memory: the URI
// embeds the snapshot's hash (a new binary or transform gives a new URI) and the content is
// stringified once per snapshot. We never write `yaml.schemas` or any other setting.

import * as vscode from 'vscode';
import { schemaHash } from '../../core/schema';
import type { LogLine } from '../redpandaConnect/binary';
import type { SchemaSnapshot } from '../redpandaConnect/schema';

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export const REDHAT_YAML_EXTENSION_ID = 'redhat.vscode-yaml';

/** The `registerContributor` scheme key and the scheme of every schema URI we hand out. */
export const SCHEMA_SCHEME = 'rpcn-schema';

/** The part of the `redhat.vscode-yaml` exports we use. */
export interface RedHatYamlApi {
	registerContributor(
		schema: string,
		requestSchema: (resource: string) => string | undefined,
		requestSchemaContent: (uri: string) => string | PromiseLike<string> | undefined,
		label?: string,
	): boolean;
}

/** What the contributor needs from the SchemaStore. */
export interface SchemaSource {
	readonly current: SchemaSnapshot | undefined;
}

/** What the contributor needs from the DetectionRegistry. */
export interface DetectionLookup {
	isDetected(uri: string): boolean;
}

/** Served for our scheme while there is no schema snapshot. */
export const EMPTY_SCHEMA = '{}';

/** `rpcn-schema://schema/<hash>.json` for a snapshot. */
export function schemaUriFor(snapshot: SchemaSnapshot): string {
	return `${SCHEMA_SCHEME}://schema/${schemaHash(snapshot.path, snapshot.version)}.json`;
}

/** The two Red Hat callbacks, over the current schema snapshot and the detection registry. */
export class SchemaContributor {
	private cachedFor: SchemaSnapshot | undefined;
	private cachedText = '';

	constructor(private readonly schemas: SchemaSource, private readonly detection: DetectionLookup) {}

	/** Synchronous (Red Hat sends a Promise as `{}`): our schema URI for a detected document, else nothing. */
	readonly requestSchema = (resource: string): string | undefined => {
		const snapshot = this.schemas.current;
		if (!snapshot || !this.detection.isDetected(resource)) {
			return undefined;
		}
		return schemaUriFor(snapshot);
	};

	/**
	 * The current snapshot's JSON, stringified once per snapshot. A URI naming an older hash
	 * still gets the current schema. With no schema at all, an empty schema (`{}`): Red Hat
	 * 1.24.0 throws on `undefined` content and reports a previously served URI as unloadable.
	 */
	readonly requestSchemaContent = (_uri: string): string => {
		const snapshot = this.schemas.current;
		if (!snapshot) {
			return EMPTY_SCHEMA;
		}
		if (snapshot !== this.cachedFor) {
			this.cachedText = JSON.stringify(snapshot.json);
			this.cachedFor = snapshot;
		}
		return this.cachedText;
	};
}

/** Finds and activates Red Hat YAML; resolves with its API, or with the reason it is unusable. Never rejects. */
export type RedHatYamlLoader = () => Promise<{ api: RedHatYamlApi } | { reason: string }>;

/** The slice of `vscode.Extension` the loader uses. */
export interface ExtensionHandle {
	readonly isActive: boolean;
	readonly exports: unknown;
	activate(): Thenable<unknown>;
}

/** Builds a loader over `getExtension` (defaults to `vscode.extensions.getExtension`; tests pass a fake). */
export function createRedHatYamlLoader(
	getExtension: (id: string) => ExtensionHandle | undefined = (id) => vscode.extensions.getExtension(id),
): RedHatYamlLoader {
	return () => loadWith(getExtension);
}

async function loadWith(getExtension: (id: string) => ExtensionHandle | undefined): ReturnType<RedHatYamlLoader> {
	const extension = getExtension(REDHAT_YAML_EXTENSION_ID);
	if (!extension) {
		return { reason: `${REDHAT_YAML_EXTENSION_ID} is not installed` };
	}
	// Not named `exports`: that would shadow the CommonJS `exports` this module's own constants compile to.
	let exported: unknown;
	try {
		exported = extension.isActive ? extension.exports : await extension.activate();
	} catch (err) {
		return { reason: `${REDHAT_YAML_EXTENSION_ID} failed to activate: ${errorText(err)}` };
	}
	if (typeof (exported as Partial<RedHatYamlApi> | undefined)?.registerContributor !== 'function') {
		return { reason: `${REDHAT_YAML_EXTENSION_ID} does not export registerContributor` };
	}
	return { api: exported as RedHatYamlApi };
}

export const loadRedHatYaml: RedHatYamlLoader = createRedHatYamlLoader();

export interface RegisterOptions {
	readonly contributor: SchemaContributor;
	readonly log: LogLine;
	/** Defaults to the real `redhat.vscode-yaml` lookup (tests pass a fake). */
	readonly load?: RedHatYamlLoader;
}

/**
 * Registers exactly one contributor under `rpcn-schema`. Resolves with whether it was
 * registered; every failure is logged once and never thrown.
 */
export async function registerSchemaContributor(options: RegisterOptions): Promise<boolean> {
	const { contributor, log } = options;
	const fail = (detail: string) => {
		log(`Schema: completion and hover from the Redpanda Connect schema are unavailable: ${detail}.`);
		return false;
	};
	let loaded: Awaited<ReturnType<RedHatYamlLoader>>;
	try {
		loaded = await (options.load ?? loadRedHatYaml)();
	} catch (err) {
		return fail(`${REDHAT_YAML_EXTENSION_ID} could not be loaded: ${errorText(err)}`);
	}
	if ('reason' in loaded) {
		return fail(loaded.reason);
	}
	let registered: boolean;
	try {
		registered = loaded.api.registerContributor(SCHEMA_SCHEME, contributor.requestSchema, contributor.requestSchemaContent);
	} catch (err) {
		return fail(`registerContributor("${SCHEMA_SCHEME}") threw: ${errorText(err)}`);
	}
	if (registered === false) {
		return fail(`${REDHAT_YAML_EXTENSION_ID} already has a schema contributor named "${SCHEMA_SCHEME}"`);
	}
	return true;
}
