-- Manual, one-off clean-up of bad rows found in the Oct 2026 code review.
-- NOT a migration — run by hand in the Supabase SQL editor, AFTER a "Last 365 Days" Fetch & Populate
-- with the fixed sync code (so every late copy has its correctly timed twin).
-- The SQL editor only shows the LAST statement's result, so run each step on its own:
-- select the step's lines and press Run.

-- ============================================================================
-- STEP A. Back up the raw table (once). RLS on with no policies = hidden from the website's keys.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.raw_sensor_data_backup_20261030 AS
SELECT * FROM public.raw_sensor_data;
ALTER TABLE public.raw_sensor_data_backup_20261030 ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- STEP B. Dry run — counts only, changes nothing. A row can fall in more than one group.
-- ============================================================================
SELECT
  (SELECT count(*) FROM public.raw_sensor_data) AS total_rows,
  (SELECT count(*) FROM public.raw_sensor_data_backup_20261030) AS backup_rows,
  -- 1. Copies stored 5h30m late: the old server sync read IST device times as UTC. The late copy is
  --    the one with an identical reading (same device, same depth) exactly 5h30m EARLIER.
  (SELECT count(*) FROM public.raw_sensor_data late
    WHERE EXISTS (
      SELECT 1 FROM public.raw_sensor_data ok
      WHERE ok.device_id = late.device_id
        AND ok.timestamp = late.timestamp - interval '5 hours 30 minutes'
        AND ok.depth_meters = late.depth_meters
    )) AS late_copies,
  -- 2. Readings stamped "now" by the old Admin sync. Devices send whole seconds, so a timestamp with
  --    milliseconds can only have come from the sync's own clock.
  (SELECT count(*) FROM public.raw_sensor_data
    WHERE extract(milliseconds FROM timestamp)::numeric % 1000 <> 0) AS now_stamped,
  -- 3. Depths deeper than the well itself.
  (SELECT count(*) FROM public.raw_sensor_data r
    JOIN public.well_master w ON w.well_id = r.well_id
    WHERE w.well_depth_meters IS NOT NULL AND r.depth_meters > w.well_depth_meters) AS deeper_than_well,
  -- 4. Demo wells shown as live.
  (SELECT count(*) FROM public.well_master
    WHERE well_id LIKE 'WEL-DEMO%' AND status IS DISTINCT FROM 'Inactive') AS demo_wells_to_deactivate;

-- ============================================================================
-- STEP C. Delete — only after the STEP B counts look right. Runs as one transaction: all or nothing.
-- ============================================================================
BEGIN;

DELETE FROM public.raw_sensor_data late
WHERE EXISTS (
  SELECT 1 FROM public.raw_sensor_data ok
  WHERE ok.device_id = late.device_id
    AND ok.timestamp = late.timestamp - interval '5 hours 30 minutes'
    AND ok.depth_meters = late.depth_meters
);

DELETE FROM public.raw_sensor_data
WHERE extract(milliseconds FROM timestamp)::numeric % 1000 <> 0;

DELETE FROM public.raw_sensor_data r
USING public.well_master w
WHERE w.well_id = r.well_id
  AND w.well_depth_meters IS NOT NULL
  AND r.depth_meters > w.well_depth_meters;

UPDATE public.well_master SET status = 'Inactive' WHERE well_id LIKE 'WEL-DEMO%';

COMMIT;

-- Afterwards: run STEP B again (all three groups should be 0), then rebuild the derived tables with
-- Admin → "Last 365 Days" → Fetch & Populate, so pump_run_summary, daily/weekly summaries and
-- alert_logs are recomputed from clean readings. To undo before the rebuild, restore from
-- raw_sensor_data_backup_20261030.
