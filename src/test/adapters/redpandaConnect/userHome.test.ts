import * as assert from 'assert';
import * as os from 'os';
import { userHomeLookup } from '../../../adapters/redpandaConnect/userHome';

suite('adapters/redpandaConnect userHome (story 2)', () => {
	test('Windows has no lookup', () => {
		assert.strictEqual(userHomeLookup('win32'), undefined);
	});

	test('the current user\'s home, as Node knows it; an unknown user has none', function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const homeOf = userHomeLookup()!;
		assert.strictEqual(homeOf(os.userInfo().username), os.userInfo().homedir);
		assert.strictEqual(homeOf('no_such_user_rpcn_story2'), undefined);
	});
});
