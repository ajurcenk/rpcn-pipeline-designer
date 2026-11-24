// The agent's whole environment (AD-26, story 8.1): the SDK's `env` replaces the process environment,
// so the adapter builds it, and nothing else of the extension host's environment reaches the agent.
//   - `HOME`, `PATH`, `LANG` (from the extension host);
//   - `ANTHROPIC_BASE_URL` and the key, as `ANTHROPIC_AUTH_TOKEN` (bearer, the default) or
//     `ANTHROPIC_API_KEY` (x-api-key), never both;
//   - the four model variables, all the chosen model (no background call names another);
//   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`;
//   - `RPCN_BINARY`, the binary AD-9 resolved;
//   - `CLAUDE_CONFIG_DIR`, `uv`'s and the XDG folders under the extension's global storage, so the
//     agent writes nothing under the user's home;
//   - review 6: when set, the network and temp variables a proxy or a private CA needs
//     (`PASS_THROUGH`), as they are.
// No `vscode` or SDK import.

import * as path from 'path';
import type { AssistantAuth } from './host';

export interface AgentEnvInput {
	readonly baseEnv: Readonly<Record<string, string | undefined>>;
	readonly baseUrl: string;
	readonly auth: AssistantAuth;
	readonly apiKey: string;
	readonly model: string;
	readonly rpcnBinary: string;
	readonly storageDir: string;
}

/** Passed through when set (either case for the proxy ones): an endpoint behind a proxy or a private CA. */
export const PASS_THROUGH = [
	'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'TMPDIR',
] as const;

/** The folder under global storage the agent's own files go to. */
export const AGENT_STORAGE = 'assistant';

/** The environment variable the key goes in, for `auth`. */
export function keyVariable(auth: AssistantAuth): 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' {
	return auth === 'x-api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
}

/** The folders the agent's environment points under `storageDir` (created by the adapter before a run). */
export function agentFolders(storageDir: string): Readonly<Record<string, string>> {
	const root = path.join(storageDir, AGENT_STORAGE);
	return {
		CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
		UV_CACHE_DIR: path.join(root, 'uv-cache'),
		UV_PYTHON_INSTALL_DIR: path.join(root, 'uv-python'),
		UV_TOOL_DIR: path.join(root, 'uv-tools'),
		XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
		XDG_DATA_HOME: path.join(root, 'xdg-data'),
		XDG_STATE_HOME: path.join(root, 'xdg-state'),
		XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
	};
}

/** The agent's environment: only these variables, nothing else from `baseEnv`. */
export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
	const passed: Record<string, string> = {};
	for (const name of PASS_THROUGH) {
		const value = input.baseEnv[name];
		if (value) {
			passed[name] = value;
		}
	}
	return {
		...passed,
		HOME: input.baseEnv.HOME ?? '',
		PATH: input.baseEnv.PATH ?? '',
		LANG: input.baseEnv.LANG || 'C.UTF-8',
		ANTHROPIC_BASE_URL: input.baseUrl,
		[keyVariable(input.auth)]: input.apiKey,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: input.model,
		ANTHROPIC_DEFAULT_SONNET_MODEL: input.model,
		ANTHROPIC_DEFAULT_OPUS_MODEL: input.model,
		ANTHROPIC_SMALL_FAST_MODEL: input.model,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		DISABLE_AUTOUPDATER: '1',
		RPCN_BINARY: input.rpcnBinary,
		...agentFolders(input.storageDir),
		NO_COLOR: '1',
	};
}
