import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveResourceCategory,
  deriveResourceTypeLabel,
  healthSentence,
  RESOURCE_STATUSES,
  RESOURCE_HEALTHS,
} from "./resource.service.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("resourceService — B-13 S-48 vocabulary", () => {
  it("exposes 9 ResourceStatus values", () => {
    expect(RESOURCE_STATUSES).toEqual([
      "setup",
      "draft",
      "pending-review",
      "approved",
      "published",
      "paused",
      "failed",
      "deprecated",
      "archived",
    ]);
  });

  it("exposes 5 ResourceHealth values", () => {
    expect(RESOURCE_HEALTHS).toEqual([
      "healthy",
      "waiting_review",
      "expires_soon",
      "not_connected",
      "superseded",
    ]);
  });

  it("deriveResourceCategory mirrors client page.tsx verbatim", () => {
    expect(deriveResourceCategory("postgres")).toBe("datasource");
    expect(deriveResourceCategory("postgresql")).toBe("datasource");
    expect(deriveResourceCategory("Amazon S3")).toBe("datasource");
    expect(deriveResourceCategory("SFTP")).toBe("datasource");
    expect(deriveResourceCategory("email_connector")).toBe("connector");
    expect(deriveResourceCategory("rest")).toBe("connector");
    expect(deriveResourceCategory("REST connector")).toBe("connector");
    expect(deriveResourceCategory("Email connector")).toBe("connector");
    expect(deriveResourceCategory("Slack")).toBe("connector");
    expect(deriveResourceCategory("my-connector")).toBe("connector");
    expect(deriveResourceCategory("tool")).toBe("tool");
    expect(deriveResourceCategory("my-tool-app")).toBe("tool");
  });

  it("deriveResourceTypeLabel maps connector_id to TYPE column verbatim", () => {
    expect(deriveResourceTypeLabel("postgres")).toBe("PostgreSQL");
    expect(deriveResourceTypeLabel("s3")).toBe("Amazon S3");
    expect(deriveResourceTypeLabel("amazon_s3")).toBe("Amazon S3");
    expect(deriveResourceTypeLabel("sftp")).toBe("SFTP");
    expect(deriveResourceTypeLabel("email")).toBe("Email connector");
    expect(deriveResourceTypeLabel("rest")).toBe("REST connector");
    expect(deriveResourceTypeLabel("slack")).toBe("Slack");
    expect(deriveResourceTypeLabel("tool")).toBe("Tool");
  });

  it("healthSentence prefers healthNote free text over enum sentence", () => {
    expect(healthSentence("healthy", null)).toBe("Healthy");
    expect(healthSentence("waiting_review", null)).toBe("A change is waiting for review");
    expect(healthSentence("not_connected", null)).toBe("Not connected");
    expect(healthSentence("expires_soon", "Credential expires in 6 days")).toBe(
      "Credential expires in 6 days",
    );
    expect(healthSentence("superseded", "Superseded by Attendance swipe records")).toBe(
      "Superseded by Attendance swipe records",
    );
    expect(healthSentence(null, null)).toBe("Healthy");
    expect(healthSentence(null, "Custom note")).toBe("Custom note");
  });

  it("migration 0050 adds 9-status + health + category columns with indexes", () => {
    const sql = readFileSync(resolve(here, "../../drizzle/0050_resources_b13.sql"), "utf8");
    expect(sql).toContain("resource_status");
    expect(sql).toContain("'setup'");
    expect(sql).toContain("'archived'");
    expect(sql).toContain("health");
    expect(sql).toContain("resource_category");
    expect(sql).toContain("idx_datasources_resource_status");
    expect(sql).toContain("has_mock_data");
  });
});
