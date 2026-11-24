import * as assert from 'assert';
import * as path from 'path';
import { agentFolders, buildAgentEnv, keyVariable, PASS_THROUGH } from '../../../adapters/assistant/env';

// Story 8.1 (AD-26): the agent's whole environment, and nothing else of the extension host's.
suite('assistant environment (story 8.1)', () => {
	const base = {
		HOME: '/home/u', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
		ANTHROPIC_API_KEY: 'from-the-host', AWS_SECRET_ACCESS_KEY: 'aws', RPCN_BINARY: '/elsewhere', CLAUDE_CONFIG_DIR: '/home/u/.claude', XDG_CACHE_HOME: '/home/u/.cache',
	};
	const input = { baseEnv: base, baseUrl: 'https://adp.example/v1', auth: 'bearer' as const, apiKey: 'the-key-0001', model: 'claude-opus-5-5', rpcnBinary: '/opt/rpk', storageDir: '/gs' };

	test('bearer: the key as ANTHROPIC_AUTH_TOKEN only; every listed variable and no other', () => {
		const env = buildAgentEnv(input);
		const root = path.join('/gs', 'assistant');
		assert.deepStrictEqual(env, {
			HOME: '/home/u', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
			ANTHROPIC_BASE_URL: 'https://adp.example/v1',
			ANTHROPIC_AUTH_TOKEN: 'the-key-0001',
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5-5',
			ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-5-5',
			ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
			ANTHROPIC_SMALL_FAST_MODEL: 'claude-opus-5-5',
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
			DISABLE_AUTOUPDATER: '1',
			RPCN_BINARY: '/opt/rpk',
			CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
			UV_CACHE_DIR: path.join(root, 'uv-cache'),
			UV_PYTHON_INSTALL_DIR: path.join(root, 'uv-python'),
			UV_TOOL_DIR: path.join(root, 'uv-tools'),
			XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
			XDG_DATA_HOME: path.join(root, 'xdg-data'),
			XDG_STATE_HOME: path.join(root, 'xdg-state'),
			XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
			NO_COLOR: '1',
		});
		assert.ok(!('ANTHROPIC_API_KEY' in env), 'the host\'s own key does not pass through');
		assert.ok(!('AWS_SECRET_ACCESS_KEY' in env));
	});

	test('x-api-key: the key as ANTHROPIC_API_KEY only', () => {
		const env = buildAgentEnv({ ...input, auth: 'x-api-key' });
		assert.strictEqual(env.ANTHROPIC_API_KEY, 'the-key-0001');
		assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env));
		assert.strictEqual(keyVariable('bearer'), 'ANTHROPIC_AUTH_TOKEN');
		assert.strictEqual(keyVariable('x-api-key'), 'ANTHROPIC_API_KEY');
	});

	test('review 6: the proxy, CA and temp variables pass through when set, either case; unset ones are absent', () => {
		const env = buildAgentEnv({ ...input, baseEnv: {
			...base, HTTPS_PROXY: 'http://proxy:3128', http_proxy: 'http://proxy:3128', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
			SSL_CERT_FILE: '/etc/ssl.pem', TMPDIR: '/var/tmp', HTTP_PROXY: '',
		} });
		assert.strictEqual(env.HTTPS_PROXY, 'http://proxy:3128');
		assert.strictEqual(env.http_proxy, 'http://proxy:3128');
		assert.strictEqual(env.no_proxy, 'localhost');
		assert.strictEqual(env.NODE_EXTRA_CA_CERTS, '/etc/ca.pem');
		assert.strictEqual(env.SSL_CERT_FILE, '/etc/ssl.pem');
		assert.strictEqual(env.TMPDIR, '/var/tmp');
		assert.ok(!('HTTP_PROXY' in env) && !('NO_PROXY' in env) && !('https_proxy' in env));
		for (const name of PASS_THROUGH) {
			assert.ok(!(name in buildAgentEnv(input)), name);
		}
	});

	test('no folder the agent writes is under HOME; LANG falls back', () => {
		for (const dir of Object.values(agentFolders('/gs'))) {
			assert.ok(dir.startsWith(path.join('/gs', 'assistant') + path.sep), dir);
		}
		assert.strictEqual(buildAgentEnv({ ...input, baseEnv: { HOME: '/h', PATH: '/p' } }).LANG, 'C.UTF-8');
	});
});
