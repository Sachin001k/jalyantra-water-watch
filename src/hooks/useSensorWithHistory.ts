import { useEffect, useMemo, useState } from 'react';
import type { SensorHistoryPoint, SensorReading } from '@/lib/data';
import { DAY_MS, dashboardWindowStartMs, fetchDeviceHistory } from '@/lib/firebaseReadings';

/**
 * The sensor with enough history for a popup showing `rangeDays` up to its latest reading. The
 * dashboard only loads the last DASHBOARD_WINDOW_DAYS, so a longer range — or any range for a device
 * that has gone quiet — is fetched for that one device. Until it arrives the loaded history is used.
 */
export function useSensorWithHistory(sensor: SensorReading | null, rangeDays: number): SensorReading | null {
  const [fetched, setFetched] = useState<{ key: string; history: SensorHistoryPoint[] } | null>(null);

  const deviceId = sensor?.deviceId;
  const anchorMs = useMemo(() => {
    const historyMax = (sensor?.history ?? []).reduce((max, point) => Math.max(max, point.timestamp), 0);
    if (historyMax > 0) return historyMax;
    const syncMs = new Date(sensor?.lastSync ?? '').getTime();
    return Number.isFinite(syncMs) ? syncMs : Date.now();
  }, [sensor?.history, sensor?.lastSync]);
  const sinceMs = anchorMs - rangeDays * DAY_MS;
  const needsFetch = !!deviceId && sinceMs < dashboardWindowStartMs();
  const key = `${deviceId}:${rangeDays}`;

  useEffect(() => {
    if (!needsFetch || !deviceId) return;
    let cancelled = false;
    fetchDeviceHistory(deviceId, sinceMs)
      .then((history) => {
        if (!cancelled) setFetched({ key, history });
      })
      .catch((error) => console.error(`Failed to fetch history for ${deviceId}`, error));
    return () => {
      cancelled = true;
    };
    // Re-fetch per device and range only; sinceMs moves with every live reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needsFetch]);

  return useMemo(() => {
    if (!sensor || !needsFetch || fetched?.key !== key || fetched.history.length === 0) return sensor;
    return { ...sensor, history: fetched.history };
  }, [sensor, needsFetch, fetched, key]);
}

/** A device's whole history for CSV export, falling back to what is already loaded. */
export async function fullHistoryForExport(sensor: SensorReading): Promise<SensorHistoryPoint[]> {
  try {
    const history = await fetchDeviceHistory(sensor.deviceId, null);
    return history.length > 0 ? history : sensor.history;
  } catch (error) {
    console.error(`Failed to fetch full history for ${sensor.deviceId}`, error);
    return sensor.history;
  }
}
