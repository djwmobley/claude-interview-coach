// @ts-check
/**
 * src/dashboard/next-scheduled-scan.js: schtasks XML/CSV parsing against canned output
 * (pr2-spec-decisions.md "Next scheduled scan"). Never touches a real schtasks.exe.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nextScheduledScan, parseNextFromXml, parseNextFromCsv } from '../src/dashboard/next-scheduled-scan.js';

const XML_WEEKLY = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2020-01-06T06:30:00</StartBoundary>
      <ScheduleByWeek>
        <DaysOfWeek>
          <Monday />
          <Tuesday />
          <Wednesday />
          <Thursday />
          <Friday />
        </DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
</Task>`;

const CSV_OUTPUT = [
  '"HostName","TaskName","Next Run Time","Status"',
  '"MYHOST","\\\\job-search scan","8/28/2026 6:30:00 AM","Ready"',
].join('\r\n');

const CSV_NA = ['"HostName","TaskName","Next Run Time","Status"', '"MYHOST","\\\\job-search scan","N/A","Disabled"'].join('\r\n');

describe('parseNextFromXml', () => {
  test('weekly Mon-Fri trigger resolves to the next matching weekday at the trigger time, in the future', () => {
    const next = parseNextFromXml(XML_WEEKLY);
    assert.ok(next instanceof Date);
    assert.ok(next.getTime() > Date.now());
    assert.equal(next.getHours(), 6);
    assert.equal(next.getMinutes(), 30);
    assert.ok(next.getDay() >= 1 && next.getDay() <= 5);
  });

  test('no CalendarTrigger present -> null', () => {
    assert.equal(parseNextFromXml('<Task><Triggers></Triggers></Task>'), null);
  });

  test('malformed XML never throws', () => {
    assert.doesNotThrow(() => parseNextFromXml('not xml at all <<<'));
  });
});

describe('parseNextFromCsv', () => {
  test('parses a quoted "Next Run Time" column into a Date', () => {
    const d = parseNextFromCsv(CSV_OUTPUT);
    assert.ok(d instanceof Date);
    assert.ok(!Number.isNaN(d.getTime()));
  });

  test('N/A -> null', () => {
    assert.equal(parseNextFromCsv(CSV_NA), null);
  });

  test('header only, no data row -> null', () => {
    assert.equal(parseNextFromCsv('"HostName","TaskName","Next Run Time","Status"'), null);
  });

  test('missing the expected column -> null', () => {
    assert.equal(parseNextFromCsv('"A","B"\r\n"1","2"'), null);
  });
});

describe('nextScheduledScan: total classification, never throws', () => {
  test('XML query succeeds -> next_run set, reason null', async () => {
    const execFile = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts, /** @type {any} */ cb) => {
      if (args.includes('/xml')) cb(null, XML_WEEKLY, '');
      else cb(null, '', '');
      return { kill() {} };
    };
    const r = await nextScheduledScan({ execFile: /** @type {any} */ (execFile) });
    assert.ok(r.next_run);
    assert.equal(r.reason, null);
  });

  test('XML fails, CSV succeeds -> falls back to CSV', async () => {
    const execFile = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts, /** @type {any} */ cb) => {
      if (args.includes('/xml')) cb(new Error('not found'), '', '');
      else cb(null, CSV_OUTPUT, '');
      return { kill() {} };
    };
    const r = await nextScheduledScan({ execFile: /** @type {any} */ (execFile) });
    assert.ok(r.next_run);
    assert.equal(r.reason, null);
  });

  test('task not registered (both queries fail) -> null with a reason, never throws', async () => {
    const execFile = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts, /** @type {any} */ cb) => {
      cb(new Error('ERROR: The system cannot find the file specified.'), '', '');
      return { kill() {} };
    };
    const r = await nextScheduledScan({ execFile: /** @type {any} */ (execFile) });
    assert.equal(r.next_run, null);
    assert.equal(typeof r.reason, 'string');
  });

  test('unparseable output on both queries -> null with reason unparseable', async () => {
    const execFile = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts, /** @type {any} */ cb) => {
      cb(null, 'garbage output', '');
      return { kill() {} };
    };
    const r = await nextScheduledScan({ execFile: /** @type {any} */ (execFile) });
    assert.equal(r.next_run, null);
    assert.equal(r.reason, 'unparseable');
  });

  test('execFile throwing synchronously never propagates', async () => {
    const execFile = () => {
      throw new Error('boom');
    };
    const r = await nextScheduledScan({ execFile: /** @type {any} */ (execFile) });
    assert.equal(r.next_run, null);
    assert.equal(typeof r.reason, 'string');
  });
});
