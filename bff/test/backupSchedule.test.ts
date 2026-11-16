// When the nightly backup runs.
//
// The server backs up at `backup_hour` every night and that is enough, because it is always on: it waits for
// the hour, whatever the stamps say.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/hbook-test-config';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 10:00 local on an ordinary day: the next 03:00 is seventeen hours away.
const NOW = new Date(2026, 8, 24, 10, 0, 0).getTime();

const load = async () => import('../src/lib/backup');

test('the server waits for its hour, whatever the stamps say', async () => {
  // ⚠️ A server whose backups have been failing (each failure stamps) is fine, but one restored from an old
  // database would now run a backup at boot.
  const { backupDelay, msUntilHour } = await load();
  for (const lastRun of [NOW - 30 * DAY, null]) {
    assert.equal(backupDelay({ hour: 3, lastRun, lastAttempt: 0, now: NOW }), msUntilHour(3, new Date(NOW)));
  }
  assert.equal(backupDelay({ hour: 22, lastRun: NOW - 30 * DAY, lastAttempt: 0, now: NOW }), 12 * HOUR);
});

test('stampDelay: what is left of the interval since the stamp, never under the floor', async () => {
  // The watchdog's first run (server.ts): the newest source_health.checked_at plus a day.
  const { stampDelay } = await load();
  const floor = 5 * 60 * 1000;
  assert.equal(stampDelay({ last: NOW - 2 * HOUR, interval: DAY, floor, now: NOW }), 22 * HOUR);
  assert.equal(stampDelay({ last: NOW - 25 * HOUR, interval: DAY, floor, now: NOW }), floor, 'overdue runs at the floor');
  assert.equal(stampDelay({ last: 0, interval: DAY, floor, now: NOW }), floor, 'never run runs at the floor');
  assert.equal(stampDelay({ last: NOW, interval: DAY, floor, now: NOW }), DAY);
});
