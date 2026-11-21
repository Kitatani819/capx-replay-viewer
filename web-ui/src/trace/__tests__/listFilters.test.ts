import test from 'node:test';
import assert from 'node:assert/strict';
import { dateHeading, dateKey, matchesPeriod, validDate, type DateFilter, type Period } from '../../listFilters';

const now = new Date(2026, 10, 21, 14, 30).getTime();
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
const filter = (period: Period, from = '', to = ''): DateFilter => ({ period, from, to });

test('list periods use local calendar days and one supplied clock', () => {
  assert.equal(matchesPeriod(at(21), filter('today'), now), true);
  assert.equal(matchesPeriod(at(20, 23), filter('today'), now), false);
  assert.equal(matchesPeriod(at(22, 0), filter('today'), now), false);
  assert.equal(matchesPeriod(at(19, 0), filter('3d'), now), true);
  assert.equal(matchesPeriod(at(18, 23), filter('3d'), now), false);
  assert.equal(matchesPeriod(at(15, 0), filter('7d'), now), true);
  assert.equal(matchesPeriod(at(14, 23), filter('7d'), now), false);
});

test('custom list dates include both full local boundary days and support open bounds', () => {
  const range = filter('custom', '2026-11-19', '2026-11-20');
  assert.equal(matchesPeriod(at(19, 0), range, now), true);
  assert.equal(matchesPeriod(new Date(2026, 10, 20, 23, 59, 59, 999).getTime(), range, now), true);
  assert.equal(matchesPeriod(at(18, 23), range, now), false);
  assert.equal(matchesPeriod(at(21, 0), range, now), false);
  assert.equal(matchesPeriod(at(21), filter('custom', '2026-11-19'), now), true);
  assert.equal(matchesPeriod(at(18), filter('custom', '', '2026-11-20'), now), true);
  assert.equal(matchesPeriod(at(20), filter('custom', '2026-11-21', '2026-11-19'), now), false);
});

test('list dates accept epoch seconds and ISO strings and label missing dates', () => {
  const time = at(21);
  assert.equal(dateKey(time), '2026-11-21');
  assert.equal(dateKey(time / 1000), '2026-11-21');
  assert.equal(dateKey(new Date(time).toISOString()), '2026-11-21');
  assert.equal(dateHeading(time), '11月21日（土）');
  for (const missing of [null, undefined, '', 'invalid', NaN]) {
    assert.equal(dateKey(missing), '');
    assert.equal(dateHeading(missing), '日付不明');
    assert.equal(matchesPeriod(missing, filter('all'), now), true);
    assert.equal(matchesPeriod(missing, filter('today'), now), false);
  }
});

test('custom list dates reject impossible and malformed calendar dates', () => {
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2000-02-29'), true);
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-11-00', '2026-1-02', '', 'invalid']) {
    assert.equal(validDate(invalid), false, invalid);
  }
});
