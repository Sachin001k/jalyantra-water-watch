import { describe, expect, it } from 'vitest';
import {
  depthChangeOverDays,
  detectPumpRunRanges,
  deviceHealthForDay,
  isCountablePumpRun,
  isUsableDepth,
  istDateKey,
  parseDeviceTimestamp,
  pushKeyAtOrAfter,
  readingTimestampMs,
  rollingCalendarWindow,
  syncWindowStartMs,
  wellSafety,
} from '../../supabase/functions/_shared/sensorLogic';

describe('device timestamps', () => {
  it('reads zone-less device times as IST regardless of the machine clock', () => {
    expect(new Date(parseDeviceTimestamp('2026-10-30T08:56:30')!).toISOString()).toBe('2026-10-30T03:26:30.000Z');
    expect(new Date(parseDeviceTimestamp('2026-10-30 08:56:30')!).toISOString()).toBe('2026-10-30T03:26:30.000Z');
  });

  it('keeps an explicit zone', () => {
    expect(new Date(parseDeviceTimestamp('2026-10-30T08:56:30Z')!).toISOString()).toBe('2026-10-30T08:56:30.000Z');
  });

  it('never invents a time for clock-unset readings', () => {
    expect(readingTimestampMs('-Nabc', { collectedDate: 'UNSYNCED', collectedDateTime: 'uptime:29s' })).toBeNull();
    expect(readingTimestampMs('-Nabc', { collectedDateTime: '2026-10-30T08:56:30', clockSynced: false })).toBeNull();
    expect(readingTimestampMs('1761800000', { collectedDateTime: 'uptime:29s' })).toBe(1761800000 * 1000);
  });
});

describe('IST days', () => {
  it('starts a day at 00:00 IST, not 05:30 IST', () => {
    expect(istDateKey(Date.parse('2026-10-29T18:29:59Z'))).toBe('2026-10-29');
    expect(istDateKey(Date.parse('2026-10-29T18:30:00Z'))).toBe('2026-10-30');
  });

  it('starts a sync window at IST midnight', () => {
    const now = Date.parse('2026-10-30T10:00:00Z');
    expect(new Date(syncWindowStartMs(1, now)).toISOString()).toBe('2026-10-28T18:30:00.000Z');
  });
});

describe('depth validation', () => {
  it('rejects depths deeper than the well, non-positive depths and device-flagged readings', () => {
    expect(isUsableDepth(21.43, { wellDepthM: 19 })).toBe(false);
    expect(isUsableDepth(18.9, { wellDepthM: 19 })).toBe(true);
    expect(isUsableDepth(0)).toBe(false);
    expect(isUsableDepth(5, { qualityOk: false })).toBe(false);
    expect(isUsableDepth(150)).toBe(false);
  });
});

describe('pump detection', () => {
  const t0 = Date.parse('2026-10-29T18:00:00Z'); // 23:30 IST
  const minute = 60_000;

  it('keeps a run that crosses IST midnight as one run', () => {
    const depths = [3.0, 3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.0, 3.9, 3.8, 3.7];
    const points = depths.map((depth, i) => ({ depth, timestampMs: t0 + i * 5 * minute }));
    const runs = detectPumpRunRanges(points);
    expect(runs).toHaveLength(1);
    const start = points[runs[0].startIdx];
    const end = points[runs[0].endIdx];
    expect(isCountablePumpRun(start, end)).toBe(true);
    expect(istDateKey(start.timestampMs)).toBe('2026-10-29');
    expect(istDateKey(end.timestampMs)).toBe('2026-10-30');
  });

  it('ignores 2 cm sensor jitter', () => {
    const depths = [3.0, 3.02, 3.0, 3.02, 3.04, 3.02, 3.0];
    const points = depths.map((depth, i) => ({ depth, timestampMs: t0 + i * minute }));
    expect(detectPumpRunRanges(points)).toHaveLength(0);
  });
});

describe('daily metrics', () => {
  it('compares against exactly N calendar days earlier', () => {
    const medians = new Map([
      ['2026-10-01', 5],
      ['2026-10-23', 6],
      ['2026-10-31', 7],
    ]);
    expect(depthChangeOverDays(medians, '2026-10-31', 30)).toBe(2);
    expect(depthChangeOverDays(medians, '2026-10-31', 8)).toBe(1);
    expect(depthChangeOverDays(medians, '2026-10-31', 7)).toBeNull();
  });

  it('sums a rolling window over calendar days, not data days', () => {
    const extraction = new Map([
      ['2026-10-01', 100],
      ['2026-10-29', 10],
      ['2026-10-31', 20],
    ]);
    expect(rollingCalendarWindow(extraction, '2026-10-31', 7)).toEqual({ sum: 30, avg: 15 });
  });

  it('uses the 2 m buffer for safe pump operation, not the intake height', () => {
    const safety = wellSafety({ medianDepthM: 10, wellDepthM: 15, pumpIntakeM: 3 });
    expect(safety.safetyBufferM).toBe(2);
    expect(safety.safePumpOperation).toBe(false);
    expect(safety.dryRunRisk).toBe(false);
  });

  it('marks a device offline once its last reading is over 24 h old', () => {
    const now = Date.parse('2026-10-30T10:00:00Z');
    expect(deviceHealthForDay(now - 2 * 3600_000, '2026-10-30', now)).toBe('Active');
    expect(deviceHealthForDay(now - 30 * 3600_000, '2026-10-30', now)).toBe('Offline');
  });
});

describe('Firebase push keys', () => {
  it('encodes the write time the way Firebase does', () => {
    // Real key from device 11, written at 2026-11-04 14:36:26 IST.
    const writtenAt = Date.parse('2026-11-04T14:36:26+05:30');
    expect(pushKeyAtOrAfter(writtenAt - 1000) < '-P5_noIKa7PQjHQ6b5fE').toBe(true);
    expect(pushKeyAtOrAfter(writtenAt + 1000) > '-P5_noIKa7PQjHQ6b5fE').toBe(true);
  });

  it('sorts in time order', () => {
    const t = Date.parse('2026-10-01T00:00:00Z');
    expect(pushKeyAtOrAfter(t) < pushKeyAtOrAfter(t + 1)).toBe(true);
    expect(pushKeyAtOrAfter(t)).toHaveLength(8);
  });
});
