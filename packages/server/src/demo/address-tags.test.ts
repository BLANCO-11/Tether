import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADDRESS_COLUMNS } from "./address-tags.js";
import { HIRING_DOMAIN, ORDERS_DOMAIN, SUPPORT_DOMAIN } from "./generic/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const DDL: Record<string, string> = {
  hr_demo: readFileSync(join(here, "hr-schema.sql"), "utf8"),
  finance_demo: readFileSync(join(here, "finance/finance-schema.sql"), "utf8"),
  itops_demo: readFileSync(join(here, "itops/itops-schema.sql"), "utf8"),
  legal_demo: readFileSync(join(here, "legal/legal-schema.sql"), "utf8"),
  support_demo: SUPPORT_DOMAIN.ddl,
  orders_demo: ORDERS_DOMAIN.ddl,
  hiring_demo: HIRING_DOMAIN.ddl,
};
/** Every `table.column` whose name holds "email" and whose type is text-like, read from CREATE TABLE blocks. */
function emailColumns(ddl: string): string[] {
  const out: string[] = [];
  for (const m of ddl.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    for (const c of m[2]!.matchAll(/^\s*(\w*email\w*)\s+(text|varchar|character varying)/gim)) out.push(`${m[1]}.${c[1]}`);
  }
  return out.sort();
}

describe("the demo databases' address columns are declared (I-283)", () => {
  it("every email column in every seed's DDL is tagged, and nothing else is", () => {
    for (const [db, ddl] of Object.entries(DDL)) {
      const found = emailColumns(ddl);
      expect(found.length, `${db}: the DDL scan found no email column at all — the scan is broken, not the data`).toBeGreaterThan(0);
      expect([...(ADDRESS_COLUMNS[db] ?? [])].sort(), db).toEqual(found);
    }
  });
});

describe("the row identities are declared, on a real text column, and never on an address", () => {
  it("each KEY column exists as text in its seed's DDL and is not also an address", async () => {
    const { KEY_COLUMNS } = await import("./address-tags.js");
    expect(Object.keys(KEY_COLUMNS).length).toBeGreaterThan(0);
    for (const [db, cols] of Object.entries(KEY_COLUMNS)) {
      for (const tc of cols) {
        const [table, column] = tc.split(".");
        const block = DDL[db]!.match(new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?(?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"));
        expect(block, `${db}: no table ${table}`).not.toBeNull();
        expect(block![1], `${db}.${tc} is not a text column`).toMatch(new RegExp(`^\\s*${column}\\s+(text|varchar|character varying)`, "im"));
        expect(ADDRESS_COLUMNS[db] ?? [], `${db}.${tc} is declared both a key and an address`).not.toContain(tc);
      }
    }
  });
});
