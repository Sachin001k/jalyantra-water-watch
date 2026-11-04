import { get, limitToLast, orderByKey, query, ref, startAt, type Query } from 'firebase/database';
import { database, firebaseConfig } from '@/lib/firebaseClient';
import {
  transformFirebaseReadings,
  type FirebaseDeviceBatch,
  type FirebaseReadings,
  type SensorHistoryPoint,
} from '@/lib/data';
import { pushKeyAtOrAfter } from '../../supabase/functions/_shared/sensorLogic';

export const READINGS_PATH = (import.meta.env.VITE_FIREBASE_READINGS_PATH as string | undefined) ?? 'readings';
export const DEVICES_PATH = (import.meta.env.VITE_FIREBASE_DEVICES_PATH as string | undefined) ?? 'devices';

/**
 * Days of readings the dashboard loads up front. Loading the whole `readings` node meant ~90 MB per
 * visit; longer ranges are fetched per device when a popup asks for them (see useSensorWithHistory).
 */
export const DASHBOARD_WINDOW_DAYS = 31;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function dashboardWindowStartMs(nowMs: number = Date.now()): number {
  return nowMs - DASHBOARD_WINDOW_DAYS * DAY_MS;
}

/** Device ids under `readings`. The JS SDK has no shallow read, so this uses the REST API, which returns only the keys. */
export async function fetchReadingDeviceIds(): Promise<string[]> {
  const res = await fetch(`${firebaseConfig.databaseURL}/${READINGS_PATH}.json?shallow=true`);
  if (!res.ok) throw new Error(`Firebase device list fetch failed (HTTP ${res.status})`);
  return Object.keys((await res.json()) ?? {});
}

/** One device's readings written since `sinceMs` — push keys start with their write time, so Firebase filters by key. */
export function readingsSinceQuery(deviceId: string, sinceMs: number): Query {
  return query(ref(database, `${READINGS_PATH}/${deviceId}`), orderByKey(), startAt(pushKeyAtOrAfter(sinceMs)));
}

/** A device's newest reading, so one that has gone quiet still shows its last level. */
export function latestReadingQuery(deviceId: string): Query {
  return query(ref(database, `${READINGS_PATH}/${deviceId}`), orderByKey(), limitToLast(1));
}

/** The window's readings for one device, or just its newest reading if it sent nothing in the window. */
export async function fetchDeviceWindow(deviceId: string, sinceMs: number): Promise<FirebaseDeviceBatch | null> {
  const recent = await get(readingsSinceQuery(deviceId, sinceMs));
  if (recent.exists()) return recent.val();
  const latest = await get(latestReadingQuery(deviceId));
  return latest.exists() ? latest.val() : null;
}

/** Every device's window, shaped like the full `readings` node. */
export async function fetchDashboardReadings(sinceMs: number = dashboardWindowStartMs()): Promise<FirebaseReadings> {
  const deviceIds = await fetchReadingDeviceIds();
  const out: Record<string, FirebaseDeviceBatch> = {};
  await Promise.all(
    deviceIds.map(async (deviceId) => {
      const batch = await fetchDeviceWindow(deviceId, sinceMs);
      if (batch) out[deviceId] = batch;
    }),
  );
  return out;
}

/** One device's history since `sinceMs`, or its whole history when `sinceMs` is null (CSV export). */
export async function fetchDeviceHistory(deviceId: string, sinceMs: number | null): Promise<SensorHistoryPoint[]> {
  const snapshot = await get(
    sinceMs == null ? ref(database, `${READINGS_PATH}/${deviceId}`) : readingsSinceQuery(deviceId, sinceMs),
  );
  if (!snapshot.exists()) return [];
  return transformFirebaseReadings({ [deviceId]: snapshot.val() })[0]?.history ?? [];
}
