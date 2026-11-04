// Shared sensor rules for the sync edge function (Deno), the Admin page sync and the dashboard (Vite).
// Keep this file free of imports so both runtimes can load it as-is.

// ============================================================================
// Time — devices are in India and send local time without a zone.
// ============================================================================

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PLAUSIBLE_MS_MIN = Date.UTC(2020, 0, 1);
const PLAUSIBLE_MS_MAX = Date.UTC(2038, 0, 1);

/**
 * Parse a device time string. Times without a zone are Indian time (+05:30), whatever clock the
 * code runs on — reading them as local time stored server-side copies 5h30m late.
 */
export function parseDeviceTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let str = raw.trim();
  if (/UNSYNCED|uptime/i.test(str)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str = `${str}T00:00:00`;
  str = str.replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(str)) str = `${str}+05:30`;
  const ms = Date.parse(str);
  return Number.isFinite(ms) && ms >= PLAUSIBLE_MS_MIN && ms <= PLAUSIBLE_MS_MAX ? ms : null;
}

/**
 * When a reading happened, or null if it has no trustworthy time. Never falls back to "now":
 * readings taken before the device clock was set (`clockSynced: false`, "UNSYNCED", "uptime:29s")
 * are dropped unless the Firebase key itself is an epoch timestamp.
 */
export function readingTimestampMs(
  key: string,
  reading: { collectedDateTime?: unknown; collectedDate?: unknown; clockSynced?: unknown },
): number | null {
  if (reading.clockSynced === false) return null;
  const fromField = parseDeviceTimestamp(reading.collectedDateTime) ?? parseDeviceTimestamp(reading.collectedDate);
  if (fromField != null) return fromField;
  const numKey = Number(key);
  if (Number.isFinite(numKey) && numKey > 1_000_000_000) {
    const ms = numKey < 1e12 ? numKey * 1000 : numKey;
    if (ms >= PLAUSIBLE_MS_MIN && ms <= PLAUSIBLE_MS_MAX) return ms;
  }
  return null;
}

/** Calendar date (YYYY-MM-DD) in India for an instant. Days start at 00:00 IST, not 05:30 IST. */
export function istDateKey(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 IST on the given date, as epoch ms. */
export function istMidnightMs(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00+05:30`);
}

/** 12:00 IST on the given date, as an ISO string (used as the "when" of a daily alert). */
export function istNoonIso(dateKey: string): string {
  return new Date(istMidnightMs(dateKey) + 12 * 60 * 60 * 1000).toISOString();
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Start of a sync window: 00:00 IST of the day `windowDays` ago, so the first day is always
 * processed whole and its pump runs are never rebuilt from half a day of readings.
 */
export function syncWindowStartMs(windowDays: number, nowMs: number = Date.now()): number {
  return istMidnightMs(istDateKey(nowMs - windowDays * DAY_MS));
}

// ============================================================================
// Depth validation
// ============================================================================

/** Hard ceiling when a well's own depth isn't known. */
export const MAX_PLAUSIBLE_DEPTH_M = 100;

/**
 * Whether a depth-to-water reading can be used. Rejects non-positive depths, depths deeper than the
 * well itself (or MAX_PLAUSIBLE_DEPTH_M when unknown), and readings the device flagged as bad.
 */
export function isUsableDepth(
  depth: number,
  opts: { wellDepthM?: number | null; qualityOk?: unknown } = {},
): boolean {
  if (!Number.isFinite(depth) || depth <= 0) return false;
  if (opts.qualityOk === false) return false;
  const ceiling = opts.wellDepthM != null && opts.wellDepthM > 0 ? opts.wellDepthM : MAX_PLAUSIBLE_DEPTH_M;
  return depth <= ceiling;
}

/** `quality.qualityOk` from a raw Firebase reading (undefined when the device doesn't send it). */
export function readingQualityOk(reading: { quality?: unknown }): boolean | undefined {
  const q = reading.quality as { qualityOk?: unknown } | undefined;
  return typeof q?.qualityOk === "boolean" ? q.qualityOk : undefined;
}

// ============================================================================
// Pump-run detection — the single definition used by the dashboard and both syncs.
// ============================================================================

/**
 * Cumulative depth rise (m) from a local minimum required to confirm the pump has started.
 * Filters out sensor noise (~0.01–0.02 m jitter).
 */
export const PUMP_START_RISE_M = 0.05;

/**
 * Decline (m) from the run's peak depth required to confirm the pump has stopped
 * (water level recovering). The run is closed AT the peak, so recovery samples
 * are never counted inside the run.
 */
export const PUMP_STOP_RECOVERY_M = 0.03;

/**
 * Max gap (minutes) between one run's end and the next run's start, within the same power-on
 * session, for them to be merged into one continuous pumping episode instead of counted as two
 * separate runs. Real-world pump cycles are reported as a handful of times PER DAY (hours apart) —
 * even a 30-40 minute same-session gap is still a sensor/water-table wobble splitting one pumping
 * episode in two, not a real restart. (Raised from 5 to 30 after live data on well 12 showed runs
 * only 6-40 minutes apart were still surviving as separate "runs" under the 5-minute window.)
 */
export const PUMP_RUN_MERGE_GAP_MIN = 30;

/**
 * Minimum total duration (minutes) for a (post-merge) run to be counted as a real pump cycle at
 * all, rather than a single noisy 1-2 minute wiggle.
 */
export const MIN_PUMP_RUN_DURATION_MIN = 3;

/**
 * Cap on how long a chain of merges can grow. Without this, a pump cycling on/off every 15-25
 * minutes all day (every individual gap passes PUMP_RUN_MERGE_GAP_MIN) gets welded into one
 * day-spanning "run" — e.g. a real case merged into a single 989-minute (16.5h) run.
 */
export const MAX_MERGED_RUN_DURATION_MIN = 4 * 60;

/** Minimum drawdown (m) for a detected run to be counted. */
export const MIN_PUMP_DRAWDOWN_M = 0.02;

export type PumpPoint = { depth: number; timestampMs: number; onlineSince?: string | null };
export type PumpRunRange = { startIdx: number; endIdx: number };

function mergeAdjacentRanges(points: PumpPoint[], ranges: PumpRunRange[]): PumpRunRange[] {
  if (ranges.length <= 1) return ranges;
  const merged: PumpRunRange[] = [{ ...ranges[0] }];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const gapMin = (points[ranges[i].startIdx].timestampMs - points[prev.endIdx].timestampMs) / 60000;
    const mergedDurationMin = (points[ranges[i].endIdx].timestampMs - points[prev.startIdx].timestampMs) / 60000;
    if (gapMin <= PUMP_RUN_MERGE_GAP_MIN && mergedDurationMin <= MAX_MERGED_RUN_DURATION_MIN) {
      prev.endIdx = ranges[i].endIdx;
    } else {
      merged.push({ ...ranges[i] });
    }
  }
  return merged;
}

/**
 * Detect pumping intervals in readings sorted by time. Points are first split into device power-on
 * sessions (a new session starts when two neighbours carry different `onlineSince` stamps). Within a
 * session, depth-to-water RISES while the pump runs and FALLS once it stops, so:
 *   - a run STARTS at a local minimum once depth has risen ≥ PUMP_START_RISE_M
 *   - a run ENDS at the peak once depth has fallen ≥ PUMP_STOP_RECOVERY_M from it
 * Returns index ranges into `points` (inclusive), before any duration filtering.
 */
export function detectPumpRunRanges(points: PumpPoint[]): PumpRunRange[] {
  const result: PumpRunRange[] = [];
  let sessionStart = 0;
  for (let i = 1; i <= points.length; i++) {
    const a = points[i - 1]?.onlineSince?.trim();
    const b = points[i]?.onlineSince?.trim();
    const sessionEnds = i === points.length || (a && b && a !== b);
    if (!sessionEnds) continue;
    result.push(...detectInSession(points, sessionStart, i - 1));
    sessionStart = i;
  }
  return result;
}

function detectInSession(points: PumpPoint[], from: number, to: number): PumpRunRange[] {
  if (to - from < 1) return [];
  const ranges: PumpRunRange[] = [];
  let pumping = false;
  let minIdx = from;
  let peakIdx = from;

  for (let i = from + 1; i <= to; i++) {
    const depth = points[i].depth;
    if (!pumping) {
      if (depth <= points[minIdx].depth) {
        minIdx = i;
      } else if (depth - points[minIdx].depth >= PUMP_START_RISE_M) {
        pumping = true;
        peakIdx = i;
      }
    } else if (depth >= points[peakIdx].depth) {
      peakIdx = i;
    } else if (points[peakIdx].depth - depth >= PUMP_STOP_RECOVERY_M) {
      ranges.push({ startIdx: minIdx, endIdx: peakIdx });
      pumping = false;
      minIdx = i;
    }
  }
  if (pumping) ranges.push({ startIdx: minIdx, endIdx: peakIdx });

  return mergeAdjacentRanges(points, ranges);
}

/** Whether a detected run is long and deep enough to count as a real pump cycle. */
export function isCountablePumpRun(start: PumpPoint, end: PumpPoint): boolean {
  const drawdown = end.depth - start.depth;
  const durationMin = (end.timestampMs - start.timestampMs) / 60000;
  return drawdown >= MIN_PUMP_DRAWDOWN_M && durationMin >= MIN_PUMP_RUN_DURATION_MIN;
}

// ============================================================================
// Daily well metrics
// ============================================================================

/** Alert / health thresholds. Same values as the alert_definitions rows the syncs seed. */
export const DRY_RUN_BUFFER_M = 1.0;
export const DRY_RUN_EXIT_BUFFER_M = 1.5;
export const SAFE_PUMP_BUFFER_M = 2.0;
export const LOW_WATER_FRACTION = 0.8;
export const LOW_WATER_EXIT_FRACTION = 0.75;
/** A device counts as online if its latest reading is at most this old. */
export const DEVICE_ONLINE_MAX_AGE_MS = DAY_MS;

export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function wellAreaM2(diameterM: number | null | undefined): number | null {
  return diameterM != null && diameterM > 0 ? Math.PI * Math.pow(diameterM / 2, 2) : null;
}

export function wellSafety(opts: {
  medianDepthM: number;
  wellDepthM?: number | null;
  pumpIntakeM?: number | null;
}) {
  const { medianDepthM, wellDepthM, pumpIntakeM } = opts;
  const remainingDepthM = wellDepthM != null ? wellDepthM - medianDepthM : null;
  const safetyBufferM = remainingDepthM != null && pumpIntakeM != null ? remainingDepthM - pumpIntakeM : null;
  return {
    remainingDepthM,
    safetyBufferM,
    dryRunRisk: safetyBufferM != null && safetyBufferM <= DRY_RUN_BUFFER_M,
    dryRunCleared: safetyBufferM != null && safetyBufferM > DRY_RUN_EXIT_BUFFER_M,
    safePumpOperation: safetyBufferM != null ? safetyBufferM > SAFE_PUMP_BUFFER_M : true,
    lowWaterLevel: wellDepthM != null && medianDepthM > LOW_WATER_FRACTION * wellDepthM,
    lowWaterCleared: wellDepthM != null && medianDepthM < LOW_WATER_EXIT_FRACTION * wellDepthM,
  };
}

/** Median depth change from exactly `days` calendar days earlier; null if there was no data that day. */
export function depthChangeOverDays(
  medianByDate: Map<string, number>,
  dateKey: string,
  days: number,
): number | null {
  const today = medianByDate.get(dateKey);
  const earlier = medianByDate.get(addDaysToDateKey(dateKey, -days));
  return today != null && earlier != null ? today - earlier : null;
}

/** Sum and per-day average of a daily series over the `days` calendar days ending on `dateKey`. */
export function rollingCalendarWindow(byDate: Map<string, number>, dateKey: string, days: number) {
  let sum = 0;
  let daysWithData = 0;
  for (let d = 0; d < days; d++) {
    const v = byDate.get(addDaysToDateKey(dateKey, -d));
    if (v == null) continue;
    sum += v;
    daysWithData++;
  }
  return { sum, avg: daysWithData > 0 ? sum / daysWithData : 0 };
}

/** Device health for one day: Active if the last reading that day is ≤ 24h before the day's end (or now). */
export function deviceHealthForDay(lastReadingMs: number, dateKey: string, nowMs: number = Date.now()): "Active" | "Offline" {
  const dayEndMs = Math.min(istMidnightMs(addDaysToDateKey(dateKey, 1)), nowMs);
  return dayEndMs - lastReadingMs <= DEVICE_ONLINE_MAX_AGE_MS ? "Active" : "Offline";
}

// ============================================================================
// Firebase reads — fetch only the window needed, not every reading ever sent.
// ============================================================================

const PUSH_KEY_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

/**
 * Smallest Firebase push key written at or after `ms`. A push key starts with its creation time, so
 * ordering a device's readings by key and starting here makes Firebase send only readings since `ms`.
 */
export function pushKeyAtOrAfter(ms: number): string {
  let rest = Math.max(0, Math.floor(ms));
  let key = "";
  for (let i = 0; i < 8; i++) {
    key = PUSH_KEY_CHARS[rest % 64] + key;
    rest = Math.floor(rest / 64);
  }
  return key;
}

/**
 * Readings written since `sinceMs`, shaped like the full `readings` node ({ deviceId: { pushKey: reading } }).
 * Lists devices with a shallow read, then asks Firebase for each device's window, so the download
 * grows with the window instead of with the whole history.
 */
export async function fetchRtdbReadingsSince(
  rtdbUrl: string,
  sinceMs: number,
  opts: { authToken?: string; readingsPath?: string } = {},
): Promise<Record<string, Record<string, unknown>>> {
  const path = opts.readingsPath ?? "readings";
  const auth = opts.authToken ? `&auth=${encodeURIComponent(opts.authToken)}` : "";
  const listRes = await fetch(`${rtdbUrl}/${path}.json?shallow=true${auth}`);
  if (!listRes.ok) throw new Error(`Firebase device list fetch failed (HTTP ${listRes.status})`);
  const deviceIds = Object.keys((await listRes.json()) ?? {});

  const startAt = encodeURIComponent(JSON.stringify(pushKeyAtOrAfter(sinceMs)));
  const orderBy = encodeURIComponent(JSON.stringify("$key"));
  const out: Record<string, Record<string, unknown>> = {};
  await Promise.all(
    deviceIds.map(async (deviceId) => {
      const res = await fetch(
        `${rtdbUrl}/${path}/${encodeURIComponent(deviceId)}.json?orderBy=${orderBy}&startAt=${startAt}${auth}`,
      );
      if (!res.ok) throw new Error(`Firebase readings fetch failed for ${deviceId} (HTTP ${res.status})`);
      const batch = await res.json();
      if (batch && typeof batch === "object" && Object.keys(batch).length > 0) out[deviceId] = batch;
    }),
  );
  return out;
}
