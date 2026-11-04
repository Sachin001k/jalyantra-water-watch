import { describe, expect, it } from 'vitest';
import { transformFirebaseReadings } from './data';

describe('transformFirebaseReadings', () => {
  it('keeps one reading when a device sends the same reading twice', () => {
    const reading = (depth: number, collectedDateTime: string) => ({
      deviceId: '11',
      depth,
      collectedDate: collectedDateTime.slice(0, 10),
      collectedDateTime,
      lat: 18.64,
      long: 72.87,
    });
    const [sensor] = transformFirebaseReadings({
      '11': {
        '-P5_aaaaaaaaaaaaaaaa': reading(9.1, '2026-11-04T14:30:00'),
        '-P5_bbbbbbbbbbbbbbbb': reading(9.1, '2026-11-04T14:30:00'),
        '-P5_cccccccccccccccc': reading(9.2, '2026-11-04T14:34:00'),
      },
    });
    expect(sensor.history.map((p) => p.id)).toEqual(['-P5_aaaaaaaaaaaaaaaa', '-P5_cccccccccccccccc']);
    expect(sensor.depth).toBe(9.2);
  });
});
