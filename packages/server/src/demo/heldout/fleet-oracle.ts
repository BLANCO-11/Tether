/**
 * The Fleet Telemetry oracle — the right answers, computed from the ROWS alone (D-313).
 *
 * ⚠ A SEPARATE function, never a parameterisation of another domain's oracle, and it never reads the
 * generator's per-device roles: it recomputes from the tables, so a bug in the generator cannot produce
 * an answer that agrees with itself. Pure: no database.
 *
 * Rules, stated once:
 *  - A reading counts only if it is NOT inside a maintenance window of its device.
 *  - A device's "latest reading" is its most recent COUNTING reading at or before the as-of instant.
 *  - Temperatures are converted to Celsius from the reading's own `temp_unit` before any comparison.
 *  - Overheating: status `active`, latest reading's °C > its class's `max_temp_c`.
 *  - Low battery: status `active`, latest reading's `battery_pct` < its class's `min_battery_pct`.
 *  - Silent: status `active`, not inside a maintenance window at the as-of instant, and no reading of ANY kind
 *    within 3 × its class's `reading_interval_mins` before as-of (including devices with no readings at all).
 *  - Notify address: `owner_email`, else the site's `contact_email`.
 */
import type { DomainTable } from "../generic/domain.js";

type Row = Record<string, unknown>;
const rowsOf = (tables: DomainTable[], name: string): Row[] => {
  const t = tables.find((x) => x.table === name);
  if (!t) throw new Error(`no table ${name}`);
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, (r as unknown[])[i]])));
};
const toC = (v: number, unit: string) => (unit === "F" ? ((v - 32) * 5) / 9 : v);

export interface FleetDeviceAnswer { device_id: string; class_code: string; site_code: string; notify_email: string; temp_c?: number; battery_pct?: number }
export interface FleetClassAnswer { class_code: string; active_devices: number; overheating: number; avg_latest_temp_c: number | null }
export interface FleetOracle {
  overheating: FleetDeviceAnswer[];
  lowBattery: FleetDeviceAnswer[];
  silent: FleetDeviceAnswer[];
  byClass: FleetClassAnswer[];
}

export function fleetOracle(tables: DomainTable[], asOf: string): FleetOracle {
  const asOfMs = Date.parse(asOf);
  const classes = new Map(rowsOf(tables, "device_classes").map((c) => [c.class_code as string, c]));
  const sites = new Map(rowsOf(tables, "sites").map((s) => [s.site_code as string, s]));
  const devices = rowsOf(tables, "devices");
  const readings = rowsOf(tables, "readings");
  const windows = rowsOf(tables, "maintenance_windows");

  const inWindow = (deviceId: string, ms: number) =>
    windows.some((w) => w.device_id === deviceId && Date.parse(w.starts_at as string) <= ms && ms <= Date.parse(w.ends_at as string));
  const notify = (d: Row) => (d.owner_email as string | null) ?? (sites.get(d.site_code as string)!.contact_email as string);

  const latestCounting = new Map<string, Row>();
  const latestAny = new Map<string, number>();
  for (const r of readings) {
    const id = r.device_id as string, ms = Date.parse(r.read_at as string);
    if (ms > asOfMs) continue;
    if (ms > (latestAny.get(id) ?? -Infinity)) latestAny.set(id, ms);
    if (inWindow(id, ms)) continue;
    const cur = latestCounting.get(id);
    if (!cur || ms > Date.parse(cur.read_at as string)) latestCounting.set(id, r);
  }

  const answer = (d: Row, extra: Partial<FleetDeviceAnswer> = {}): FleetDeviceAnswer => ({
    device_id: d.device_id as string, class_code: d.class_code as string, site_code: d.site_code as string, notify_email: notify(d), ...extra,
  });
  const active = devices.filter((d) => d.status === "active");
  const overheating: FleetDeviceAnswer[] = [], lowBattery: FleetDeviceAnswer[] = [], silent: FleetDeviceAnswer[] = [];
  for (const d of active) {
    const c = classes.get(d.class_code as string)!;
    const r = latestCounting.get(d.device_id as string);
    if (r && r.temperature != null) {
      const tc = toC(Number(r.temperature), r.temp_unit as string);
      if (tc > Number(c.max_temp_c)) overheating.push(answer(d, { temp_c: Math.round(tc * 10) / 10 }));
    }
    if (r && r.battery_pct != null && Number(r.battery_pct) < Number(c.min_battery_pct)) lowBattery.push(answer(d, { battery_pct: Number(r.battery_pct) }));
    const last = latestAny.get(d.device_id as string);
    const limit = 3 * Number(c.reading_interval_mins) * 60_000;
    if (!inWindow(d.device_id as string, asOfMs) && (last === undefined || asOfMs - last > limit)) silent.push(answer(d));
  }

  const byClass: FleetClassAnswer[] = [...classes.keys()].sort().map((code) => {
    const members = active.filter((d) => d.class_code === code);
    const temps = members
      .map((d) => latestCounting.get(d.device_id as string))
      .filter((r): r is Row => !!r && r.temperature != null)
      .map((r) => toC(Number(r.temperature), r.temp_unit as string));
    return {
      class_code: code,
      active_devices: members.length,
      overheating: overheating.filter((o) => o.class_code === code).length,
      avg_latest_temp_c: temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10 : null,
    };
  });
  const byId = (a: FleetDeviceAnswer, b: FleetDeviceAnswer) => a.device_id.localeCompare(b.device_id);
  return { overheating: overheating.sort(byId), lowBattery: lowBattery.sort(byId), silent: silent.sort(byId), byClass };
}
