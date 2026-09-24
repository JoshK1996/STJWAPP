import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createUpdateMonitor, type UpdateState, type UpdateMonitorBrowser } from '../src/pwa-runtime';

const current = 'a'.repeat(64);
const newer = 'b'.repeat(64);
const reply = (version: string) => Response.json({ version });

test('release discovery omits credentials and caches; rollback clears an available update', async () => {
  let version = current;
  let latest: UpdateState | undefined;
  const monitor = createUpdateMonitor({
    currentVersion: current, browser: null, onChange: value => { latest = value; },
    fetcher: async (url, options) => {
      assert.equal(url, '/app-version.json');
      assert.equal(options?.cache, 'no-store');
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal instanceof AbortSignal);
      return reply(version);
    },
  });
  await monitor.check();
  assert.deepEqual(latest, { available: false, checking: false, error: null, latestVersion: current });
  version = newer;
  await monitor.check();
  assert.equal(latest?.available, true);
  version = current;
  await monitor.check();
  assert.equal(latest?.available, false);
  monitor.dispose();
});

test('malformed, failed and redirected version responses never invent or erase a known update', async () => {
  let response = reply(newer);
  let latest: UpdateState | undefined;
  const monitor = createUpdateMonitor({ currentVersion: current, browser: null, onChange: value => { latest = value; }, fetcher: async () => response });
  await monitor.check();
  for (const invalid of [Response.json({ version: 'development' }), Response.json({ version: 7 }), new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), Response.json({}, { status: 503 }), new Response('', { status: 302 })]) {
    response = invalid;
    await monitor.check();
    assert.equal(latest?.available, true);
    assert.equal(latest?.latestVersion, newer);
    assert.equal(latest?.checking, false);
    assert.match(latest?.error ?? '', /Unable to check/);
  }
  response = reply(current);
  await monitor.check();
  assert.equal(latest?.error, null);
  assert.equal(latest?.available, false);
  monitor.dispose();
});

test('concurrent triggers share one request and disposal ignores late responses', async () => {
  let resolve!: (response: Response) => void;
  let calls = 0;
  const states: UpdateState[] = [];
  const monitor = createUpdateMonitor({ currentVersion: current, browser: null, onChange: value => states.push(value), fetcher: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = monitor.check();
  const second = monitor.check();
  assert.equal(first, second);
  assert.equal(calls, 1);
  monitor.dispose();
  resolve(reply(newer));
  await first;
  assert.deepEqual(states, [{ available: false, checking: true, error: null, latestVersion: null }]);
  await monitor.check();
  assert.equal(calls, 1);
});

test('bounded requests abort and release the next check after a network timeout', async () => {
  let latest: UpdateState | undefined;
  let calls = 0;
  const monitor = createUpdateMonitor({ currentVersion: current, browser: null, timeoutMs: 5, onChange: value => { latest = value; }, fetcher: async (_url, options) => {
    calls++;
    if (calls > 1) return reply(newer);
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await monitor.check();
  assert.equal(latest?.checking, false);
  assert.equal(latest?.available, false);
  assert.match(latest?.error ?? '', /Unable to check/);
  await monitor.check();
  assert.equal(latest?.available, true);
  monitor.dispose();
});

test('startup and browser resume check once; hidden tabs and disposed listeners do not request', async () => {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let calls = 0;
  const browser = { window, document } as unknown as UpdateMonitorBrowser;
  const monitor = createUpdateMonitor({ currentVersion: current, browser, onChange: () => {}, fetcher: async () => { calls++; return reply(current); } });
  await monitor.check();
  assert.equal(calls, 1);
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  assert.equal(calls, 1);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  await monitor.check();
  assert.equal(calls, 2);
  window.dispatchEvent(new Event('online'));
  await monitor.check();
  assert.equal(calls, 3);
  monitor.dispose();
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 3);
});

test('development has no deployed release identity and never offers an update', async () => {
  let requests = 0;
  const monitor = createUpdateMonitor({ currentVersion: 'development', browser: null, onChange: () => assert.fail('No development update'), fetcher: async () => { requests++; return reply(newer); } });
  await monitor.check();
  assert.equal(requests, 0);
  monitor.dispose();
});
