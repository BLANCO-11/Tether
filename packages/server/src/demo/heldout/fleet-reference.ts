/**
 * Reference SQL for Fleet Telemetry — an INDEPENDENT second implementation of `fleetOracle` (D-313).
 *
 * ⚠ Not registered anywhere: the held-out workspace is schema-only (D-311), so these are never a
 * named query or a saved operation. They exist so `heldout:verify` can show two implementations
 * agree row for row, and nothing else. Parameter `$1` is the as-of instant.
 */
const COUNTING = `
  SELECT r.* FROM readings r
   WHERE r.read_at <= $1::timestamptz
     AND NOT EXISTS (SELECT 1 FROM maintenance_windows w
                      WHERE w.device_id = r.device_id AND r.read_at BETWEEN w.starts_at AND w.ends_at)`;
const LATEST = `
  SELECT DISTINCT ON (device_id) device_id, read_at, temperature, temp_unit, battery_pct
    FROM (${COUNTING}) c ORDER BY device_id, read_at DESC`;
const TEMP_C = `CASE l.temp_unit WHEN 'F' THEN (l.temperature - 32) * 5 / 9 ELSE l.temperature END`;
const NOTIFY = `COALESCE(d.owner_email, s.contact_email)`;

export const FLEET_REFERENCE_SQL = {
  overheating: `
    SELECT d.device_id, d.class_code, d.site_code, ${NOTIFY} AS notify_email, round(${TEMP_C}, 1)::float AS temp_c
      FROM devices d JOIN sites s USING (site_code) JOIN device_classes k USING (class_code)
      JOIN (${LATEST}) l ON l.device_id = d.device_id
     WHERE d.status = 'active' AND l.temperature IS NOT NULL AND ${TEMP_C} > k.max_temp_c
     ORDER BY d.device_id`,
  lowBattery: `
    SELECT d.device_id, d.class_code, d.site_code, ${NOTIFY} AS notify_email, l.battery_pct
      FROM devices d JOIN sites s USING (site_code) JOIN device_classes k USING (class_code)
      JOIN (${LATEST}) l ON l.device_id = d.device_id
     WHERE d.status = 'active' AND l.battery_pct IS NOT NULL AND l.battery_pct < k.min_battery_pct
     ORDER BY d.device_id`,
  silent: `
    SELECT d.device_id, d.class_code, d.site_code, ${NOTIFY} AS notify_email
      FROM devices d JOIN sites s USING (site_code) JOIN device_classes k USING (class_code)
      LEFT JOIN (SELECT device_id, max(read_at) AS last_at FROM readings WHERE read_at <= $1::timestamptz GROUP BY device_id) a
             ON a.device_id = d.device_id
     WHERE d.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM maintenance_windows w WHERE w.device_id = d.device_id AND $1::timestamptz BETWEEN w.starts_at AND w.ends_at)
       AND (a.last_at IS NULL OR a.last_at < $1::timestamptz - make_interval(mins => 3 * k.reading_interval_mins))
     ORDER BY d.device_id`,
  byClass: `
    SELECT k.class_code,
           count(d.device_id)::int AS active_devices,
           count(*) FILTER (WHERE l.temperature IS NOT NULL AND ${TEMP_C} > k.max_temp_c)::int AS overheating,
           round(avg(${TEMP_C}) FILTER (WHERE l.temperature IS NOT NULL), 1)::float AS avg_latest_temp_c
      FROM device_classes k
      LEFT JOIN devices d ON d.class_code = k.class_code AND d.status = 'active'
      LEFT JOIN (${LATEST}) l ON l.device_id = d.device_id
     GROUP BY k.class_code ORDER BY k.class_code`,
} as const;
