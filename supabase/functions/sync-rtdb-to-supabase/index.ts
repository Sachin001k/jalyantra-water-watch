// Supabase Edge Function: sync-rtdb-to-supabase
// Description: Fetches telemetry from Firebase RTDB REST API,
// populates Supabase Master Tables (A), Raw Sensor Data (B), Derived Well & District Summaries (C-H),
// and Alert Logs (I-J). Master fields are Firebase-only — no hardcoded dimension/location defaults.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  deviceHealthForDay,
  depthChangeOverDays,
  detectPumpRunRanges,
  fetchRtdbReadingsSince,
  isCountablePumpRun,
  istDateKey,
  istNoonIso,
  isUsableDepth,
  medianOf,
  type PumpPoint,
  readingQualityOk,
  readingTimestampMs,
  rollingCalendarWindow,
  syncWindowStartMs,
  addDaysToDateKey,
  wellAreaM2,
  wellSafety,
} from "../_shared/sensorLogic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}

// The public anon key is itself a valid JWT, so verify_jwt alone lets anyone in. Only these callers
// may run the sync: a scheduler sending x-sync-secret, a service-role caller, or a logged-in admin.
// deno-lint-ignore no-explicit-any
async function isAuthorizedCaller(req: Request, supabase: any, serviceKey: string): Promise<boolean> {
  const syncSecret = Deno.env.get("SYNC_SECRET");
  if (syncSecret && req.headers.get("x-sync-secret") === syncSecret) return true;

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (token === serviceKey) return true;

  const { data: userData } = await supabase.auth.getUser(token);
  const userId = userData?.user?.id;
  if (!userId) return false;
  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("id", userId).maybeSingle();
  return profile?.is_admin === true;
}

const DISTRICT_CENTERS = [
  { name: "Mumbai", lat: 19.076, long: 72.95 },
  { name: "Pune", lat: 18.5204, long: 73.8567 },
  { name: "Nashik", lat: 19.9975, long: 73.7898 },
  { name: "Nagpur", lat: 21.1458, long: 79.0882 },
  { name: "Aurangabad", lat: 19.8762, long: 75.3433 },
  { name: "Akola", lat: 20.7002, long: 77.0082 },
  { name: "Washim", lat: 20.112, long: 77.1461 },
  { name: "Amravati", lat: 20.9374, long: 77.7796 },
  { name: "Raigad", lat: 18.5158, long: 73.1822 },
  { name: "Thane", lat: 19.2183, long: 72.9781 },
  { name: "Palghar", lat: 19.6968, long: 72.7654 },
];

function matchDistrictName(lat: number, long: number): string {
  let closest = DISTRICT_CENTERS[0];
  let minDistance = Number.POSITIVE_INFINITY;
  for (const center of DISTRICT_CENTERS) {
    const dx = lat - center.lat;
    const dy = long - center.long;
    const distance = dx * dx + dy * dy;
    if (distance < minDistance) {
      minDistance = distance;
      closest = center;
    }
  }
  return closest.name;
}

function optionalPositive(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// PostgREST caps an unfiltered .select() at 1000 rows (db_max_rows) — pump_run_summary long ago grew
// past that, so a plain select silently returned an arbitrary ~7% slice of the table and corrupted
// every daily/weekly aggregate built from it. Page through with .range() until nothing is left.
async function fetchAllRows(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  table: string,
  select: string,
  orderColumn: string,
  // deno-lint-ignore no-explicit-any
  applyFilter?: (query: any) => any,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  const pageSize = 1000;
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  let offset = 0;
  while (true) {
    let query = supabase.from(table).select(select).order(orderColumn, { ascending: true });
    if (applyFilter) query = applyFilter(query);
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // No hardcoded fallbacks: a missing setting must fail loudly, not silently point somewhere else.
    // SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided to every edge function by Supabase.
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("MY_SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("MY_SUPABASE_SERVICE_ROLE_KEY");
    const targetRtdbUrl = Deno.env.get("FIREBASE_RTDB_URL");
    // Database secret (or other admin token) once Firebase reads are locked down; until then the
    // web API key is passed as before.
    const firebaseAuthToken = Deno.env.get("FIREBASE_DATABASE_SECRET") || Deno.env.get("FIREBASE_API_KEY");
    if (!supabaseUrl || !supabaseServiceKey || !targetRtdbUrl) {
      return jsonResponse(
        { success: false, error: "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or FIREBASE_RTDB_URL" },
        500,
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    if (!(await isAuthorizedCaller(req, supabase, supabaseServiceKey))) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));

    // Bound how much history each invocation processes -- unlike Admin.tsx (which has always had this via
    // its UI time-range dropdown), this function had no limit at all, so it kept every reading Firebase ever
    // returned in memory at once. That's what caused the WORKER_RESOURCE_LIMIT (OOM) once the table grew large.
    const readingsWindowDays = Number(body.readingsWindowDays) > 0 ? Number(body.readingsWindowDays) : 30;
    // Starts at 00:00 IST so the first day is processed whole — its pump runs are deleted and rebuilt below.
    const readingsCutoffMs = syncWindowStartMs(readingsWindowDays);
    const windowStartDate = istDateKey(readingsCutoffMs);
    console.log(`Syncing RTDB data (from ${windowStartDate}, ${readingsWindowDays}-day window)`);

    // 1. Fetch devices and readings nodes from Firebase
    const authQuery = firebaseAuthToken ? `?auth=${firebaseAuthToken}` : "";
    // Only the window's readings are downloaded (see fetchRtdbReadingsSince), not the whole history.
    const [devicesRes, windowReadings] = await Promise.all([
      fetch(`${targetRtdbUrl}/devices.json${authQuery}`).catch(() => null),
      fetchRtdbReadingsSince(targetRtdbUrl, readingsCutoffMs, { authToken: firebaseAuthToken || undefined }),
    ]);

    const devicesData = devicesRes && devicesRes.ok ? await devicesRes.json() : {};
    // deno-lint-ignore prefer-const -- explicitly freed below once extracted; the raw Firebase payload
    // is the single largest thing in memory for this function.
    let readingsData: Record<string, unknown> | null = windowReadings;

    let syncedDevicesCount = 0;
    let syncedReadingsCount = 0;

    // Seed Static Alert Definitions (Table I)
    await supabase.from("alert_definitions").upsert([
      { alert_code: "LOW_WATER_LEVEL", alert_name: "Low Water Level", alert_level: "well", alert_type: "warning", trigger_field: "dailyMedianWaterDepthMeters", trigger_logic: "dailyMedianWaterDepthMeters > 0.8 * wellDepthMeters", expiry_logic: "dailyMedianWaterDepthMeters < 0.75 * wellDepthMeters", calculation_frequency: "End of Day", default_message: "Water level is approaching critically low levels." },
      { alert_code: "DRY_RUN_RISK", alert_name: "Dry Run Risk", alert_level: "well", alert_type: "warning", trigger_field: "safetyBufferMeters", trigger_logic: "safetyBufferMeters <= 1.0", expiry_logic: "safetyBufferMeters > 1.5", calculation_frequency: "End of Day", default_message: "High risk of pump dry running. Water buffer above intake is below 1 meter." },
      { alert_code: "UNSAFE_PUMP_OPERATION", alert_name: "Unsafe Pump Operation", alert_level: "well", alert_type: "warning", trigger_field: "safetyBufferMeters", trigger_logic: "safetyBufferMeters <= 2.0 AND safetyBufferMeters > 1.0", expiry_logic: "safetyBufferMeters > 2.0", calculation_frequency: "End of Day", default_message: "Pump is operating with less than 2 meters safety buffer." },
      { alert_code: "POOR_RECOVERY", alert_name: "Poor Groundwater Recovery", alert_level: "well", alert_type: "warning", trigger_field: "recoveryAmountMeters", trigger_logic: "recoveryAmountMeters < 0.1 AND hoursGap >= 24", expiry_logic: "recoveryAmountMeters >= 0.2", calculation_frequency: "End of Day", default_message: "Well exhibits minimal groundwater recovery (<0.1m)." },
    ], { onConflict: "alert_code" });

    // 2. Sync Devices into Location, Well, and Device Master tables (A) — Firebase-only
    const wellDepthMap = new Map<string, number>();
    const wellDiameterMap = new Map<string, number>();
    const wellPumpIntakeMap = new Map<string, number>();
    const wellDistrictMap = new Map<string, string>();
    const wellStateMap = new Map<string, string>();

    // One alert per episode: raised the first day its trigger condition holds, expired the first later
    // day its exit condition holds (alert_definitions.expiry_logic). alertedDates stops a re-run over the
    // same window from raising a second alert for a day already logged.
    const existingAlerts = await fetchAllRows(
      supabase,
      "alert_logs",
      "alert_id, alert_code, well_id, status, triggered_at",
      "alert_id",
      (q) => q.in("alert_code", ["LOW_WATER_LEVEL", "DRY_RUN_RISK"]),
    );
    const alertedDates = new Set<string>(
      existingAlerts.map((a: any) => `${a.alert_code}_${a.well_id}_${istDateKey(Date.parse(a.triggered_at))}`),
    );
    // `${alert_code}_${well_id}` -> the still-active alert and the date it was raised
    const openAlerts = new Map<string, { alertId: string; date: string }>();
    for (const a of existingAlerts) {
      if (a.status === "active") {
        openAlerts.set(`${a.alert_code}_${a.well_id}`, { alertId: a.alert_id, date: istDateKey(Date.parse(a.triggered_at)) });
      }
    }

    const { data: existingWells } = await supabase
      .from("well_master")
      .select("well_id, well_depth_meters, well_diameter_meters, pump_intake_level_meters, location_id");
    const existingWellById = new Map<string, any>((existingWells || []).map((w: any) => [w.well_id, w]));
    for (const w of existingWells || []) {
      const depth = optionalPositive(w.well_depth_meters);
      const diameter = optionalPositive(w.well_diameter_meters);
      const intake = optionalPositive(w.pump_intake_level_meters);
      if (depth != null) wellDepthMap.set(w.well_id, depth);
      if (diameter != null) wellDiameterMap.set(w.well_id, diameter);
      if (intake != null) wellPumpIntakeMap.set(w.well_id, intake);
    }

    const { data: existingLocations } = await supabase
      .from("location_master")
      .select("location_id, district, state");
    const locationById = new Map<string, any>((existingLocations || []).map((l: any) => [l.location_id, l]));
    for (const w of existingWells || []) {
      const loc = locationById.get(w.location_id);
      if (loc?.district) wellDistrictMap.set(w.well_id, loc.district);
      if (loc?.state) wellStateMap.set(w.well_id, loc.state);
    }

    if (devicesData && typeof devicesData === "object") {
      for (const [deviceKey, devNode] of Object.entries(devicesData)) {
        const meta = (devNode as any)?.meta || {};
        const deviceId = String(meta.deviceId || deviceKey).trim();
        if (!deviceId) continue;

        const lat = optionalNumber(meta.lat);
        const long = optionalNumber(meta.long ?? meta.lng);
        if (lat == null || long == null) {
          console.warn(`Skipping device ${deviceId}: meta.lat/long missing`);
          continue;
        }

        const district =
          String(meta.district || meta.districtName || "").trim() || matchDistrictName(lat, long);
        const state = String(meta.state || "").trim();
        const wellId = `WEL-${deviceId}`;
        // Reuse the well's own curated location_id if it already exists — recomputing a generic
        // district guess here would create a second, unused location row disconnected from the well.
        const existingWell = existingWellById.get(wellId);
        const locationId = existingWell?.location_id || `LOC-${district.toUpperCase().replace(/\s+/g, "-")}`;

        const firebaseWellDepth = optionalPositive(meta.wellDepth ?? meta.wellDepthMeters);
        const firebaseWellDiameter = optionalPositive(
          meta.wellDiameter ?? meta.wellDiameterMeters ?? meta.diameter,
        );
        const firebasePumpIntake = optionalPositive(meta.pumpIntakeLevelMeters ?? meta.pumpIntake);

        if (firebaseWellDepth != null) wellDepthMap.set(wellId, firebaseWellDepth);
        if (firebaseWellDiameter != null) wellDiameterMap.set(wellId, firebaseWellDiameter);
        if (firebasePumpIntake != null) wellPumpIntakeMap.set(wellId, firebasePumpIntake);
        wellDistrictMap.set(wellId, district);
        if (state) wellStateMap.set(wellId, state);

        // Only create a new location for a device that actually resolves to a real well — either
        // one that already exists, or one with real Firebase depth/diameter data to create now.
        // Otherwise Firebase devices with no curated well (test devices, decommissioned units,
        // not-yet-onboarded units) leave behind orphaned generic-district location rows forever.
        const wellExists = !!existingWell;
        const wellWillBeReady = wellExists || (firebaseWellDepth != null && firebaseWellDiameter != null);

        // location_id, village_city, taluka, district, state are set once at creation and must
        // never change afterward — the sync only ever INSERTs a new location, never updates these.
        const locationExists = locationById.has(locationId);
        if (!locationExists) {
          if (wellWillBeReady) {
            const locationPayload: Record<string, unknown> = {
              location_id: locationId,
              village_city: String(meta.siteName || "").trim() || district,
              taluka: String(meta.taluka || "").trim() || district,
              district,
              latitude: lat,
              longitude: long,
              status: "Active",
            };
            if (state) locationPayload.state = state;
            await supabase.from("location_master").insert(locationPayload);
            locationById.set(locationId, { location_id: locationId, district, state });
          } else {
            console.warn(`Skipping new location_master for ${locationId}: device ${deviceId} has no known/creatable well`);
          }
        } else {
          await supabase.from("location_master").update({ latitude: lat, longitude: long, status: "Active" }).eq("location_id", locationId);
        }

        // location_id, well_name, well_depth_meters, well_diameter_meters are locked once a well
        // exists — only pump metadata/status may be refreshed here; edit the rest via the SQL editor.
        let wellReady = wellExists;
        if (wellExists) {
          const wellUpdatePatch: Record<string, unknown> = { status: "Active" };
          if (firebasePumpIntake != null) wellUpdatePatch.pump_intake_level_meters = firebasePumpIntake;
          if (meta.pumpAttached !== undefined) wellUpdatePatch.pump_attached = Boolean(meta.pumpAttached);
          if (meta.pumpType) wellUpdatePatch.pump_type = String(meta.pumpType);
          await supabase.from("well_master").update(wellUpdatePatch).eq("well_id", wellId);
        } else if (firebaseWellDepth != null && firebaseWellDiameter != null) {
          const wellInsertPayload: Record<string, unknown> = {
            well_id: wellId,
            location_id: locationId,
            well_name: String(meta.siteName || "").trim() || `Well ${deviceId}`,
            well_depth_meters: firebaseWellDepth,
            well_diameter_meters: firebaseWellDiameter,
            status: "Active",
          };
          if (firebasePumpIntake != null) wellInsertPayload.pump_intake_level_meters = firebasePumpIntake;
          if (meta.pumpAttached !== undefined) wellInsertPayload.pump_attached = Boolean(meta.pumpAttached);
          if (meta.pumpType) wellInsertPayload.pump_type = String(meta.pumpType);
          await supabase.from("well_master").insert(wellInsertPayload);
          existingWellById.set(wellId, {
            well_id: wellId,
            location_id: locationId,
            well_depth_meters: firebaseWellDepth,
            well_diameter_meters: firebaseWellDiameter,
          });
          wellReady = true;
        } else {
          console.warn(
            `Skipping new well_master for ${wellId}: Firebase meta missing wellDepth/wellDiameter`,
          );
        }

        const devicePayload: Record<string, unknown> = {
          device_serial_number: deviceId,
          status: "Active",
        };
        if (wellReady) devicePayload.well_id = wellId;
        if (meta.startStopMethod) devicePayload.start_stop_method = String(meta.startStopMethod);

        const { data: existingDevice } = await supabase
          .from("device_master")
          .select("device_id")
          .eq("device_id", deviceId)
          .maybeSingle();
        if (existingDevice) {
          await supabase.from("device_master").update(devicePayload).eq("device_id", deviceId);
        } else {
          await supabase.from("device_master").insert({ device_id: deviceId, ...devicePayload });
        }

        syncedDevicesCount++;
      }
    }

    // 3. Process Telemetry & Store Raw Data (B)
    if (readingsData && typeof readingsData === "object") {
      const wellReadingsByDate = new Map<string, Map<string, PumpPoint[]>>();
      const districtDailyAgg = new Map<
        string,
        { wells: Set<string>; depthSum: number; depthCount: number; extraction: number; runtime: number }
      >();
      // 7/30-day depth-change contributions per district+date, averaged across that district's wells —
      // feeds weekly_monthly_district_summary alongside the rolling 30-day extraction computed below.
      const districtWeeklyAgg = new Map<
        string,
        { sevenDaySum: number; sevenDayCount: number; thirtyDaySum: number; thirtyDayCount: number }
      >();
      // Dedup directly into the map being upserted -- avoids holding a second, near-duplicate array of
      // every reading in memory at once (that plus the full Firebase payload is what drove OOM before).
      const uniqueRowsMap = new Map<string, Record<string, unknown>>();
      let skippedOldCount = 0;

      for (const [batchKey, batchNode] of Object.entries(readingsData)) {
        if (!batchNode || typeof batchNode !== "object") continue;
        // Portable survey units (Porta-*) share the readings node but belong in survey_reading,
        // not raw_sensor_data — see src/lib/surveySync.ts (synced from the Admin panel).
        if (/^porta/i.test(batchKey)) continue;

        const deviceId = batchKey;
        const wellId = `WEL-${deviceId}`;

        const wellDepthForReadings = wellDepthMap.get(wellId);
        const entries = Object.entries(batchNode as Record<string, any>);
        for (const [rKey, r] of entries) {
          if (!r || typeof r !== "object") continue;
          const depth = Number(r.depth);
          if (!isUsableDepth(depth, { wellDepthM: wellDepthForReadings, qualityOk: readingQualityOk(r) })) continue;

          // Device times are IST without a zone; clock-unset readings are dropped, never stamped "now".
          const readingTimeMs = readingTimestampMs(rKey, r);
          if (readingTimeMs == null) continue;
          if (readingTimeMs < readingsCutoffMs) {
            skippedOldCount++;
            continue;
          }
          const readingTimestamp = new Date(readingTimeMs).toISOString();
          const readingDate = istDateKey(readingTimeMs);
          const onlineSinceMs = readingTimestampMs("", { collectedDateTime: r.deviceOnlineSince });

          const key = `${deviceId}_${readingTimestamp}`;
          if (!uniqueRowsMap.has(key)) {
            uniqueRowsMap.set(key, {
              device_id: deviceId,
              well_id: existingWellById.has(wellId) ? wellId : null,
              depth_meters: depth,
              timestamp: readingTimestamp,
              uptime: r.uptimeSeconds || null,
              online_since: onlineSinceMs != null ? new Date(onlineSinceMs).toISOString() : null,
            });
          }

          if (!wellReadingsByDate.has(wellId)) wellReadingsByDate.set(wellId, new Map());
          const dateMap = wellReadingsByDate.get(wellId)!;
          if (!dateMap.has(readingDate)) dateMap.set(readingDate, []);
          dateMap.get(readingDate)!.push({
            depth,
            timestampMs: readingTimeMs,
            onlineSince: typeof r.deviceOnlineSince === "string" ? r.deviceOnlineSince : null,
          });

          // Capture district from Firebase reading when present
          const readingDistrict = String(r.district || "").trim();
          if (readingDistrict && !wellDistrictMap.has(wellId)) {
            wellDistrictMap.set(wellId, readingDistrict);
          }
        }
      }
      if (skippedOldCount > 0) {
        console.log(`Skipped ${skippedOldCount} readings older than the ${readingsWindowDays}-day window`);
      }
      // Everything needed has been extracted into wellReadingsByDate/uniqueRowsMap above -- drop the
      // reference to the raw Firebase payload so it can be garbage-collected before the heavier
      // pump-run-detection and derived-metrics work below.
      readingsData = null;

      // Bulk upsert raw telemetry. The (device_id, timestamp) unique constraint does the duplicate
      // check — a pre-select was capped at 1,000 rows by PostgREST and so missed most existing rows.
      if (uniqueRowsMap.size > 0) {
        const rowsToUpsert = Array.from(uniqueRowsMap.values());
        uniqueRowsMap.clear();
        for (let i = 0; i < rowsToUpsert.length; i += 200) {
          const chunk = rowsToUpsert.slice(i, i + 200);
          const { error } = await supabase
            .from("raw_sensor_data")
            .upsert(chunk, { onConflict: "device_id,timestamp", ignoreDuplicates: true });
          if (error) throw error;
        }
        syncedReadingsCount += rowsToUpsert.length;
      }

      // 3.5. Detect Pump Runs from Raw Depth Readings & Insert into pump_run_summary (C)
      // Runs are detected over the well's whole window (so pumping across midnight stays one run) with
      // the same rules as the dashboard, then filed under the IST date they started. Each date in the
      // window is replaced (delete + insert) — the window starts at 00:00 IST, so every date here is
      // rebuilt from a full day of readings. Older history outside the window is left untouched.
      for (const [wellId, dateMap] of wellReadingsByDate.entries()) {
        const wellAreaForRuns = wellAreaM2(wellDiameterMap.get(wellId));
        const sorted = Array.from(dateMap.values()).flat().sort((a, b) => a.timestampMs - b.timestampMs);

        const runsByDate = new Map<string, { start: PumpPoint; end: PumpPoint }[]>();
        for (const range of detectPumpRunRanges(sorted)) {
          const start = sorted[range.startIdx];
          const end = sorted[range.endIdx];
          if (!isCountablePumpRun(start, end)) continue;
          const runDate = istDateKey(start.timestampMs);
          const list = runsByDate.get(runDate) || [];
          list.push({ start, end });
          runsByDate.set(runDate, list);
        }

        for (const dateStr of dateMap.keys()) {
          const runs = runsByDate.get(dateStr) || [];
          const rowsForDate = runs.map(({ start, end }, idx) => {
            const drop = Math.max(0, end.depth - start.depth);
            return {
              well_id: wellId,
              run_date: dateStr,
              pump_start_time: new Date(start.timestampMs).toISOString(),
              pump_stop_time: new Date(end.timestampMs).toISOString(),
              pump_runtime_minutes: Math.max(0, (end.timestampMs - start.timestampMs) / 60000),
              pump_start_depth_meters: start.depth,
              pump_stop_depth_meters: end.depth,
              water_level_drop_during_run_meters: drop,
              pump_extraction_per_run_liters: wellAreaForRuns != null ? wellAreaForRuns * drop * 1000.0 : 0,
              is_first_run_of_day: idx === 0,
              is_last_run_of_day: idx === runs.length - 1,
              updated_at: new Date().toISOString(),
            };
          });

          await supabase.from("pump_run_summary").delete().eq("well_id", wellId).eq("run_date", dateStr);
          if (rowsForDate.length > 0) {
            await supabase.from("pump_run_summary").upsert(rowsForDate, { onConflict: "well_id,pump_start_time,pump_stop_time" });
          }
        }
      }

      // Pull real pump run data — this is the single source of truth for run counts/runtime/extraction.
      // Scoped to the same readings window this run is processing, and paginated (see fetchAllRows)
      // since pump_run_summary has long since grown past PostgREST's 1000-row default select cap.
      const pumpRunCutoffDateStr = windowStartDate;
      const pumpRunRows = await fetchAllRows(
        supabase,
        "pump_run_summary",
        "well_id, run_date, pump_runtime_minutes, pump_extraction_per_run_liters, water_level_drop_during_run_meters",
        "pump_run_id",
        (q) => q.gte("run_date", pumpRunCutoffDateStr),
      );
      const pumpRunsByWellDate = new Map<string, { count: number; runtime: number; extraction: number; drop: number }>();
      for (const row of pumpRunRows || []) {
        const key = `${row.well_id}_${row.run_date}`;
        const agg = pumpRunsByWellDate.get(key) || { count: 0, runtime: 0, extraction: 0, drop: 0 };
        agg.count += 1;
        agg.runtime += Number(row.pump_runtime_minutes) || 0;
        agg.extraction += Number(row.pump_extraction_per_run_liters) || 0;
        agg.drop += Number(row.water_level_drop_during_run_meters) || 0;
        pumpRunsByWellDate.set(key, agg);
      }

      // Daily medians from just before the window, so 7- and 30-day changes have something to compare
      // against on the window's first days.
      const priorMedianRows = await fetchAllRows(
        supabase,
        "daily_well_summary",
        "well_id, date, daily_median_water_depth_meters, daily_water_extraction_liters",
        "date",
        (q) => q.gte("date", addDaysToDateKey(windowStartDate, -31)).lt("date", windowStartDate),
      );
      const priorMediansByWell = new Map<string, Map<string, number>>();
      const priorExtractionByWell = new Map<string, Map<string, number>>();
      for (const row of priorMedianRows) {
        const median = Number(row.daily_median_water_depth_meters);
        if (Number.isFinite(median)) {
          if (!priorMediansByWell.has(row.well_id)) priorMediansByWell.set(row.well_id, new Map());
          priorMediansByWell.get(row.well_id)!.set(row.date, median);
        }
        if (!priorExtractionByWell.has(row.well_id)) priorExtractionByWell.set(row.well_id, new Map());
        priorExtractionByWell.get(row.well_id)!.set(row.date, Number(row.daily_water_extraction_liters) || 0);
      }

      // 4. Compute Derived Metrics (D, E, F, J) — no hardcoded well depth/diameter
      for (const [wellId, dateMap] of wellReadingsByDate.entries()) {
        if (!existingWellById.has(wellId)) continue;

        const sortedDates = Array.from(dateMap.keys()).sort();
        const wellDepth = wellDepthMap.get(wellId);
        const pumpIntake = wellPumpIntakeMap.get(wellId);
        const wellArea = wellAreaM2(wellDiameterMap.get(wellId));
        const district = wellDistrictMap.get(wellId);
        const state = wellStateMap.get(wellId);

        const dailyExtractionByDate = new Map<string, number>(priorExtractionByWell.get(wellId) || []);
        const dailyMedianByDate = new Map<string, number>(priorMediansByWell.get(wellId) || []);
        for (const dateStr of sortedDates) {
          const dayReadings = dateMap.get(dateStr)!;
          const medianDepth = medianOf(dayReadings.map((r) => r.depth));
          dailyMedianByDate.set(dateStr, medianDepth);
          const lastReadingMs = Math.max(...dayReadings.map((r) => r.timestampMs));

          const safety = wellSafety({ medianDepthM: medianDepth, wellDepthM: wellDepth, pumpIntakeM: pumpIntake });
          const remainingDepth = safety.remainingDepthM;
          const remainingVolumeLiters =
            remainingDepth != null && wellArea != null ? wellArea * remainingDepth * 1000.0 : null;
          const safetyBuffer = safety.safetyBufferM;
          const dryRunRisk = safety.dryRunRisk;
          const safePumpOp = safety.safePumpOperation;

          // Use actual pump run data — no re-derivation, no fabrication
          const runAgg = pumpRunsByWellDate.get(`${wellId}_${dateStr}`) || { count: 0, runtime: 0, extraction: 0, drop: 0 };
          const dailyPumpRunCount = runAgg.count;
          const dailyPumpRuntimeMinutes = runAgg.runtime;
          const dailyWaterExtractionLiters = runAgg.extraction;
          const totalDropMeters = runAgg.drop;
          dailyExtractionByDate.set(dateStr, dailyWaterExtractionLiters);
          // 7 calendar days ending today, not the last 7 days that happened to have data.
          const sevenDay = rollingCalendarWindow(dailyExtractionByDate, dateStr, 7);
          const sevenDayWaterExtractionLiters = sevenDay.sum;
          const avgSevenDayExtractionLiters = sevenDay.avg;

          // Weekly/Monthly Well Summary (E) — populated every day so daily_well_summary below reads
          // avg_seven_day_extraction_liters back from this same table, not a private local copy.
          const weeklyPayload: Record<string, unknown> = {
            well_id: wellId,
            calculation_date: dateStr,
            seven_day_water_extraction_liters: sevenDayWaterExtractionLiters,
            avg_seven_day_extraction_liters: avgSevenDayExtractionLiters,
            seven_day_depth_change_meters: depthChangeOverDays(dailyMedianByDate, dateStr, 7),
            thirty_day_depth_change_meters: depthChangeOverDays(dailyMedianByDate, dateStr, 30),
            updated_at: new Date().toISOString(),
          };
          const change7Days = weeklyPayload.seven_day_depth_change_meters as number | null;
          const change30Days = weeklyPayload.thirty_day_depth_change_meters as number | null;
          if (district && (change7Days != null || change30Days != null)) {
            const wAggKey = `${district}__${dateStr}`;
            const wAgg = districtWeeklyAgg.get(wAggKey) || {
              sevenDaySum: 0,
              sevenDayCount: 0,
              thirtyDaySum: 0,
              thirtyDayCount: 0,
            };
            if (change7Days != null) {
              wAgg.sevenDaySum += change7Days;
              wAgg.sevenDayCount += 1;
            }
            if (change30Days != null) {
              wAgg.thirtyDaySum += change30Days;
              wAgg.thirtyDayCount += 1;
            }
            districtWeeklyAgg.set(wAggKey, wAgg);
          }
          await supabase.from("weekly_monthly_well_summary").upsert(weeklyPayload, { onConflict: "well_id, calculation_date" });

          await supabase.from("daily_well_summary").upsert({
            well_id: wellId,
            date: dateStr,
            daily_median_water_depth_meters: medianDepth,
            daily_pump_run_count: dailyPumpRunCount,
            daily_pump_runtime_minutes: dailyPumpRuntimeMinutes,
            daily_water_extraction_liters: dailyWaterExtractionLiters,
            daily_water_level_drop_meters: totalDropMeters,
            remaining_water_depth_meters: remainingDepth,
            remaining_water_volume_liters: remainingVolumeLiters,
            estimated_days_remaining:
              remainingVolumeLiters != null && avgSevenDayExtractionLiters > 0
                ? remainingVolumeLiters / avgSevenDayExtractionLiters
                : null,
            updated_at: new Date().toISOString(),
          }, { onConflict: "well_id, date" });

          let healthStatus = "Green";
          if (dryRunRisk) healthStatus = "Red";
          else if (!safePumpOp) healthStatus = "Amber";

          await supabase.from("daily_well_health_summary").upsert({
            well_id: wellId,
            date: dateStr,
            well_health_status: healthStatus,
            safety_buffer_meters: safetyBuffer,
            dry_run_risk_boolean: dryRunRisk,
            safe_pump_operation_boolean: safePumpOp,
            device_health_status: deviceHealthForDay(lastReadingMs, dateStr),
            updated_at: new Date().toISOString(),
          }, { onConflict: "well_id, date" });

          const alertChecks = [
            {
              code: "DRY_RUN_RISK",
              triggered: dryRunRisk && safetyBuffer != null,
              cleared: safety.dryRunCleared,
              field: "safetyBufferMeters",
              value: safetyBuffer != null ? `${safetyBuffer.toFixed(2)}m` : "",
            },
            {
              code: "LOW_WATER_LEVEL",
              triggered: safety.lowWaterLevel,
              cleared: safety.lowWaterCleared,
              field: "dailyMedianWaterDepthMeters",
              value: `${medianDepth.toFixed(2)}m`,
            },
          ];
          for (const check of alertChecks) {
            const openKey = `${check.code}_${wellId}`;
            const open = openAlerts.get(openKey);
            if (check.triggered && !open) {
              const datedKey = `${check.code}_${wellId}_${dateStr}`;
              if (alertedDates.has(datedKey)) continue;
              const { data: inserted } = await supabase.from("alert_logs").insert({
                alert_code: check.code,
                well_id: wellId,
                district: district || null,
                state: state || null,
                alert_type: "warning",
                trigger_field: check.field,
                trigger_value: check.value,
                status: "active",
                triggered_at: istNoonIso(dateStr),
              }).select("alert_id").maybeSingle();
              alertedDates.add(datedKey);
              if (inserted?.alert_id) openAlerts.set(openKey, { alertId: inserted.alert_id, date: dateStr });
            } else if (check.cleared && open && open.date < dateStr) {
              await supabase
                .from("alert_logs")
                .update({ status: "expired", expired_at: istNoonIso(dateStr) })
                .eq("alert_id", open.alertId);
              openAlerts.delete(openKey);
            }
          }

          if (district) {
            const aggKey = `${district}__${dateStr}`;
            const agg = districtDailyAgg.get(aggKey) || {
              wells: new Set<string>(),
              depthSum: 0,
              depthCount: 0,
              extraction: 0,
              runtime: 0,
            };
            agg.wells.add(wellId);
            agg.depthSum += medianDepth;
            agg.depthCount += 1;
            agg.extraction += dailyWaterExtractionLiters;
            agg.runtime += dailyPumpRuntimeMinutes;
            districtDailyAgg.set(aggKey, agg);
          }
        }
      }

      // 5. Per-district summaries from real aggregates only
      for (const [aggKey, agg] of districtDailyAgg.entries()) {
        const [districtName, dateStr] = aggKey.split("__");
        await supabase.from("district_daily_summary").upsert({
          district: districtName,
          date: dateStr,
          total_active_wells_per_district: agg.wells.size,
          total_daily_water_extraction_per_district_liters: agg.extraction,
          total_daily_pump_runtime_per_district_minutes: agg.runtime,
          avg_water_depth_per_district_meters: agg.depthCount > 0 ? agg.depthSum / agg.depthCount : null,
          avg_daily_pump_runtime_per_district_minutes: agg.wells.size > 0 ? agg.runtime / agg.wells.size : null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "district, date" });
      }

      // 6. Weekly/Monthly District Summary (H) — 7/30-day depth change averaged across the district's
      // wells (from districtWeeklyAgg above); 30-day extraction as a rolling sum of this district's own
      // daily totals, same rolling-window pattern as the well-level 7-day extraction above.
      const districtDailySeries = new Map<string, { date: string; extraction: number }[]>();
      for (const [aggKey, agg] of districtDailyAgg.entries()) {
        const [districtName, dateStr] = aggKey.split("__");
        const series = districtDailySeries.get(districtName) || [];
        series.push({ date: dateStr, extraction: agg.extraction });
        districtDailySeries.set(districtName, series);
      }
      for (const [districtName, series] of districtDailySeries.entries()) {
        series.sort((a, b) => a.date.localeCompare(b.date));
        for (let i = 0; i < series.length; i++) {
          const dateStr = series[i].date;
          const last30 = series.slice(Math.max(0, i - 29), i + 1);
          const thirtyDayExtraction = last30.reduce((sum, d) => sum + d.extraction, 0);
          const wAgg = districtWeeklyAgg.get(`${districtName}__${dateStr}`);
          const districtWeeklyPayload: Record<string, unknown> = {
            district: districtName,
            calculation_date: dateStr,
            thirty_day_water_extraction_per_district_liters: thirtyDayExtraction,
            updated_at: new Date().toISOString(),
          };
          if (wAgg && wAgg.sevenDayCount > 0) {
            districtWeeklyPayload.avg_seven_day_depth_change_per_district_meters = wAgg.sevenDaySum / wAgg.sevenDayCount;
            districtWeeklyPayload.avg_thirty_day_depth_change_per_district_meters = wAgg.thirtyDaySum / wAgg.thirtyDayCount;
          }
          await supabase
            .from("weekly_monthly_district_summary")
            .upsert(districtWeeklyPayload, { onConflict: "district, calculation_date" });
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Supabase tables updated from Firebase RTDB (no hardcoded master defaults).",
        syncedDevices: syncedDevicesCount,
        syncedReadings: syncedReadingsCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error) {
    console.error("Sync error:", error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
