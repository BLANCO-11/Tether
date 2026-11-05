/**
 * ─────────────────────────────────────────────────────────────────────────────
 * FLEET TELEMETRY — the HELD-OUT domain (compiled-builder programme, phase 1, D-313)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **SEALED.** Nothing in the generation path may be tuned against this workspace or its goals.
 * Its goals live outside the repo and run only at gates (`goalset:measure --gate`). Reading
 * this file to build the builder is exactly the leak the seal exists to prevent.
 *
 * ⚠ **SCHEMA-ONLY (D-311).** `queries: []`: the workspace gets its datasource and tools, and no
 * named queries or saved operations. That is the normal case in real use; a builder that
 * needs a hand-made reader to succeed has not been measured here.
 *
 * The five traps, each inverting an answer (D-313):
 *  1. UNITS: `readings.temperature` is in `readings.temp_unit` (C or F); `max_temp_c` is Celsius.
 *  2. PER-CLASS THRESHOLDS: `max_temp_c` / `min_battery_pct` differ by class; one number misses COLD.
 *  3. ABSENCE: a silent device has no recent rows (two have none at all), so it is visible only from
 *     `devices` via a LEFT JOIN.
 *  4. MAINTENANCE: readings inside a device's maintenance window do not count, and a device in
 *     maintenance at the as-of instant is not silent.
 *  5. TWO-LEVEL RECIPIENT: `devices.owner_email` is nullable; the fallback is `sites.contact_email`.
 * Plus: every LEGACY device is retired, so that class has zero active devices (the empty group).
 *
 * ⚠ **ALL DATA IS SYNTHETIC** — invented names on RFC 2606 `.example` domains. Deterministic: a
 * seeded PRNG, so the oracle and the reference SQL see the same rows on every seed.
 */
import type { DomainSpec, DomainTable } from "../generic/domain.js";

/** The instant every as-of computation in this domain is judged at. */
export const FLEET_AS_OF = "2026-06-30T12:00:00Z";
const AS_OF_MS = Date.parse(FLEET_AS_OF);
const WINDOW_HOURS = 48;

const DDL = `
DROP TABLE IF EXISTS alert_log, maintenance_windows, readings, devices, sites, device_classes CASCADE;

CREATE TABLE device_classes (
  class_code            text PRIMARY KEY,
  name                  text NOT NULL,
  max_temp_c            numeric(5,1) NOT NULL,
  min_battery_pct       int NOT NULL,
  reading_interval_mins int NOT NULL
);

CREATE TABLE sites (
  site_code     text PRIMARY KEY,
  name          text NOT NULL,
  region        text NOT NULL,
  contact_email text NOT NULL
);

CREATE TABLE devices (
  device_id    text PRIMARY KEY,
  class_code   text NOT NULL REFERENCES device_classes(class_code),
  site_code    text NOT NULL REFERENCES sites(site_code),
  label        text NOT NULL,
  installed_on date NOT NULL,
  status       text NOT NULL CHECK (status IN ('active','maintenance','retired')),
  owner_email  text
);

CREATE TABLE readings (
  device_id   text NOT NULL REFERENCES devices(device_id),
  read_at     timestamptz NOT NULL,
  temperature numeric(6,1),
  temp_unit   text NOT NULL CHECK (temp_unit IN ('C','F')),
  battery_pct int,
  PRIMARY KEY (device_id, read_at)
);

CREATE TABLE maintenance_windows (
  id        int PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(device_id),
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  reason    text NOT NULL
);

CREATE TABLE alert_log (
  id         int PRIMARY KEY,
  device_id  text NOT NULL REFERENCES devices(device_id),
  alert_type text NOT NULL,
  sent_at    timestamptz NOT NULL
);

-- Declared semantic tags (D-313, plan §5 rule 3): metadata the schema owner states, never inferred from a name.
COMMENT ON COLUMN sites.contact_email   IS 'foundry:tag=email';
COMMENT ON COLUMN devices.owner_email   IS 'foundry:tag=email';
COMMENT ON COLUMN readings.temperature  IS 'foundry:tag=temperature;unit_column=temp_unit';
COMMENT ON COLUMN device_classes.max_temp_c IS 'foundry:tag=temperature;unit=C';
COMMENT ON COLUMN readings.battery_pct  IS 'foundry:tag=percent';
COMMENT ON COLUMN device_classes.min_battery_pct IS 'foundry:tag=percent';
COMMENT ON COLUMN readings.read_at      IS 'foundry:tag=timestamp';
`;

// ── deterministic generation ──────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CLASSES = [
  { class_code: "COLD", name: "Cold-chain freezer", max_temp_c: -15, min_battery_pct: 40, reading_interval_mins: 15, normalC: [-22, -18] },
  { class_code: "REEF", name: "Refrigerated trailer", max_temp_c: 5, min_battery_pct: 30, reading_interval_mins: 30, normalC: [1, 4] },
  { class_code: "AMB", name: "Ambient cargo tracker", max_temp_c: 45, min_battery_pct: 20, reading_interval_mins: 60, normalC: [15, 32] },
  { class_code: "DOOR", name: "Door sensor", max_temp_c: 60, min_battery_pct: 15, reading_interval_mins: 120, normalC: [10, 35] },
  { class_code: "LEGACY", name: "Legacy beacon", max_temp_c: 50, min_battery_pct: 10, reading_interval_mins: 240, normalC: [10, 30] },
] as const;

const SITES = [
  ["ROT-DEPOT", "Rotterdam depot", "EMEA", "rotterdam-ops@fleet-ops.example"],
  ["LYN-HUB", "Lyon cross-dock", "EMEA", "lyon-ops@fleet-ops.example"],
  ["NWK-YARD", "Newark yard", "AMER", "newark-ops@fleet-ops.example"],
  ["DAL-COLD", "Dallas cold store", "AMER", "dallas-cold@fleet-ops.example"],
  ["SIN-PORT", "Singapore port", "APAC", "singapore-ops@fleet-ops.example"],
  ["OSA-DC", "Osaka distribution centre", "APAC", "osaka-ops@fleet-ops.example"],
] as const;

/**
 * Each device's ROLE is chosen here, by hand, so every trap has named members. The oracle does not
 * read these roles: it recomputes everything from the rows, so a generator bug cannot agree with itself.
 */
type Role = "normal" | "overheat" | "overheat_in_maintenance_only" | "low_battery" | "silent" | "never_reported" | "maintenance_now" | "retired";
interface DeviceDef { id: string; cls: (typeof CLASSES)[number]["class_code"]; site: string; unit: "C" | "F"; role: Role; owner: boolean }

const DEVICES: DeviceDef[] = [
  // COLD — the strict class. c07 at 35% battery is above REEF/AMB/DOOR's minimum and below COLD's 40 (trap 2).
  { id: "c01", cls: "COLD", site: "DAL-COLD", unit: "C", role: "normal", owner: true },
  { id: "c02", cls: "COLD", site: "DAL-COLD", unit: "C", role: "overheat", owner: true },
  { id: "c03", cls: "COLD", site: "DAL-COLD", unit: "F", role: "normal", owner: true },     // −4 °F reads "cold" raw but is −20 °C: fine
  { id: "c04", cls: "COLD", site: "ROT-DEPOT", unit: "F", role: "overheat", owner: false },  // 14 °F = −10 °C > −15: overheat, unowned (trap 1+5)
  { id: "c05", cls: "COLD", site: "ROT-DEPOT", unit: "C", role: "silent", owner: true },
  { id: "c06", cls: "COLD", site: "SIN-PORT", unit: "C", role: "overheat_in_maintenance_only", owner: true },
  { id: "c07", cls: "COLD", site: "SIN-PORT", unit: "C", role: "low_battery", owner: true },
  { id: "c08", cls: "COLD", site: "OSA-DC", unit: "C", role: "maintenance_now", owner: true },
  // REEF
  { id: "r01", cls: "REEF", site: "ROT-DEPOT", unit: "C", role: "normal", owner: true },
  { id: "r02", cls: "REEF", site: "ROT-DEPOT", unit: "F", role: "normal", owner: true },     // 38 °F = 3.3 °C: fine, but 38 > 5 raw (trap 1 false positive)
  { id: "r03", cls: "REEF", site: "LYN-HUB", unit: "F", role: "normal", owner: false },
  { id: "r04", cls: "REEF", site: "LYN-HUB", unit: "C", role: "overheat", owner: true },
  { id: "r05", cls: "REEF", site: "NWK-YARD", unit: "C", role: "low_battery", owner: false },
  { id: "r06", cls: "REEF", site: "NWK-YARD", unit: "F", role: "overheat", owner: true },    // 50 °F = 10 °C > 5
  { id: "r07", cls: "REEF", site: "DAL-COLD", unit: "C", role: "never_reported", owner: true },
  { id: "r08", cls: "REEF", site: "SIN-PORT", unit: "C", role: "silent", owner: false },
  { id: "r09", cls: "REEF", site: "OSA-DC", unit: "C", role: "normal", owner: true },
  { id: "r10", cls: "REEF", site: "OSA-DC", unit: "C", role: "maintenance_now", owner: true },
  // AMB
  { id: "a01", cls: "AMB", site: "ROT-DEPOT", unit: "C", role: "normal", owner: true },
  { id: "a02", cls: "AMB", site: "LYN-HUB", unit: "F", role: "normal", owner: true },       // 86 °F = 30 °C: fine, 86 > 45 raw
  { id: "a03", cls: "AMB", site: "NWK-YARD", unit: "F", role: "normal", owner: true },
  { id: "a04", cls: "AMB", site: "NWK-YARD", unit: "C", role: "overheat", owner: false },
  { id: "a05", cls: "AMB", site: "DAL-COLD", unit: "C", role: "normal", owner: true },
  { id: "a06", cls: "AMB", site: "SIN-PORT", unit: "C", role: "low_battery", owner: true },
  { id: "a07", cls: "AMB", site: "SIN-PORT", unit: "F", role: "silent", owner: true },
  { id: "a08", cls: "AMB", site: "OSA-DC", unit: "C", role: "normal", owner: false },
  { id: "a09", cls: "AMB", site: "OSA-DC", unit: "C", role: "overheat_in_maintenance_only", owner: true },
  { id: "a10", cls: "AMB", site: "LYN-HUB", unit: "C", role: "normal", owner: true },
  { id: "a11", cls: "AMB", site: "ROT-DEPOT", unit: "C", role: "normal", owner: true },
  { id: "a12", cls: "AMB", site: "NWK-YARD", unit: "C", role: "never_reported", owner: false },
  // DOOR
  { id: "d01", cls: "DOOR", site: "ROT-DEPOT", unit: "C", role: "normal", owner: true },
  { id: "d02", cls: "DOOR", site: "LYN-HUB", unit: "C", role: "normal", owner: true },
  { id: "d03", cls: "DOOR", site: "NWK-YARD", unit: "F", role: "normal", owner: true },
  { id: "d04", cls: "DOOR", site: "DAL-COLD", unit: "C", role: "low_battery", owner: false },
  { id: "d05", cls: "DOOR", site: "SIN-PORT", unit: "C", role: "silent", owner: true },
  { id: "d06", cls: "DOOR", site: "OSA-DC", unit: "C", role: "normal", owner: true },
  { id: "d07", cls: "DOOR", site: "OSA-DC", unit: "F", role: "overheat", owner: true },     // 150 °F = 65.6 °C > 60
  { id: "d08", cls: "DOOR", site: "ROT-DEPOT", unit: "C", role: "retired", owner: true },
  // LEGACY — every one retired: an empty class (the zero-row aggregate).
  { id: "l01", cls: "LEGACY", site: "LYN-HUB", unit: "C", role: "retired", owner: true },
  { id: "l02", cls: "LEGACY", site: "NWK-YARD", unit: "C", role: "retired", owner: false },
  { id: "l03", cls: "LEGACY", site: "SIN-PORT", unit: "C", role: "retired", owner: true },
];

const iso = (ms: number) => new Date(ms).toISOString();
const toUnit = (c: number, unit: "C" | "F") => Math.round((unit === "F" ? c * 9 / 5 + 32 : c) * 10) / 10;

function build(): { tables: DomainTable[] } {
  const rnd = mulberry32(20260630);
  const cls = new Map(CLASSES.map((c) => [c.class_code, c]));
  const devices: unknown[][] = [];
  const readings: unknown[][] = [];
  const maint: unknown[][] = [];
  const alerts: unknown[][] = [];
  let mid = 1, aid = 1;
  for (const d of DEVICES) {
    const c = cls.get(d.cls)!;
    const status = d.role === "retired" ? "retired" : d.role === "maintenance_now" ? "maintenance" : "active";
    const owner = d.owner ? `${d.id}.owner@fleet-ops.example` : null;
    devices.push([d.id, d.cls, d.site, `${c.name} ${d.id.toUpperCase()}`, "2025-03-01", status, owner]);
    if (d.role === "retired" || d.role === "never_reported") continue;

    const step = c.reading_interval_mins * 60_000;
    // A silent device stopped 4× its interval (plus an hour) before as-of: past the 3× line.
    const lastMs = d.role === "silent" ? AS_OF_MS - (4 * step + 3_600_000) : d.role === "maintenance_now" ? AS_OF_MS - 6 * step - 3_600_000 : AS_OF_MS;
    const firstMs = AS_OF_MS - WINDOW_HOURS * 3_600_000;
    const [lo, hi] = c.normalC;
    let battery = 70 + Math.floor(rnd() * 25);
    const readingsOfDevice: Array<{ t: number; c: number }> = [];
    for (let t = firstMs; t <= lastMs; t += step) {
      let tempC = lo + rnd() * (hi - lo);
      const last = t + step > lastMs;
      if (d.role === "overheat" && last) tempC = c.max_temp_c + 5;
      battery = Math.max(1, battery - (rnd() < 0.2 ? 1 : 0));
      let bat = battery;
      if (d.role === "low_battery" && last) bat = c.min_battery_pct - 5;
      readingsOfDevice.push({ t, c: tempC });
      readings.push([d.id, iso(t), toUnit(tempC, d.unit), d.unit, bat]);
    }
    if (d.role === "overheat_in_maintenance_only") {
      // The last three readings are hot, and a service visit covers exactly those three.
      const hot = readings.slice(-3);
      for (const r of hot) r[2] = toUnit(c.max_temp_c + 8, d.unit);
      maint.push([mid++, d.id, iso(Date.parse(hot[0]![1] as string) - 60_000), iso(AS_OF_MS + 3_600_000), "scheduled service"]);
    }
    if (d.role === "maintenance_now") {
      maint.push([mid++, d.id, iso(lastMs + 60_000), iso(AS_OF_MS + 24 * 3_600_000), "compressor replacement"]);
    }
    // A past alert for some devices, for dedupe goals.
    if (d.role === "overheat" || d.role === "low_battery") {
      alerts.push([aid++, d.id, d.role === "overheat" ? "overheat" : "low_battery", iso(AS_OF_MS - 36 * 3_600_000)]);
    }
  }
  return {
    tables: [
      { table: "device_classes", columns: ["class_code", "name", "max_temp_c", "min_battery_pct", "reading_interval_mins"], rows: CLASSES.map((c) => [c.class_code, c.name, c.max_temp_c, c.min_battery_pct, c.reading_interval_mins]) },
      { table: "sites", columns: ["site_code", "name", "region", "contact_email"], rows: SITES.map((s) => [...s]) },
      { table: "devices", columns: ["device_id", "class_code", "site_code", "label", "installed_on", "status", "owner_email"], rows: devices },
      { table: "readings", columns: ["device_id", "read_at", "temperature", "temp_unit", "battery_pct"], rows: readings },
      { table: "maintenance_windows", columns: ["id", "device_id", "starts_at", "ends_at", "reason"], rows: maint },
      { table: "alert_log", columns: ["id", "device_id", "alert_type", "sent_at"], rows: alerts },
    ],
  };
}

const BUILT = build();

/** The rows, exported for the oracle, which recomputes every answer from them and never reads `DEVICES`' roles. */
export const FLEET_TABLES: DomainTable[] = BUILT.tables;

export const FLEET_DOMAIN: DomainSpec = {
  key: "fleet",
  workspaceName: "Fleet Telemetry",
  dbName: "fleet_demo",
  roRole: "fleet_ro",
  secretEnv: "FLEET_DB_URL",
  ddl: DDL,
  tables: FLEET_TABLES,
  queries: [], // ⚠ schema-only, D-311
  opsServices: ["mail", "chat", "ticketing", "llm"],
  description: "Held-out domain: device telemetry across sites, with per-class thresholds, units, maintenance windows and silent devices.",
};
