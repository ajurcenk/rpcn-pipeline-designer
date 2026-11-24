import * as assert from 'assert';
import { maskHome } from '../../../adapters/vscode/assistantView';
import { normalBaseUrl, usableBaseUrl } from '../../../adapters/vscode/assistantAccess';

// Story 8.1 review: the home mask at path boundaries only (review 14), and the usable base URLs (review 3).
suite('assistant view masks and base URLs (story 8.1)', () => {
	test('review 14: the home folder is masked only as a whole path prefix', () => {
		const homes = ['/home/u'];
		assert.strictEqual(maskHome('read /home/u/notes.txt', homes), 'read ~/notes.txt');
		assert.strictEqual(maskHome('cwd is /home/u', homes), 'cwd is ~');
		assert.strictEqual(maskHome('"/home/u" and (/home/u)', homes), '"~" and (~)');
		assert.strictEqual(maskHome('/home/user2/x and /home/u2', homes), '/home/user2/x and /home/u2');
		assert.strictEqual(maskHome('/home/u.bak/x', homes), '/home/u.bak/x');
		assert.strictEqual(maskHome('/a/b', ['', '/']), '/a/b', 'no empty or root home');
	});

	test('review 3: https, or http on loopback only; no credentials in the URL', () => {
		assert.ok(usableBaseUrl('https://api.anthropic.com'));
		assert.ok(usableBaseUrl('http://127.0.0.1:4000'));
		assert.ok(usableBaseUrl('http://localhost:4000/v1'));
		assert.ok(usableBaseUrl('http://[::1]:4000'));
		assert.ok(!usableBaseUrl('http://adp.example.com'));
		assert.ok(!usableBaseUrl('http://127.0.0.1.example.com'));
		assert.ok(!usableBaseUrl('https://user:pw@adp.example.com'));
		assert.ok(!usableBaseUrl('ftp://adp.example.com'));
		assert.ok(!usableBaseUrl('not a url'));
		assert.strictEqual(normalBaseUrl('https://ADP.example.com/v1/'), 'https://adp.example.com/v1');
		assert.strictEqual(normalBaseUrl('https://adp.example.com'), 'https://adp.example.com');
		assert.strictEqual(normalBaseUrl(undefined), undefined);
	});
});
