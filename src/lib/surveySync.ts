import { get, onValue, ref, remove, set } from 'firebase/database';
import { database, firebaseConfig } from '@/lib/firebaseClient';
import { supabase } from '@/lib/supabaseClient';
import { isPortableDeviceBatch } from '@/lib/data';

/**
 * Survey data moves in both directions between Supabase and Firebase RTDB:
 *
 *  Supabase -> Firebase  `pushSurveyToFirebase`: the wells/villages of one survey are written to
 *                        RTDB `latestSurvey/` so the portable device's form can fill its dropdowns.
 *                        The node only ever holds one survey; `clearFirebaseSurvey` empties it.
 *  Firebase -> Supabase  `syncPortableReadings`: portable readings (`readings/Porta-*`) are matched
 *                        to a survey and saved in survey_reading — one row per (survey, well), the
 *                        latest retake overwriting earlier ones.
 */

export const FIREBASE_SURVEY_PATH =
  (import.meta.env.VITE_FIREBASE_SURVEY_PATH as string | undefined) ?? 'latestSurvey';

const RTDB_URL = firebaseConfig.databaseURL;
const RTDB_API_KEY = firebaseConfig.apiKey;

export type SurveyStatus = 'Planned' | 'In Progress' | 'Completed' | 'Cancelled';

export interface SurveySummary {
  surveyId: string;
  surveyName: string;
  organizationName: string;
  surveyorName: string | null;
  status: SurveyStatus;
  actualStartDate: string | null;
  actualEndDate: string | null;
  wellCount: number;
  surveyedCount: number;
}

export interface FirebaseSurveyMeta {
  surveyId: string;
  surveyName: string;
  organizationName: string;
  surveyorName: string | null;
  pushedAt: string;
  wellCount: number;
  villageCount: number;
}

export interface PortableSyncResult {
  saved: number;
  unchanged: number;
  /** Readings that could not be tied to a survey containing that well. */
  unmatched: { wellId: string; siteName: string; deviceId: string }[];
  completedSurveyIds: string[];
}

/** Firebase keys cannot contain . # $ [ ] / */
function firebaseKey(value: string): string {
  return value.trim().replace(/[.#$[\]/]/g, '_') || 'unknown';
}

/** Device clocks report IST without an offset (e.g. "2026-10-06T21:12:04"). */
function parseDeviceTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('UNSYNCED')) return null;
  let str = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(str)) str = `${str}+05:30`;
  const ms = Date.parse(str);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The portable app sends 0/0 or placeholder values when it has no GPS fix — keep only real Indian coordinates. */
function plausibleCoordinate(lat: unknown, long: unknown): { lat: number; long: number } | null {
  const la = Number(lat);
  const lo = Number(long);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (la < 6 || la > 37.5 || lo < 68 || lo > 98.5) return null;
  return { lat: la, long: lo };
}

export async function fetchSurveys(): Promise<SurveySummary[]> {
  const { data, error } = await supabase
    .from('survey_master')
    .select(
      'survey_id, survey_name, organization_name, surveyor_name, status, actual_start_date, actual_end_date, created_at, survey_well ( well_status )',
    )
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data || []).map((s: any) => ({
    surveyId: s.survey_id,
    surveyName: s.survey_name,
    organizationName: s.organization_name,
    surveyorName: s.surveyor_name,
    status: s.status,
    actualStartDate: s.actual_start_date,
    actualEndDate: s.actual_end_date,
    wellCount: (s.survey_well || []).length,
    surveyedCount: (s.survey_well || []).filter((w: any) => w.well_status === 'Surveyed').length,
  }));
}

/**
 * Marking a survey Completed is what moves the dashboard's "Latest Survey Snapshot" to it.
 * Start/end dates are filled in when missing so the snapshot always has a date range.
 */
export async function setSurveyStatus(surveyId: string, status: SurveyStatus): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: current, error: readError } = await supabase
    .from('survey_master')
    .select('actual_start_date, actual_end_date')
    .eq('survey_id', surveyId)
    .single();
  if (readError) throw readError;

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if ((status === 'In Progress' || status === 'Completed') && !current?.actual_start_date) patch.actual_start_date = today;
  if (status === 'Completed' && !current?.actual_end_date) patch.actual_end_date = today;

  const { error } = await supabase.from('survey_master').update(patch).eq('survey_id', surveyId);
  if (error) throw error;
}

export async function fetchFirebaseSurveyMeta(): Promise<FirebaseSurveyMeta | null> {
  const snapshot = await get(ref(database, `${FIREBASE_SURVEY_PATH}/meta`));
  return (snapshot.val() as FirebaseSurveyMeta | null) ?? null;
}

export interface FirebaseSurveyNode {
  meta: FirebaseSurveyMeta;
  villages: Record<string, { village: string; district: string; wells: Record<string, { wellId: string; wellName: string }> }>;
  wells: Record<string, { wellId: string; wellName: string; village: string; district: string }>;
}

/** One survey well as the admin preview shows it, before it is written to Firebase. */
export interface SurveyDeviceWell {
  wellId: string;
  wellName: string;
  village: string;
  district: string;
  wellStatus: 'Pending' | 'Surveyed' | 'Skipped';
}

export interface SurveyDevicePayload {
  survey: { surveyId: string; surveyName: string; organizationName: string; surveyorName: string | null; status: SurveyStatus };
  /** Every well in the survey, whether or not it ends up in `node`. */
  wells: SurveyDeviceWell[];
  /** Exactly what `pushSurveyToFirebase` writes to RTDB `latestSurvey/` (pushedAt is refreshed on push). */
  node: FirebaseSurveyNode;
}

export interface BuildPayloadOptions {
  /** Leave out wells already Surveyed/Skipped — for sending a team back for the wells they missed. */
  onlyPending?: boolean;
}

/**
 * Read one survey's wells from Supabase and shape them into the RTDB `latestSurvey/` node. Shape
 * (both views of the same list, so the device form can either cascade village -> well or look a
 * well up directly):
 *   latestSurvey/meta                         { surveyId, surveyName, organizationName, ... }
 *   latestSurvey/villages/{villageKey}        { village, district, wells: { WEL-..: { wellId, wellName } } }
 *   latestSurvey/wells/{wellId}               { wellId, wellName, village, district }
 */
export async function buildSurveyDevicePayload(
  surveyId: string,
  { onlyPending = false }: BuildPayloadOptions = {},
): Promise<SurveyDevicePayload> {
  const { data: survey, error: surveyError } = await supabase
    .from('survey_master')
    .select('survey_id, survey_name, organization_name, surveyor_name, status')
    .eq('survey_id', surveyId)
    .single();
  if (surveyError) throw surveyError;

  const { data: wellRows, error: wellError } = await supabase
    .from('survey_well')
    .select('well_id, well_status, well_master ( well_name, location_master ( village_city, district ) )')
    .eq('survey_id', surveyId)
    .order('well_id');
  if (wellError) throw wellError;

  const wellList: SurveyDeviceWell[] = ((wellRows || []) as any[]).map((row) => ({
    wellId: String(row.well_id),
    wellName: row.well_master?.well_name ?? String(row.well_id),
    village: row.well_master?.location_master?.village_city ?? 'Unknown',
    district: row.well_master?.location_master?.district ?? 'Unknown',
    wellStatus: row.well_status,
  }));

  const villages: FirebaseSurveyNode['villages'] = {};
  const wells: FirebaseSurveyNode['wells'] = {};
  for (const w of wellList) {
    if (onlyPending && w.wellStatus !== 'Pending') continue;
    const villageKey = firebaseKey(w.village);
    villages[villageKey] ??= { village: w.village, district: w.district, wells: {} };
    villages[villageKey].wells[firebaseKey(w.wellId)] = { wellId: w.wellId, wellName: w.wellName };
    wells[firebaseKey(w.wellId)] = { wellId: w.wellId, wellName: w.wellName, village: w.village, district: w.district };
  }

  const meta: FirebaseSurveyMeta = {
    surveyId: survey.survey_id,
    surveyName: survey.survey_name,
    organizationName: survey.organization_name,
    surveyorName: survey.surveyor_name ?? null,
    pushedAt: new Date().toISOString(),
    wellCount: Object.keys(wells).length,
    villageCount: Object.keys(villages).length,
  };

  return {
    survey: {
      surveyId: survey.survey_id,
      surveyName: survey.survey_name,
      organizationName: survey.organization_name,
      surveyorName: survey.surveyor_name ?? null,
      status: survey.status,
    },
    wells: wellList,
    node: { meta, villages, wells },
  };
}

/**
 * Replace RTDB `latestSurvey/` with this survey's wells (see buildSurveyDevicePayload for the shape).
 * A Planned survey is moved to In Progress, since pushing it to the device starts it.
 */
export async function pushSurveyToFirebase(surveyId: string, options: BuildPayloadOptions = {}): Promise<FirebaseSurveyMeta> {
  const { survey, node } = await buildSurveyDevicePayload(surveyId, options);
  if (!node.meta.wellCount) {
    throw new Error(options.onlyPending ? 'Every well in this survey is already Surveyed or Skipped.' : 'This survey has no wells assigned yet.');
  }
  node.meta.pushedAt = new Date().toISOString();

  await set(ref(database, FIREBASE_SURVEY_PATH), node);

  if (survey.status === 'Planned') await setSurveyStatus(surveyId, 'In Progress');
  return node.meta;
}

/** Live view of RTDB `latestSurvey/` — what the portable devices see right now. Returns an unsubscribe. */
export function subscribeFirebaseSurvey(
  onChange: (node: FirebaseSurveyNode | null) => void,
  onError?: (err: Error) => void,
): () => void {
  return onValue(
    ref(database, FIREBASE_SURVEY_PATH),
    (snapshot) => onChange((snapshot.val() as FirebaseSurveyNode | null) ?? null),
    onError,
  );
}

export async function clearFirebaseSurvey(): Promise<void> {
  await remove(ref(database, FIREBASE_SURVEY_PATH));
}

type PortableReading = {
  firebaseKey: string;
  deviceId: string;
  wellId: string;
  siteName: string;
  surveyIdHint: string | null;
  depth: number;
  timestamp: string;
  coords: { lat: number; long: number } | null;
  surveyorName: string | null;
  surveyorCompany: string | null;
  notes: string | null;
  sampleCount: number | null;
};

function collectPortableReadings(readings: Record<string, unknown>): PortableReading[] {
  const out: PortableReading[] = [];
  for (const [batchKey, batch] of Object.entries(readings || {})) {
    if (!batch || typeof batch !== 'object' || !isPortableDeviceBatch(batchKey, batch)) continue;

    for (const [pushId, raw] of Object.entries(batch as Record<string, any>)) {
      if (!raw || typeof raw !== 'object' || raw.clockSynced === false) continue;
      const wellId = String(raw.wellId ?? '').trim();
      const depth = Number(raw.depth);
      const timestamp = parseDeviceTimestamp(raw.collectedDateTime ?? raw.collectedDate);
      if (!wellId || !Number.isFinite(depth) || depth <= 0 || depth > 100 || !timestamp) continue;

      const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      out.push({
        firebaseKey: pushId,
        deviceId: String(raw.deviceId ?? batchKey).trim(),
        wellId,
        siteName: String(raw.siteName ?? '').trim(),
        surveyIdHint: text(raw.surveyId),
        depth,
        timestamp,
        coords: plausibleCoordinate(raw.lat, raw.long ?? raw.lng),
        surveyorName: text(raw.testerName),
        surveyorCompany: text(raw.testerCompany),
        notes: text(raw.testerData ?? raw.remarks),
        sampleCount: Number.isFinite(Number(raw.averageSampleCount)) ? Number(raw.averageSampleCount) : null,
      });
    }
  }
  return out;
}

/**
 * Firebase `readings/Porta-*` -> survey_reading. Each reading is assigned to a survey by, in order:
 *   1. a `surveyId` field on the reading (if the device app ever echoes it back),
 *   2. the survey currently pushed to `latestSurvey/` — what the device form was filled from,
 *   3. an In Progress survey that includes that well.
 * Readings whose well is in none of these are reported back as unmatched rather than guessed.
 * Only the newest reading per (survey, well) is kept. A survey with no Pending wells left after
 * the sync is marked Completed automatically.
 */
/**
 * Just the portable devices' readings. Each device is probed with its newest reading first, so the
 * fixed sensors' long histories are never downloaded.
 */
async function fetchPortableReadingBatches(): Promise<Record<string, unknown>> {
  const rtdbGet = async (path: string, query = '') => {
    const res = await fetch(`${RTDB_URL}/readings${path}.json?auth=${RTDB_API_KEY}${query}`);
    if (!res.ok) throw new Error(`Firebase readings fetch failed (HTTP ${res.status})`);
    return res.json();
  };
  const deviceIds = Object.keys((await rtdbGet('', '&shallow=true')) ?? {});
  const out: Record<string, unknown> = {};
  await Promise.all(
    deviceIds.map(async (deviceId) => {
      const path = `/${encodeURIComponent(deviceId)}`;
      if (!/^porta/i.test(deviceId)) {
        const newest = await rtdbGet(path, `&orderBy=${encodeURIComponent('"$key"')}&limitToLast=1`);
        if (!isPortableDeviceBatch(deviceId, newest)) return;
      }
      out[deviceId] = await rtdbGet(path);
    }),
  );
  return out;
}

export async function syncPortableReadings(): Promise<PortableSyncResult> {
  const [readings, pushedMeta] = await Promise.all([
    fetchPortableReadingBatches(),
    fetchFirebaseSurveyMeta().catch(() => null),
  ]);
  const portable = collectPortableReadings(readings);
  const result: PortableSyncResult = { saved: 0, unchanged: 0, unmatched: [], completedSurveyIds: [] };
  if (!portable.length) return result;

  const wellIds = Array.from(new Set(portable.map((r) => r.wellId)));
  const { data: memberships, error: membershipError } = await supabase
    .from('survey_well')
    .select('survey_id, well_id, well_status, survey_master ( status, created_at )')
    .in('well_id', wellIds);
  if (membershipError) throw membershipError;

  const surveysByWell = new Map<string, { surveyId: string; status: string; createdAt: string }[]>();
  for (const m of (memberships || []) as any[]) {
    const list = surveysByWell.get(m.well_id) ?? [];
    list.push({ surveyId: m.survey_id, status: m.survey_master?.status, createdAt: m.survey_master?.created_at ?? '' });
    surveysByWell.set(m.well_id, list);
  }

  const resolveSurvey = (r: PortableReading): string | null => {
    const candidates = surveysByWell.get(r.wellId) ?? [];
    const has = (id: string | null | undefined) => !!id && candidates.some((c) => c.surveyId === id);
    if (has(r.surveyIdHint)) return r.surveyIdHint;
    if (has(pushedMeta?.surveyId)) return pushedMeta!.surveyId;
    const inProgress = candidates
      .filter((c) => c.status === 'In Progress')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return inProgress[0]?.surveyId ?? null;
  };

  // Latest reading per (survey, well) — a retake replaces the earlier take.
  const latestByKey = new Map<string, PortableReading & { surveyId: string }>();
  const unmatchedByKey = new Map<string, PortableSyncResult['unmatched'][number]>();
  for (const r of portable) {
    const surveyId = resolveSurvey(r);
    if (!surveyId) {
      unmatchedByKey.set(`${r.deviceId}_${r.wellId}`, { wellId: r.wellId, siteName: r.siteName, deviceId: r.deviceId });
      continue;
    }
    const key = `${surveyId}_${r.wellId}`;
    const existing = latestByKey.get(key);
    if (!existing || r.timestamp > existing.timestamp) latestByKey.set(key, { ...r, surveyId });
  }
  result.unmatched = Array.from(unmatchedByKey.values());
  if (!latestByKey.size) return result;

  const touchedSurveyIds = Array.from(new Set(Array.from(latestByKey.values()).map((r) => r.surveyId)));
  const { data: storedRows, error: storedError } = await supabase
    .from('survey_reading')
    .select('survey_id, well_id, reading_timestamp')
    .in('survey_id', touchedSurveyIds)
    .in('well_id', wellIds);
  if (storedError) throw storedError;
  const storedTimestamp = new Map<string, number>(
    (storedRows || []).map((s: any) => [`${s.survey_id}_${s.well_id}`, Date.parse(s.reading_timestamp)]),
  );

  const portableIds = Array.from(new Set(Array.from(latestByKey.values()).map((r) => r.deviceId)));
  const { data: registeredDevices } = await supabase.from('device_master').select('device_id').in('device_id', portableIds);
  const registered = new Set((registeredDevices || []).map((d: any) => d.device_id));

  const upserts: Record<string, unknown>[] = [];
  for (const [key, r] of latestByKey.entries()) {
    const stored = storedTimestamp.get(key);
    if (stored != null && stored >= Date.parse(r.timestamp)) {
      result.unchanged++;
      continue;
    }
    upserts.push({
      survey_id: r.surveyId,
      well_id: r.wellId,
      device_id: registered.has(r.deviceId) ? r.deviceId : null,
      portable_device_id: r.deviceId,
      depth_meters: r.depth,
      reading_sequence: null,
      reading_timestamp: r.timestamp,
      latitude: r.coords?.lat ?? null,
      longitude: r.coords?.long ?? null,
      surveyor_notes: r.notes,
      site_name: r.siteName || null,
      surveyor_name: r.surveyorName,
      surveyor_company: r.surveyorCompany,
      sample_count: r.sampleCount,
      firebase_key: r.firebaseKey,
    });
  }

  if (upserts.length) {
    const { error } = await supabase.from('survey_reading').upsert(upserts, { onConflict: 'survey_id,well_id' });
    if (error) throw error;
    result.saved = upserts.length;

    for (const row of upserts) {
      await supabase
        .from('survey_well')
        .update({ well_status: 'Surveyed', surveyed_at: row.reading_timestamp })
        .eq('survey_id', row.survey_id as string)
        .eq('well_id', row.well_id as string);
    }
  }

  // Auto-complete surveys whose every well now has a reading (Skipped wells count as done).
  for (const surveyId of touchedSurveyIds) {
    const { data: survey } = await supabase.from('survey_master').select('status').eq('survey_id', surveyId).single();
    if (!survey || survey.status === 'Completed' || survey.status === 'Cancelled') continue;
    const { count } = await supabase
      .from('survey_well')
      .select('id', { count: 'exact', head: true })
      .eq('survey_id', surveyId)
      .eq('well_status', 'Pending');
    if (count === 0) {
      await setSurveyStatus(surveyId, 'Completed');
      result.completedSurveyIds.push(surveyId);
    }
  }

  return result;
}
