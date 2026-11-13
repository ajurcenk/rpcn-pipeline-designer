import * as assert from 'assert';
import { stoppedReadingStatus, stoppedSearchStatus } from '../../../adapters/vscode/logsPanel';

// Story 56: the Pipeline Logs panel's own status texts, their counts written with `logsText.ts`'s
// `countText`, pinned as the panel wrote them before.

suite('Pipeline logs panel texts (story 56)', () => {
	test('Stop reading\'s status lines count the records read', () => {
		assert.strictEqual(stoppedReadingStatus('the last hour', 1), 'Stopped reading the last hour: 1 record read. Live is off.');
		assert.strictEqual(stoppedReadingStatus('the last hour', 2140), 'Stopped reading the last hour: 2,140 records read. Live is off.');
		assert.strictEqual(stoppedSearchStatus(1), 'Stopped looking for the newest ERROR record: 1 record read. Live is off.');
		assert.strictEqual(stoppedSearchStatus(2140), 'Stopped looking for the newest ERROR record: 2,140 records read. Live is off.');
	});
});
