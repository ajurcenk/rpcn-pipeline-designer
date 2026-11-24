import * as assert from 'assert';
import { designNoteStatus, isDesignNote } from '../../core/designNote';

// Story 8.1 (AD-26, stage from files): a design note's frontmatter `status`, as the assistant view shows it.
suite('assistant design note status (story 8.1)', () => {
	test('the frontmatter status, quotes and a comment dropped', () => {
		assert.strictEqual(designNoteStatus('---\nartifact: design\nstatus: ready\n---\n# x\n'), 'ready');
		assert.strictEqual(designNoteStatus('---\r\nstatus: "draft"\r\n---\r\n'), 'draft');
		assert.strictEqual(designNoteStatus('﻿---\nstatus: \'ready\'  # all decided\n---\n'), 'ready');
	});

	test('no frontmatter, no status in it, or a status only in the body: none', () => {
		assert.strictEqual(designNoteStatus('# x\nstatus: ready\n'), null);
		assert.strictEqual(designNoteStatus('---\nartifact: design\n---\nstatus: ready\n'), null);
		assert.strictEqual(designNoteStatus('---\nstatus:\n---\n'), null);
		assert.strictEqual(designNoteStatus(''), null);
	});

	test('review 19: an unclosed frontmatter has no status; a quoted value keeps a # inside its quotes', () => {
		assert.strictEqual(designNoteStatus('---\nstatus: ready\n# no closing line\n'), null);
		assert.strictEqual(designNoteStatus('---\nstatus: "re#ady" # a comment\n---\n'), 're#ady');
		assert.strictEqual(designNoteStatus('---\nstatus: \'a # b\'\n---\n'), 'a # b');
		assert.strictEqual(designNoteStatus('---\nstatus: ready#x\n---\n'), 'ready#x');
	});

	test('a design note is a *.design.md file', () => {
		assert.ok(isDesignNote('orders_to_api.design.md'));
		assert.ok(!isDesignNote('orders.md'));
		assert.ok(!isDesignNote('orders.design.md.bak'));
	});
});
