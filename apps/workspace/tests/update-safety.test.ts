import test from 'node:test';
import assert from 'node:assert/strict';
import { updateBlockReason, type UpdateSafety } from '../shared/update-safety';
import { getPendingWriteCount, subscribePendingWrites } from '../src/pending-writes';
import { api } from '../src/api';

const safe: UpdateSafety = { pendingWrites: 0, clockPending: false, unsavedChanges: false, busy: false, workflowOpen: false, formHasChanges: false, accountSetup: false };
test('updates remain blocked for uncertain clock work, unsaved changes and account verification', () => {
  assert.equal(updateBlockReason(safe), '');
  for (const field of ['clockPending', 'unsavedChanges', 'busy', 'workflowOpen', 'formHasChanges', 'accountSetup'] as const) {
    assert.notEqual(updateBlockReason({ ...safe, [field]: true }), '', field);
  }
  assert.match(updateBlockReason({ ...safe, clockPending: true, pendingWrites: 1 }), /Retry or Refresh/);
  assert.match(updateBlockReason({ ...safe, pendingWrites: 1 }), /finish/);
});

test('actual API writes remain pending through response parsing and failures; GET polling does not block updates', async () => {
  const originalFetch = globalThis.fetch;
  const releases: Array<(response: Response) => void> = [];
  const counts: number[] = [];
  const unsubscribe = subscribePendingWrites(() => counts.push(getPendingWriteCount()));
  globalThis.fetch = (() => new Promise<Response>(resolve => releases.push(resolve))) as typeof fetch;
  try {
    const first = api('/synthetic-command', { operation: 'test' });
    const second = api('/synthetic-command', undefined, 'DELETE');
    const read = api('/synthetic-read');
    assert.equal(getPendingWriteCount(), 2);
    releases[2](new Response('{}'));
    await read;
    assert.equal(getPendingWriteCount(), 2);
    let parsed!: (value: unknown) => void;
    releases[0]({ ok: true, json: () => new Promise(resolve => { parsed = resolve; }) } as Response);
    await Promise.resolve();
    assert.equal(getPendingWriteCount(), 2);
    parsed({ saved: true });
    await first;
    assert.equal(getPendingWriteCount(), 1);
    releases[1](new Response('unavailable', { status: 503 }));
    await assert.rejects(second);
    assert.equal(getPendingWriteCount(), 0);
    globalThis.fetch = (async () => { throw new TypeError('synthetic network failure'); }) as typeof fetch;
    await assert.rejects(api('/synthetic-command', {}));
    assert.equal(getPendingWriteCount(), 0);
    assert.deepEqual(counts, [1, 2, 1, 0, 1, 0]);
  } finally { unsubscribe(); globalThis.fetch = originalFetch; }
});
