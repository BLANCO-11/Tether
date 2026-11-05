import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { config } from "../config/index.js";
import {
  buildAttendance,
  DEPARTMENTS,
  LEAVE_REQUESTS,
  OFFICES,
  POLICY_THRESHOLDS,
  ROSTER,
  workEmail,
} from "./hr-dataset.js";
import { ensureReadOnlyRole, type ReadOnlyRoleReport } from "./hr-roles.js";
import { applyColumnTags } from "./address-tags.js";

/**
 * Creates and populates the `hr_demo` database
 * (plans/hr-demo-stub-services-plan.md §8).
 *
 * WHY A SEPARATE DATABASE, not a schema in `foundry_parent`:
 * schema-introspector.service.ts is hardcoded to table_schema = 'public'. Demo
 * tables in the parent DB would therefore be introspected alongside `scripts`,
 * `tools`, `triggers` and the stub_* capture tables — the agent would be told
 * its HR datasource contains the app's own control tables, and a generated
 * script could satisfy "send the emails" with an INSERT into the mail capture
 * table — which now lives in ops-api's database, a network hop and an API key
 * further away again (Stage 5).
 * A separate database is the only boundary that actually holds.
 */

const here = dirname(fileURLToPath(import.meta.url));

export const HR_DB_NAME = config.demo.dbName;

/** Admin URL (points at an existing DB) used only to CREATE DATABASE. */
function adminUrl(): string {
  return config.databaseUrl;
}

/** URL of the demo DB itself, derived from DATABASE_URL by swapping the path. */
export function hrDbUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = `/${HR_DB_NAME}`;
  return u.toString();
}

/**
 * Parent-facing URL of the demo DB as the READ-ONLY role (WS-A). Used for
 * introspection and for the negative privilege tests — anywhere we want to see
 * exactly what a generated script would see.
 */
export function hrRoDbUrl(): string {
  const u = new URL(hrDbUrl());
  u.username = config.demo.roRole;
  u.password = config.demo.roPassword;
  return u.toString();
}

/**
 * The connection string handed to GENERATED SCRIPTS. Those run in a sibling
 * Docker container, so `localhost` and the compose service name `postgres` both
 * resolve to the wrong place — see plan §12. The executor starts containers with
 * `--add-host=host.docker.internal:host-gateway`, so route via the host's
 * published port (5433), overridable for Linux hosts where the gateway alias is
 * unavailable (DEMO_DB_HOST=172.17.0.1).
 *
 * WS-A: this is built from the READ-ONLY role, never the owner. The owner
 * credential must never reach a manifest, a secret store, or a container.
 */
export function hrDbUrlForScripts(): string {
  const u = new URL(hrRoDbUrl());
  u.hostname = config.demo.dbHostForScripts;
  u.port = config.demo.dbPortForScripts;
  return u.toString();
}

async function ensureDatabase(): Promise<boolean> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [
      HR_DB_NAME,
    ]);
    if (rows.length > 0) return false;
    // Identifier cannot be parameterised; HR_DB_NAME is validated instead.
    if (!/^[a-z_][a-z0-9_]*$/.test(HR_DB_NAME)) {
      throw new Error(`unsafe demo database name: ${HR_DB_NAME}`);
    }
    await admin.query(`CREATE DATABASE ${HR_DB_NAME}`);
    return true;
  } finally {
    await admin.end();
  }
}

/** Bulk INSERT with a single multi-row VALUES statement per chunk. */
async function insertRows(
  client: Client,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunk = 500,
) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = slice.map((r) => {
      const ph = r.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(",")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`,
      params,
    );
  }
}

export interface SeedReport {
  databaseCreated: boolean;
  database: string;
  counts: Record<string, number>;
  /** WS-A: the least-privilege role generated scripts connect as. */
  readOnlyRole: ReadOnlyRoleReport;
}

export async function seedHrDatabase(): Promise<SeedReport> {
  const databaseCreated = await ensureDatabase();

  const ddl = await readFile(join(here, "hr-schema.sql"), "utf8");
  const client = new Client({ connectionString: hrDbUrl() });
  await client.connect();
  try {
    // The DDL drops and recreates every table, so seeding is idempotent.
    await client.query(ddl);
    await applyColumnTags(client, "hr_demo"); // I-283 / D-325: a column comment only — no row or query result changes

    await insertRows(
      client,
      "offices",
      ["id", "code", "city", "country", "region", "timezone"],
      OFFICES.map((o) => [o.id, o.code, o.city, o.country, o.region, o.timezone]),
    );

    await insertRows(
      client,
      "departments",
      ["id", "code", "name", "cost_centre"],
      DEPARTMENTS.map((d) => [d.id, d.code, d.name, d.costCentre]),
    );

    // Employees carry a self-referencing manager_id, so the FK is only
    // satisfiable if managers land before their reports. Insert in dependency
    // order (managers first) rather than relying on roster ordering.
    const ordered: typeof ROSTER = [];
    const placed = new Set<number>();
    let guard = 0;
    while (ordered.length < ROSTER.length) {
      if (guard++ > ROSTER.length + 5) {
        throw new Error("could not order employees by manager — cycle in ROSTER?");
      }
      for (const e of ROSTER) {
        if (placed.has(e.id)) continue;
        if (e.managerId === null || placed.has(e.managerId)) {
          ordered.push(e);
          placed.add(e.id);
        }
      }
    }

    await insertRows(
      client,
      "employees",
      [
        "id",
        "employee_code",
        "full_name",
        "work_email",
        "department_id",
        "office_id",
        "manager_id",
        "job_title",
        "employment_type",
        "status",
        "hire_date",
        "exit_date",
      ],
      ordered.map((e) => [
        e.id,
        e.code,
        e.name,
        workEmail(e),
        e.deptId,
        e.officeId,
        e.managerId,
        e.title,
        e.employmentType,
        e.status,
        e.hireDate,
        e.exitDate ?? null,
      ]),
    );

    await insertRows(
      client,
      "policy_thresholds",
      ["id", "department_id", "min_attendance_rate", "effective_from"],
      POLICY_THRESHOLDS.map((p) => [p.id, p.departmentId, p.minAttendanceRate, p.effectiveFrom]),
    );

    await insertRows(
      client,
      "leave_requests",
      ["id", "employee_id", "leave_type", "start_date", "end_date", "status", "reason"],
      LEAVE_REQUESTS.map((l) => [
        l.id,
        l.employeeId,
        l.leaveType,
        l.startDate,
        l.endDate,
        l.status,
        l.reason,
      ]),
    );

    const { daily, monthly } = buildAttendance();
    await insertRows(
      client,
      "attendance_daily",
      ["employee_id", "work_date", "status", "hours_worked"],
      daily.map((d) => [d.employeeId, d.workDate, d.status, d.hoursWorked]),
    );
    await insertRows(
      client,
      "attendance_monthly",
      ["employee_id", "period", "working_days", "days_attended", "attendance_rate"],
      monthly.map((m) => [m.employeeId, m.period, m.workingDays, m.daysAttended, m.attendanceRate]),
    );

    // Keep sequences past the explicit ids we inserted.
    await client.query("SELECT setval(pg_get_serial_sequence('attendance_daily','id'), (SELECT max(id) FROM attendance_daily))");
    await client.query("SELECT setval(pg_get_serial_sequence('attendance_monthly','id'), (SELECT max(id) FROM attendance_monthly))");
    // ANALYZE before granting so pg_class.reltuples is populated by the owner —
    // the read-only role introspects afterwards and needs real row estimates
    // rather than the -1 of a never-analysed table (WS-A.6).
    await client.query("ANALYZE");

    // AFTER the DDL and the data: hr-schema.sql drops every table, and table
    // privileges die with the table, so grants issued earlier would vanish.
    const readOnlyRole = await ensureReadOnlyRole(client);

    const counts: Record<string, number> = {};
    for (const t of [
      "offices",
      "departments",
      "employees",
      "policy_thresholds",
      "leave_requests",
      "attendance_daily",
      "attendance_monthly",
    ]) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts[t] = rows[0].n as number;
    }

    return { databaseCreated, database: HR_DB_NAME, counts, readOnlyRole };
  } finally {
    await client.end();
  }
}
