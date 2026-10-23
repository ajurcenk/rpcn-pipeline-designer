// Another user's home directory, for `~user` in path settings (story 2). Node only knows the
// current user's, so the system is asked: `getent passwd <user>` on Linux and other POSIX systems
// (it covers LDAP and NIS users; `/etc/passwd` when `getent` is not installed), Directory Services
// (`dscl /Search`, local and network accounts) on macOS. Synchronous, as path resolution is. A
// definite answer (a home, or no such user) is kept for the session; a lookup that failed (a
// timeout, a slow directory server) is not, so the next resolution asks again.
// Windows keeps `~` only: there is no lookup.

import { execFileSync } from 'child_process';
import * as fs from 'fs';

/** The home directory of a user, `undefined` when there is no such user or it can't be told. */
export type HomeOf = (user: string) => string | undefined;

const LOOKUP_TIMEOUT_MS = 2_000;
const cache = new Map<string, string | undefined>();

/** A lookup's answer; `definite: false` when the system could not be asked. */
interface Answer {
	readonly home: string | undefined;
	readonly definite: boolean;
}

/** The lookup for `platform`; `undefined` on Windows. */
export function userHomeLookup(platform: NodeJS.Platform = process.platform): HomeOf | undefined {
	if (platform === 'win32') {
		return undefined;
	}
	return (user) => {
		const key = `${platform}:${user}`;
		if (cache.has(key)) {
			return cache.get(key);
		}
		const answer = platform === 'darwin' ? fromDirectoryServices(user) : fromPasswd(user);
		if (answer.definite) {
			cache.set(key, answer.home);
		}
		return answer.home;
	};
}

/** `getent passwd <user>` (exit 2: no such user), else `/etc/passwd` when `getent` is not installed. */
function fromPasswd(user: string): Answer {
	let lines: string;
	try {
		lines = run('getent', ['passwd', user]);
	} catch (err) {
		const { status, code } = err as { status?: number | null; code?: string };
		if (status === 2) {
			return { home: undefined, definite: true };
		}
		if (code !== 'ENOENT') {
			return { home: undefined, definite: false }; // a timeout or another failure: ask again next time
		}
		try {
			lines = fs.readFileSync('/etc/passwd', 'utf8');
		} catch {
			return { home: undefined, definite: false };
		}
	}
	const line = lines.split('\n').find((l) => l.split(':')[0] === user);
	return { home: line?.split(':')[5] || undefined, definite: true };
}

/** `dscl /Search -read /Users/<user> NFSHomeDirectory` (it exits non-zero, saying so, for no such user). */
function fromDirectoryServices(user: string): Answer {
	try {
		const out = run('dscl', ['/Search', '-read', `/Users/${user}`, 'NFSHomeDirectory']);
		return { home: /^NFSHomeDirectory:\s*(\S.*?)\s*$/m.exec(out)?.[1], definite: true };
	} catch (err) {
		const { stderr } = err as { stderr?: string };
		return { home: undefined, definite: /eDSRecordNotFound|DS Error: -14136/.test(stderr ?? '') };
	}
}

function run(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
}
