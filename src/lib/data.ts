import {
  DEVICE_ONLINE_MAX_AGE_MS,
  readingQualityOk,
} from '../../supabase/functions/_shared/sensorLogic';

/** Known RTDB fields; Firebase may include additional keys — those are preserved in `rtdbExport`. */
export interface FirebaseReadingEntry {
  collectedDate?: string;
  collectedDateTime?: string;
  depth?: number;
  deviceId?: string;
  lat?: number;
  long?: number;
  district?: string;
  lastSeen?: string;
  deviceOnlineSince?: string;
  timestamp?: number;
  triggerSource?: string;
  uptimeSeconds?: number;
  siteName?: string;
  remarks?: string;
  averageSampleCount?: number;
  /** When false, the device clock was not synced — reading should be ignored. */
  clockSynced?: boolean;
  installerCompany?: string;
  installerName?: string;
  installerPhone?: string;
}

export type RtdbCsvRow = Record<string, string | number | boolean | null>;

/** Flatten one RTDB reading for CSV: every primitive (and JSON for nested) + `firebasePushId` = child key under device batch. */
export function rtdbReadingToExportRow(firebasePushId: string, entry: Record<string, unknown> | null | undefined): RtdbCsvRow {
  const out: RtdbCsvRow = {};
  if (entry && typeof entry === 'object') {
    for (const [k, v] of Object.entries(entry)) {
      if (v === undefined) continue;
      if (v === null) {
        out[k] = null;
        continue;
      }
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[k] = v;
        continue;
      }
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    }
  }
  out.firebasePushId = firebasePushId;
  return out;
}

/** One CSV row per history point — uses stored RTDB snapshot when present. */
export function sensorHistoryPointsToCsvRows(points: SensorHistoryPoint[]): RtdbCsvRow[] {
  return points.map((p) =>
    p.rtdbExport != null ? { ...p.rtdbExport } : historyPointFallbackCsvRow(p),
  );
}

function historyPointFallbackCsvRow(p: SensorHistoryPoint): RtdbCsvRow {
  const row: RtdbCsvRow = {
    firebasePushId: p.id,
    collectedDate: p.collectedDate,
    depth: p.depth,
  };
  if (p.collectedDateTime != null) row.collectedDateTime = p.collectedDateTime;
  if (p.deviceOnlineSince != null) row.deviceOnlineSince = p.deviceOnlineSince;
  if (p.triggerSource != null) row.triggerSource = p.triggerSource;
  if (p.uptimeSeconds != null) row.uptimeSeconds = p.uptimeSeconds;
  return row;
}

/** Latest reading per sensor for dashboard export (RTDB columns only when snapshot exists). */
export function sensorsDashboardExportRows(sensors: SensorReading[]): RtdbCsvRow[] {
  return sensors.map((s) =>
    s.latestRtdbExport != null ? { ...s.latestRtdbExport } : sensorSummaryFallbackCsvRow(s),
  );
}

function sensorSummaryFallbackCsvRow(s: SensorReading): RtdbCsvRow {
  const row: RtdbCsvRow = {
    deviceId: s.deviceId,
    collectedDate: s.collectedDate,
    depth: s.depth,
    lat: s.lat,
    long: s.long,
  };
  if (s.lastCollectedDateTime != null) row.collectedDateTime = s.lastCollectedDateTime;
  return row;
}

const PLAUSIBLE_MS_MIN = Date.UTC(2020, 0, 1);
const PLAUSIBLE_MS_MAX = Date.UTC(2038, 0, 1);

function tryParseInstant(s: string | undefined): number | null {
  if (!s?.trim()) return null;
  let str = s.trim();
  // If no timezone info is present, assume IST (+05:30) — this is where devices are installed
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(str);
  if (!hasTimezone && /T/.test(str)) {
    str = `${str}+05:30`;
  }
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
}

/**
 * Portable (survey) JalYantra units push into the same `readings/` node as fixed devices, but each
 * reading belongs to whichever well the surveyor picked (`wellId`) rather than to one installation.
 * They must never be treated as a fixed sensor — identified by the `Porta-` device id prefix, or by
 * the survey-form fields (`wellId` / `testerName`) only the portable app sends.
 */
export function isPortableDeviceBatch(batchKey: string, batch: unknown): boolean {
  if (/^porta/i.test(batchKey.trim())) return true;
  if (!batch || typeof batch !== 'object') return false;
  return Object.values(batch as Record<string, unknown>).some(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      ('wellId' in (entry as Record<string, unknown>) || 'testerName' in (entry as Record<string, unknown>)),
  );
}

/** RTDB child key is sometimes a Unix time: `1773752363` (s) or ms (13 digits). Uses path’s last segment. */
export function instantFromRtdbChildKey(childKey: string): number | null {
  const segment = childKey.includes('/') ? (childKey.split('/').pop() ?? childKey) : childKey;
  if (!/^\d{10,13}$/.test(segment)) return null;
  const n = Number(segment);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  if (ms >= PLAUSIBLE_MS_MIN && ms <= PLAUSIBLE_MS_MAX) return ms;
  return null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isLikelyReadingRow(obj: Record<string, unknown>): boolean {
  const depth = coerceNumber(obj.depth);
  const lat = coerceNumber(obj.lat);
  const long = coerceNumber(obj.long ?? obj.lng ?? obj.lon);
  return depth != null && lat != null && long != null;
}

const MAX_READING_NEST_DEPTH = 8;

function expandReadingLeaves(
  node: unknown,
  keyPrefix: string,
  depth: number,
): { leafKey: string; entry: Record<string, unknown> }[] {
  if (depth > MAX_READING_NEST_DEPTH || !node || typeof node !== 'object' || Array.isArray(node)) return [];
  const o = node as Record<string, unknown>;
  const out: { leafKey: string; entry: Record<string, unknown> }[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const vo = v as Record<string, unknown>;
    const path = keyPrefix ? `${keyPrefix}/${k}` : k;
    if (isLikelyReadingRow(vo)) {
      out.push({ leafKey: path, entry: vo });
    } else {
      out.push(...expandReadingLeaves(vo, path, depth + 1));
    }
  }
  return out;
}

/** One device batch: either a map of readings, a single reading object, or nested folders of readings. */
function leavesForDeviceBatch(
  batchKey: string,
  batch: FirebaseDeviceBatch,
): { leafKey: string; entry: Record<string, unknown> }[] {
  if (!batch || typeof batch !== 'object') return [];
  const b = batch as Record<string, unknown>;
  if (isLikelyReadingRow(b)) {
    return [{ leafKey: batchKey, entry: b }];
  }
  return expandReadingLeaves(b, '', 0);
}

function isClockSyncExplicitlyFalse(entry: FirebaseReadingEntry): boolean {
  const raw = entry as Record<string, unknown>;
  const v = raw.clockSynced ?? raw.clock_synced ?? raw.isClockSynced;
  return v === false || v === 0 || v === 'false';
}

/** Device sent data before NTCP clock sync — e.g. collectedDate "UNSYNCED", collectedDateTime "uptime:33s". */
export function isUnsyncedReadingEntry(entry: FirebaseReadingEntry): boolean {
  if (isClockSyncExplicitlyFalse(entry)) return true;

  const cd = entry.collectedDate?.trim();
  if (cd && /unsynced/i.test(cd)) return true;

  const cdt = entry.collectedDateTime?.trim();
  if (cdt) {
    if (/^uptime:/i.test(cdt)) return true;
    if (/unsynced/i.test(cdt)) return true;
  }

  return false;
}

/**
 * Resolves a reading instant only when the device provided a trustworthy timestamp.
 * Returns null for unsynced clocks, bare dates without time, and other fallbacks.
 */
export function resolveReadingInstantMs(
  entry: FirebaseReadingEntry,
  rtdbChildKey?: string,
): number | null {
  if (isUnsyncedReadingEntry(entry)) return null;

  let t = tryParseInstant(entry.collectedDateTime);
  if (t != null) return t;

  const cd = entry.collectedDate?.trim();
  if (cd && !/^\d{4}-\d{2}-\d{2}$/.test(cd)) {
    t = tryParseInstant(cd);
    if (t != null) return t;
  }

  if (rtdbChildKey) {
    t = instantFromRtdbChildKey(rtdbChildKey);
    if (t != null) return t;
  }

  if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) {
    let ms = entry.timestamp;
    if (ms > 0 && ms < 1e12) ms *= 1000;
    if (ms >= PLAUSIBLE_MS_MIN && ms <= PLAUSIBLE_MS_MAX) return ms;
  }

  return null;
}

/**
 * Sample instant for ordering & charts. Uses `collectedDateTime`, `collectedDate`, RTDB **child key** when it is Unix
 * epoch (common in your DB), then other fields. Falls back to `Date.now()` only for display helpers.
 */
export function readingInstantMs(entry: FirebaseReadingEntry, rtdbChildKey?: string): number {
  const resolved = resolveReadingInstantMs(entry, rtdbChildKey);
  if (resolved != null) return resolved;

  const cd = entry.collectedDate?.trim();
  if (cd) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(cd)) {
      const noon = Date.parse(`${cd}T12:00:00`);
      if (!Number.isNaN(noon)) return noon;
    }
    const t = tryParseInstant(cd);
    if (t != null) return t;
  }

  let t = tryParseInstant(entry.lastSeen);
  if (t != null) return t;

  t = tryParseInstant(entry.deviceOnlineSince);
  if (t != null) return t;

  return Date.now();
}

export function hasValidReadingTimestamp(
  entry: FirebaseReadingEntry,
  rtdbChildKey?: string,
): boolean {
  return resolveReadingInstantMs(entry, rtdbChildKey) != null;
}

/** Last sync line: show the actual sample date/time (no “As of …” / “Xh ago”). */
export function formatLastSyncDate(
  sensor: Pick<SensorReading, 'collectedDate' | 'lastSync' | 'lastCollectedDateTime'>,
): string {
  const iso = sensor.lastCollectedDateTime?.trim();
  if (iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) {
      return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
    }
    return iso;
  }

  const raw = sensor.collectedDate?.trim();
  if (raw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const ms = Date.parse(`${raw}T12:00:00`);
      if (Number.isFinite(ms)) {
        return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });
      }
      return raw;
    }
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) {
      return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
    }
    return raw;
  }

  const t = new Date(sensor.lastSync).getTime();
  if (Number.isFinite(t)) {
    return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata'  });
  }

  return '—';
}

export type FirebaseDeviceBatch = Record<string, FirebaseReadingEntry | null> | null;
export type FirebaseReadings = Record<string, FirebaseDeviceBatch> | null;

export type FirebaseDeviceRegistryMeta = {
  deviceId?: string;
  lat?: number;
  long?: number;
  lng?: number;
  siteName?: string;
  district?: string;
  districtName?: string;
  taluka?: string;
  state?: string;
  wellDepth?: number;
  wellDepthMeters?: number;
  wellDiameter?: number;
  wellDiameterMeters?: number;
  diameter?: number;
  pumpIntakeLevelMeters?: number;
  pumpIntake?: number;
  pumpAttached?: boolean;
  pumpType?: string;
  startStopMethod?: string;
  configuredAt?: string;
  deviceOnlineSince?: string;
  installerCompany?: string;
  installerName?: string;
  installerPhone?: string;
  remarks?: string;
};

export type FirebaseDeviceRegistryEntry = {
  meta?: FirebaseDeviceRegistryMeta | null;
} | null;

export type FirebaseDevicesTree = Record<string, FirebaseDeviceRegistryEntry> | null;

export interface SensorHistoryPoint {
  id: string;
  depth: number;
  collectedDate: string;
  /** From Firebase `collectedDateTime` when present — used for chart tooltips. */
  collectedDateTime?: string;
  timestamp: number;
  /** Same power-on session across ~1 min samples within one pump run. */
  deviceOnlineSince?: string;
  triggerSource?: string;
  uptimeSeconds?: number;
  /** Full flattened RTDB row for dynamic CSV (all columns the device sent). */
  rtdbExport?: RtdbCsvRow;
}

export interface SensorReading {
  id: string;
  deviceId: string;
  depth: number;
  collectedDate: string;
  /** Latest sample's `collectedDateTime` from Firebase when provided. */
  lastCollectedDateTime?: string;
  lat: number;
  long: number;
  village: string;
  district: string;
  status: 'active' | 'offline';
  lastSync: string;
  /** Latest reading's flattened RTDB fields for dashboard CSV. */
  latestRtdbExport?: RtdbCsvRow;
  history: SensorHistoryPoint[];
  validationFlags?: string[];
  /** From device master data — false for electrical-only (non-pump) installations. */
  isPumpConnected?: boolean;
  /** Registered device that has sent no timestamped readings — `depth` is a placeholder, not a measurement. */
  noReadings?: boolean;
}

function readingCoords(
  en: FirebaseReadingEntry,
  raw: Record<string, unknown>,
): { depth: number; lat: number; long: number } | null {
  const depth = coerceNumber(en.depth ?? raw.depth);
  const lat = coerceNumber(en.lat ?? raw.lat);
  const long = coerceNumber(en.long ?? raw.long ?? raw.lng ?? raw.lon);
  if (depth == null || lat == null || long == null) return null;
  return { depth, lat, long };
}

function mapLeafToHistoryPoint(
  leafKey: string,
  entry: Record<string, unknown>,
  batchKey: string,
  opts: { requireValidTimestamp: boolean },
): ExtendedHistoryPoint | null {
  const en = entry as FirebaseReadingEntry;
  if (isUnsyncedReadingEntry(en)) return null;
  // The device marks readings it doesn't trust (e.g. weak echo) with quality.qualityOk = false.
  if (readingQualityOk(entry) === false) return null;

  const raw = entry;
  const coords = readingCoords(en, raw);
  if (!coords) return null;

  const validTimestamp = resolveReadingInstantMs(en, leafKey);
  const timestamp = validTimestamp ?? (opts.requireValidTimestamp ? null : readingInstantMs(en, leafKey));
  if (timestamp == null) return null;

  const collectedDateTime = en.collectedDateTime?.trim();
  const rtdbExport = rtdbReadingToExportRow(leafKey, entry);
  const deviceOnlineSince =
    typeof en.deviceOnlineSince === 'string' && en.deviceOnlineSince.trim()
      ? en.deviceOnlineSince.trim()
      : undefined;
  const triggerSource =
    typeof en.triggerSource === 'string' && en.triggerSource.trim() ? en.triggerSource.trim() : undefined;
  const uptimeSeconds =
    typeof en.uptimeSeconds === 'number' && Number.isFinite(en.uptimeSeconds) ? en.uptimeSeconds : undefined;

  return {
    id: leafKey,
    depth: sanitizeDepth(coords.depth),
    collectedDate: en.collectedDate || new Date(timestamp).toISOString().split('T')[0],
    ...(collectedDateTime ? { collectedDateTime } : {}),
    timestamp,
    lat: coords.lat,
    long: coords.long,
    deviceId: en.deviceId || batchKey,
    district: en.district,
    ...(deviceOnlineSince ? { deviceOnlineSince } : {}),
    ...(triggerSource ? { triggerSource } : {}),
    ...(uptimeSeconds != null ? { uptimeSeconds } : {}),
    rtdbExport,
  };
}

/** Include devices registered under RTDB `devices/{id}/meta` even when they have no readings yet. */
export function mergeReadingsWithDeviceRegistry(
  sensors: SensorReading[],
  registry: FirebaseDevicesTree,
): SensorReading[] {
  const byId = new Map(sensors.map((sensor) => [sensor.deviceId, sensor]));
  if (!registry) return sensors;

  for (const [batchKey, node] of Object.entries(registry)) {
    const meta = node?.meta;
    if (!meta) continue;

    const deviceId = String(meta.deviceId ?? batchKey).trim();
    if (!deviceId || byId.has(deviceId)) continue;

    const lat = coerceNumber(meta.lat);
    const long = coerceNumber(meta.long ?? meta.lng);
    if (lat == null || long == null) continue;

    const configuredMs = tryParseInstant(meta.configuredAt ?? undefined);
    const onlineMs = tryParseInstant(meta.deviceOnlineSince ?? undefined);
    const syncMs = configuredMs ?? onlineMs ?? Date.now();

    byId.set(deviceId, {
      id: batchKey,
      deviceId,
      depth: 0,
      collectedDate: new Date(syncMs).toISOString().split('T')[0],
      lat,
      long,
      village: 'Unknown',
      district: matchDistrictName(lat, long),
      status: 'offline',
      lastSync: new Date(syncMs).toISOString(),
      history: [],
      noReadings: true,
      validationFlags: ['Registered in devices tree — no timestamped readings yet'],
    });
  }

  return Array.from(byId.values()).sort((a, b) =>
    a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true }),
  );
}

export function isPumpConnectedDevice(sensor: Pick<SensorReading, "isPumpConnected">): boolean {
  return sensor.isPumpConnected !== false;
}

export interface District {
  name: string;
  avgDepth: number;
  sensorCount: number;
  criticalPercentage: number;
  change30Days: number;
  riskLevel: 'safe' | 'moderate' | 'warning' | 'critical';
  lat: number;
  long: number;
  history: DistrictHistoryPoint[];
}

export interface Alert {
  id: string;
  type: 'rapid_decline' | 'offline_sensor' | 'poor_recharge' | 'critical_threshold' | 'survey_critical_depth';
  district: string;
  /** Shown before the message instead of the district (e.g. a well name for survey alerts). */
  label?: string;
  /** Survey alerts point at a surveyed well rather than a district. */
  surveyWellId?: string;
  message: string;
  severity: 'warning' | 'critical' | 'info';
  timestamp: string;
}

export interface KPIStats {
  activeSensors: number;
  totalSensors: number;
  avgDepth: number;
  criticalPercentage: number;
  fastestDecliningDistrict: string;
  fastestDeclineRate: number;
  totalReadings: number;
  totalWaterMonitored: number;
}

export interface DistrictHistoryPoint {
  date: string;
  avgDepth: number;
  sensors: number;
}

type ExtendedHistoryPoint = SensorHistoryPoint & {
  lat: number;
  long: number;
  deviceId: string;
  district?: string;
};

const MUMBAI_COORDINATES = { lat: 19.076, long: 72.8777 };

const districtCenters = [
  { name: 'Mumbai', lat: 19.076, long: 72.95 },
  { name: 'Pune', lat: 18.5204, long: 73.8567 },
  { name: 'Nashik', lat: 19.9975, long: 73.7898 },
  { name: 'Nagpur', lat: 21.1458, long: 79.0882 },
  { name: 'Aurangabad', lat: 19.8762, long: 75.3433 },
  { name: 'Solapur', lat: 17.6599, long: 75.9064 },
  { name: 'Kolhapur', lat: 16.705, long: 74.2433 },
  { name: 'Satara', lat: 17.6805, long: 74.0183 },
  { name: 'Sangli', lat: 16.8524, long: 74.5815 },
  { name: 'Ahmednagar', lat: 19.0948, long: 74.748 },
  { name: 'Jalgaon', lat: 21.0077, long: 75.5626 },
  { name: 'Dhule', lat: 20.9042, long: 74.7749 },
  { name: 'Nanded', lat: 19.1383, long: 77.321 },
  { name: 'Latur', lat: 18.4088, long: 76.5604 },
  { name: 'Beed', lat: 18.9892, long: 75.7601 },
  { name: 'Osmanabad', lat: 18.186, long: 76.04 },
  { name: 'Parbhani', lat: 19.2704, long: 76.7747 },
  { name: 'Hingoli', lat: 19.72, long: 77.15 },
  { name: 'Buldhana', lat: 20.5293, long: 76.1842 },
  { name: 'Akola', lat: 20.7002, long: 77.0082 },
  { name: 'Washim', lat: 20.112, long: 77.1461 },
  { name: 'Amravati', lat: 20.9374, long: 77.7796 },
  { name: 'Yavatmal', lat: 20.3899, long: 78.1307 },
  { name: 'Wardha', lat: 20.7453, long: 78.6023 },
  { name: 'Chandrapur', lat: 19.9615, long: 79.2961 },
  { name: 'Gadchiroli', lat: 20.1809, long: 80.0085 },
  { name: 'Bhandara', lat: 21.1669, long: 79.6536 },
  { name: 'Gondia', lat: 21.4624, long: 80.192 },
  { name: 'Ratnagiri', lat: 16.9944, long: 73.3 },
  { name: 'Sindhudurg', lat: 16.3489, long: 73.7556 },
  { name: 'Thane', lat: 19.2183, long: 72.9781 },
  { name: 'Palghar', lat: 19.6968, long: 72.7654 },
  { name: 'Raigad', lat: 18.5158, long: 73.1822 },
];

function getSensorStatusFromTimestamp(timestamp: number): 'active' | 'offline' {
  return Date.now() - timestamp <= DEVICE_ONLINE_MAX_AGE_MS ? 'active' : 'offline';
}

export function matchDistrictName(lat?: number, long?: number): string {

  if (lat == null || long == null) return 'Unknown';

  let closest = districtCenters[0];
  let minDistance = Number.POSITIVE_INFINITY;

  districtCenters.forEach((center) => {
    const dx = lat - center.lat;
    const dy = long - center.long;
    const distance = dx * dx + dy * dy;
    if (distance < minDistance) {
      minDistance = distance;
      closest = center;
    }
  });

  return closest.name;
}

function getDistrictCoordinates(districtName: string) {
  const match = districtCenters.find((center) => center.name === districtName);
  if (match) return { lat: match.lat, long: match.long };
  return { lat: 19.7515, long: 75.7139 };
}

/** Keep 0.01 m precision internally; coarser display rounding is applied only on pump drawdown charts. */
function sanitizeDepth(value?: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.round(value * 100) / 100;
}

const MIN_PLAUSIBLE_DEPTH = 0;
const MAX_PLAUSIBLE_DEPTH = 60;
const MAX_SUDDEN_JUMP_METERS = 1.5;
const MAX_SUDDEN_JUMP_WINDOW_MS = 5 * 60 * 1000;

function isPlausibleDepth(depth: number): boolean {
  return depth >= MIN_PLAUSIBLE_DEPTH && depth <= MAX_PLAUSIBLE_DEPTH;
}

function formatTimeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

function detectSuddenAnomalies(points: ExtendedHistoryPoint[]): string[] {
  const anomalies: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dt = curr.timestamp - prev.timestamp;
    if (dt <= 0 || dt > MAX_SUDDEN_JUMP_WINDOW_MS) continue;
    const delta = Math.abs(curr.depth - prev.depth);
    if (delta >= MAX_SUDDEN_JUMP_METERS) {
      anomalies.push(
        `Sudden change of ${delta.toFixed(2)}m between ${formatTimeLabel(prev.timestamp)} and ${formatTimeLabel(
          curr.timestamp,
        )}`,
      );
    }
  }
  return anomalies;
}

function filterPlausibleHistoryPoints(points: ExtendedHistoryPoint[]): ExtendedHistoryPoint[] {
  return points.filter((point) => isPlausibleDepth(point.depth));
}

function sortHistoryPoints(a: ExtendedHistoryPoint, b: ExtendedHistoryPoint): number {
  const dt = a.timestamp - b.timestamp;
  if (dt !== 0) return dt;
  return a.id.localeCompare(b.id);
}

/**
 * Devices sometimes send the same reading twice (same device, same timestamp). Keep the first of each,
 * as Supabase does with its (device_id, timestamp) key. Expects points sorted by sortHistoryPoints.
 */
function dropRepeatedTimestamps(points: ExtendedHistoryPoint[]): ExtendedHistoryPoint[] {
  return points.filter((point, i) => i === 0 || point.timestamp !== points[i - 1].timestamp);
}

/** Multiple RTDB paths can reference the same `deviceId` (e.g. flat push keys); merge into one sensor. */
function mergeSensorsByDeviceId(sensors: SensorReading[]): SensorReading[] {
  const map = new Map<string, SensorReading>();
  for (const s of sensors) {
    const key = s.deviceId;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...s, history: [...s.history], id: key });
      continue;
    }
    existing.history = [...existing.history, ...s.history].sort(sortHistoryPoints);
    const latest = existing.history[existing.history.length - 1];
    existing.depth = latest.depth;
    existing.collectedDate = latest.collectedDate;
    existing.lastCollectedDateTime = latest.collectedDateTime ?? existing.lastCollectedDateTime;
    existing.lat = latest.lat;
    existing.long = latest.long;
    existing.district = matchDistrictName(latest.lat, latest.long);
    existing.status = getSensorStatusFromTimestamp(latest.timestamp);
    existing.lastSync = new Date(latest.timestamp).toISOString();
    existing.latestRtdbExport = latest.rtdbExport ? { ...latest.rtdbExport } : existing.latestRtdbExport;
    if (s.validationFlags?.length) {
      const existingFlags = existing.validationFlags ?? [];
      existing.validationFlags = Array.from(new Set([...existingFlags, ...s.validationFlags]));
    }
  }
  return Array.from(map.values());
}

function historyPointToSensorPayload(
  historyPoints: ExtendedHistoryPoint[],
  batchKey: string,
): SensorReading | null {
  if (!historyPoints.length) return null;
  const plausibleHistory = filterPlausibleHistoryPoints(historyPoints);
  const historyForSensor = plausibleHistory.length ? plausibleHistory : historyPoints;
  const latest = historyForSensor[historyForSensor.length - 1];
  const deviceId = latest.deviceId || batchKey;
  const districtName = latest.district || matchDistrictName(latest.lat, latest.long);
  const status = getSensorStatusFromTimestamp(latest.timestamp);
  const validationFlags: string[] = [];
  const invalidDepthCount = historyPoints.length - plausibleHistory.length;
  if (invalidDepthCount > 0) {
    validationFlags.push(
      `Filtered ${invalidDepthCount} readings outside ${MIN_PLAUSIBLE_DEPTH}–${MAX_PLAUSIBLE_DEPTH}m range`,
    );
  }
  const anomalyMessages = detectSuddenAnomalies(historyForSensor);
  validationFlags.push(...anomalyMessages);

  return {
    id: batchKey,
    deviceId,
    depth: latest.depth,
    collectedDate: latest.collectedDate,
    ...(latest.collectedDateTime ? { lastCollectedDateTime: latest.collectedDateTime } : {}),
    lat: latest.lat,
    long: latest.long,
    district: districtName,
    status,
    lastSync: new Date(latest.timestamp).toISOString(),
    ...(latest.rtdbExport ? { latestRtdbExport: { ...latest.rtdbExport } } : {}),
    ...(validationFlags.length ? { validationFlags } : {}),
    history: historyForSensor.map(
      ({
        id,
        depth,
        collectedDate,
        collectedDateTime,
        timestamp,
        deviceOnlineSince,
        triggerSource,
        uptimeSeconds,
        rtdbExport,
      }) => ({
        id,
        depth,
        collectedDate,
        ...(collectedDateTime ? { collectedDateTime } : {}),
        timestamp,
        ...(deviceOnlineSince ? { deviceOnlineSince } : {}),
        ...(triggerSource ? { triggerSource } : {}),
        ...(uptimeSeconds != null ? { uptimeSeconds } : {}),
        ...(rtdbExport ? { rtdbExport: { ...rtdbExport } } : {}),
      }),
    ),
  };
}

export function transformFirebaseReadings(raw: FirebaseReadings): SensorReading[] {
  if (!raw) return [];

  const unmerged = Object.entries(raw)
    .map(([batchKey, batch]) => {
      if (isPortableDeviceBatch(batchKey, batch)) return null; // survey data — see src/lib/surveySync.ts
      const leaves = leavesForDeviceBatch(batchKey, batch);
      if (!leaves.length) return null;

      let skippedWithoutTimestamp = 0;
      const timestampedPoints: ExtendedHistoryPoint[] = [];
      const fallbackPoints: ExtendedHistoryPoint[] = [];

      for (const { leafKey, entry } of leaves) {
        const timestamped = mapLeafToHistoryPoint(leafKey, entry, batchKey, { requireValidTimestamp: true });
        if (timestamped) {
          timestampedPoints.push(timestamped);
          continue;
        }

        skippedWithoutTimestamp += 1;
        const fallback = mapLeafToHistoryPoint(leafKey, entry, batchKey, { requireValidTimestamp: false });
        if (fallback) fallbackPoints.push(fallback);
      }

      const historyPoints = dropRepeatedTimestamps(timestampedPoints.sort(sortHistoryPoints));
      const pointsForSensor =
        historyPoints.length > 0
          ? historyPoints
          : fallbackPoints.sort(sortHistoryPoints);

      if (!pointsForSensor.length) return null;

      const sensor = historyPointToSensorPayload(pointsForSensor, batchKey);
      if (!sensor) return null;

      if (historyPoints.length > 0) {
        sensor.history = historyPoints.map(
          ({
            id,
            depth,
            collectedDate,
            collectedDateTime,
            timestamp,
            deviceOnlineSince,
            triggerSource,
            uptimeSeconds,
            rtdbExport,
          }) => ({
            id,
            depth,
            collectedDate,
            ...(collectedDateTime ? { collectedDateTime } : {}),
            timestamp,
            ...(deviceOnlineSince ? { deviceOnlineSince } : {}),
            ...(triggerSource ? { triggerSource } : {}),
            ...(uptimeSeconds != null ? { uptimeSeconds } : {}),
            ...(rtdbExport ? { rtdbExport: { ...rtdbExport } } : {}),
          }),
        );
      } else {
        sensor.history = [];
        sensor.status = 'offline';
      }

      if (skippedWithoutTimestamp > 0) {
        const flag =
          historyPoints.length > 0
            ? `Ignored ${skippedWithoutTimestamp} reading(s) without a valid timestamp`
            : `No timestamped readings yet — ignored ${skippedWithoutTimestamp} unsynced sample(s)`;
        sensor.validationFlags = Array.from(new Set([...(sensor.validationFlags ?? []), flag]));
      }

      return sensor;
    })
    .filter((sensor): sensor is SensorReading => sensor !== null);

  return mergeSensorsByDeviceId(unmerged);
}

export function calculateDistrictStats(readings: SensorReading[]): District[] {
  const districtMap = new Map<string, SensorReading[]>();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  readings.forEach((reading) => {
    const districtSensors = districtMap.get(reading.district) ?? [];
    districtSensors.push(reading);
    districtMap.set(reading.district, districtSensors);
  });

  const districts: District[] = [];

  districtMap.forEach((districtReadings, districtName) => {
    // Devices with no readings carry a placeholder depth of 0 — leave them out of the average.
    const measured = districtReadings.filter((reading) => !reading.noReadings);
    const avgDepth =
      measured.length > 0 ? measured.reduce((sum, reading) => sum + reading.depth, 0) / measured.length : 0;

    const latestTimestamp = Math.max(
      ...districtReadings.flatMap((reading) => reading.history.map((point) => point.timestamp)),
      ...districtReadings.map((reading) => new Date(reading.lastSync).getTime()).filter((t) => Number.isFinite(t)),
    );
    const cutoffMs = Number.isFinite(latestTimestamp) ? latestTimestamp - THIRTY_DAYS_MS : Date.now() - THIRTY_DAYS_MS;

    const recentPoints = districtReadings.flatMap((reading) =>
      reading.history.filter((point) => Number.isFinite(point.timestamp) && point.timestamp >= cutoffMs),
    );
    const baselinePoints = districtReadings.flatMap((reading) =>
      reading.history.filter((point) => Number.isFinite(point.timestamp) && point.timestamp < cutoffMs),
    );

    const recentAvg =
      recentPoints.length > 0
        ? recentPoints.reduce((sum, point) => sum + point.depth, 0) / recentPoints.length
        : avgDepth;
    const baselineAvg =
      baselinePoints.length > 0
        ? baselinePoints.reduce((sum, point) => sum + point.depth, 0) / baselinePoints.length
        : recentAvg;

    const criticalCount = districtReadings.filter((reading) => reading.depth > 20).length;

    const change30Days = Math.round((recentAvg - baselineAvg) * 10) / 10;
    const criticalPercentage = Math.round((criticalCount / districtReadings.length) * 100);

    const timeline = new Map<string, { sum: number; count: number }>();
    districtReadings.forEach((reading) => {
      reading.history.forEach((point) => {
        if (!Number.isFinite(point.timestamp) || point.timestamp < cutoffMs) return;
        const dateKey = point.collectedDate || new Date(point.timestamp).toISOString().split('T')[0];
        const entry = timeline.get(dateKey) ?? { sum: 0, count: 0 };
        entry.sum += point.depth;
        entry.count += 1;
        timeline.set(dateKey, entry);
      });
    });

    const history: DistrictHistoryPoint[] = Array.from(timeline.entries())
      .map(([date, entry]) => ({
        date,
        avgDepth: Math.round((entry.sum / entry.count) * 10) / 10,
        sensors: entry.count,
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let riskLevel: District['riskLevel'] = 'safe';
    if (avgDepth > 20) riskLevel = 'critical';
    else if (avgDepth > 10) riskLevel = 'warning';
    else if (avgDepth > 5) riskLevel = 'moderate';

    const coords = getDistrictCoordinates(districtName);

    districts.push({
      name: districtName,
      avgDepth: Math.round(avgDepth * 10) / 10,
      sensorCount: districtReadings.length,
      criticalPercentage,
      change30Days,
      riskLevel,
      lat: coords.lat,
      long: coords.long,
      history,
    });
  });

  return districts;
}

export function generateAlerts(districts: District[], sensors: SensorReading[] = []): Alert[] {
  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  const offline = sensors.filter((sensor) => sensor.status === 'offline');
  if (offline.length > 0) {
    alerts.push({
      id: 'alert-offline-sensors',
      type: 'offline_sensor',
      district: 'Network',
      message: `${offline.length} of ${sensors.length} wells offline (no reading in the last 24 h)`,
      severity: offline.length === sensors.length ? 'critical' : 'warning',
      timestamp: now,
    });
  }

  const decliningDistricts = districts.filter((d) => d.change30Days < -1);
  decliningDistricts.forEach((district) => {
    alerts.push({
      id: `alert-decline-${district.name}`,
      type: 'rapid_decline',
      district: district.name,
      message: `Rapid drop of ${Math.abs(district.change30Days)}m in recent readings`,
      severity: district.change30Days < -2 ? 'critical' : 'warning',
      timestamp: now,
    });
  });

  const criticalDistricts = districts.filter((d) => d.riskLevel === 'critical');
  criticalDistricts.forEach((district) => {
    alerts.push({
      id: `alert-critical-${district.name}`,
      type: 'critical_threshold',
      district: district.name,
      message: `Average depth at ${district.avgDepth}m - Critical zone`,
      severity: 'critical',
      timestamp: now,
    });
  });

  return alerts.slice(0, 5);
}

export function getDepthRiskLevel(depth: number): 'safe' | 'moderate' | 'warning' | 'critical' {
  if (depth <= 5) return 'safe';
  if (depth <= 10) return 'moderate';
  if (depth <= 20) return 'warning';
  return 'critical';
}

export function getRiskColorClass(risk: 'safe' | 'moderate' | 'warning' | 'critical'): string {
  switch (risk) {
    case 'safe':
      return 'bg-depth-safe';
    case 'moderate':
      return 'bg-depth-moderate';
    case 'warning':
      return 'bg-depth-warning';
    case 'critical':
      return 'bg-depth-critical';
  }
}

export function getRiskTextColorClass(risk: 'safe' | 'moderate' | 'warning' | 'critical'): string {
  switch (risk) {
    case 'safe':
      return 'text-depth-safe';
    case 'moderate':
      return 'text-depth-moderate';
    case 'warning':
      return 'text-depth-warning';
    case 'critical':
      return 'text-depth-critical';
  }
}

export function calculateKPIStats(readings: SensorReading[], districts: District[]): KPIStats {
  const activeSensors = readings.filter((reading) => reading.status === 'active').length;
  const measured = readings.filter((reading) => !reading.noReadings);
  const avgDepth =
    measured.length === 0
      ? 0
      : measured.reduce((sum, reading) => sum + reading.depth, 0) / measured.length;
  const criticalDistricts = districts.filter((district) => district.riskLevel === 'critical').length;
  const criticalPercentage = districts.length ? Math.round((criticalDistricts / districts.length) * 100) : 0;
  const fastestDeclining =
    districts.length > 0
      ? districts.reduce((prev, district) => (district.change30Days < prev.change30Days ? district : prev), districts[0])
      : null;

  return {
    activeSensors,
    totalSensors: readings.length,
    avgDepth: Math.round(avgDepth * 10) / 10,
    criticalPercentage,
    fastestDecliningDistrict: fastestDeclining?.name || 'N/A',
    fastestDeclineRate: fastestDeclining ? Math.abs(fastestDeclining.change30Days) : 0,
    totalReadings: readings.reduce((sum, reading) => sum + reading.history.length, 0),
    totalWaterMonitored: readings.reduce((sum, reading) => {
      const depths = reading.history.length ? reading.history : [{ depth: reading.depth }];
      return sum + depths.reduce((innerSum, point) => innerSum + point.depth, 0);
    }, 0),
  };
}
