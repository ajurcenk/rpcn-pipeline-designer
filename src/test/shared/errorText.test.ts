import * as assert from 'assert';
import { errorText } from '../../shared/errorText';

// Story 55 (story 50 group B): the one text of a thrown value, shared by every layer.

suite('shared/errorText (story 55)', () => {
	test('an Error gives its message; anything else String() of it', () => {
		assert.strictEqual(errorText(new Error('boom')), 'boom');
		assert.strictEqual(errorText(new TypeError('bad type')), 'bad type');
		assert.strictEqual(errorText('plain'), 'plain');
		assert.strictEqual(errorText({ message: 'not an Error' }), '[object Object]');
		assert.strictEqual(errorText(undefined), 'undefined');
		assert.strictEqual(errorText(42), '42');
	});
});
