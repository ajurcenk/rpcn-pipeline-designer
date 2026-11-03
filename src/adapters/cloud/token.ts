// The Redpanda Cloud token (AD-23, ticket 5.2): `POST {auth}/oauth/token` with the service
// account's client credentials, cached in memory for `expires_in` less a margin, one per window and
// service account (the organization has 100 tokens a day). Concurrent callers share one request. The
// token is never logged, written or shown; a 401 means the client ID or secret is wrong. The account's
// name comes from the token's `client_name` claim. No `vscode` import.

import { CloudError } from './errors';
import { type HttpOptions, joinUrl, requestJson } from './http';

export const TOKEN_AUDIENCE = 'cloudv2-production.redpanda.cloud';
/** A cached token is dropped this long before it expires. */
export const TOKEN_MARGIN_MS = 5 * 60_000;
/** The claim holding the service account's name. */
export const CLIENT_NAME_CLAIM = 'https://cloud.redpanda.com/client_name';

export interface ServiceAccount {
	readonly clientId: string;
	readonly clientSecret: string;
}

export interface Token {
	readonly accessToken: string;
	/** The token's `client_name` claim, if it has one. */
	readonly clientName?: string;
	/** When the cache drops it (`Date.now()` ms). */
	readonly expiresAt: number;
}

export interface TokenCacheOptions extends HttpOptions {
	/** `https://auth.prd.cloud.redpanda.com` (the test seam replaces it). */
	readonly authUrl: () => string;
	readonly now?: () => number;
	readonly marginMs?: number;
}

/** The payload of a JWT (`undefined` when `token` is not one). */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
	const part = token.split('.')[1];
	if (!part) {
		return undefined;
	}
	try {
		const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
		const claims = JSON.parse(json) as unknown;
		return claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

export class TokenCache {
	private readonly tokens = new Map<string, Token>();
	private readonly pending = new Map<string, Promise<Token>>();
	/** Bumped by `clear`, so a request started before it is not cached. */
	private generation = 0;
	/** Token requests sent (the test seam). */
	requests = 0;

	constructor(private readonly options: TokenCacheOptions) {}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** The cached token's secret values, for masking. */
	values(): string[] {
		return [...this.tokens.values()].map((t) => t.accessToken);
	}

	/**
	 * The account's token: the cached one while it is valid, else a new one (shared by concurrent
	 * callers). With `fresh`, a new one is requested whatever is cached, and replaces the cached one
	 * only when it is granted (a connect testing a new secret keeps the valid token on a failure).
	 */
	get(account: ServiceAccount, options: { readonly fresh?: boolean } = {}): Promise<Token> {
		const key = account.clientId;
		const generation = this.generation;
		const keep = (token: Token) => {
			if (generation === this.generation) {
				this.tokens.set(key, token);
			}
			return token;
		};
		if (options.fresh) {
			return this.request(account).then(keep);
		}
		const cached = this.tokens.get(key);
		if (cached && cached.expiresAt > this.now()) {
			return Promise.resolve(cached);
		}
		this.tokens.delete(key);
		const running = this.pending.get(key);
		if (running) {
			return running;
		}
		const request = this.request(account).then(keep).finally(() => {
			if (this.pending.get(key) === request) {
				this.pending.delete(key);
			}
		});
		this.pending.set(key, request);
		return request;
	}

	/**
	 * Drops `accessToken` from the cache (an API refused it), unless a newer one replaced it. Unlike
	 * `clear`, a request already on its way is kept: it is the new token the caller waits for.
	 */
	invalidate(accessToken: string): void {
		for (const [key, token] of this.tokens) {
			if (token.accessToken === accessToken) {
				this.tokens.delete(key);
			}
		}
	}

	/** Drops the cached token of `clientId` (every one without it). */
	clear(clientId?: string): void {
		this.generation++;
		if (clientId === undefined) {
			this.tokens.clear();
			this.pending.clear();
		} else {
			this.tokens.delete(clientId);
			this.pending.delete(clientId);
		}
	}

	private async request(account: ServiceAccount): Promise<Token> {
		this.requests++;
		const body = await requestJson<{ access_token?: unknown; expires_in?: unknown }>(
			{ ...this.options, secrets: () => [account.clientSecret, ...(this.options.secrets?.() ?? [])] },
			'POST', joinUrl(this.options.authUrl(), '/oauth/token'),
			{
				form: { grant_type: 'client_credentials', client_id: account.clientId, client_secret: account.clientSecret, audience: TOKEN_AUDIENCE },
				tokenEndpoint: true,
			},
		);
		if (typeof body.access_token !== 'string' || !body.access_token) {
			throw new CloudError('api', 'the token endpoint answered without a token');
		}
		const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
		const margin = Math.min(this.options.marginMs ?? TOKEN_MARGIN_MS, (expiresIn * 1000) / 2);
		const name = jwtClaims(body.access_token)?.[CLIENT_NAME_CLAIM];
		return {
			accessToken: body.access_token,
			...(typeof name === 'string' && name ? { clientName: name } : {}),
			expiresAt: this.now() + expiresIn * 1000 - margin,
		};
	}
}
