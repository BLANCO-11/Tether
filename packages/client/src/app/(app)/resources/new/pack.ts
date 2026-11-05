// packages/client/src/app/(app)/resources/new/pack.ts — S-49/S-50/S-51 pack truth.
// Extracted from page.tsx verbatim for Next page export validation (S-54 pattern).
// Page must have only `default export`; tests import from "./pack" not "./page".

// ── Step strip — seven pills, each `<n> <label>`, step 6 trailing `*`, all show from start ──
export const STEPS = [
  "1 Choose type",
  "2 Connect",
  "3 Test connection",
  "4 Infer schema",
  "5 Review mapping",
  "6 Create safe data *",
  "7 Submit for review",
] as const;

export const STEP_KEYS = ["type", "connect", "test", "schema", "mapping", "safe-data", "review"] as const;
export type StepKey = (typeof STEP_KEYS)[number];

// ── Connect-field table — source of truth for tile counts (S-49 warns counts must be DERIVED) ──
export const FIELD_TABLE = {
  postgres: [
    "Connection name",
    "Host",
    "Port",
    "Database",
    "Credential",
    "SSL mode",
    "Read-only",
  ],
  s3: ["Connection name", "Bucket", "Prefix", "Region", "Credential", "Read-only"],
  sftp: ["Connection name", "Host", "Port", "Remote path", "Credential", "Host key fingerprint"],
  rest: ["Connection name", "Base URL", "Authentication", "Credential", "Timeout seconds"],
  email: ["Connection name", "Mailbox", "Folder", "Credential", "Allow sending as this mailbox"],
  slack: ["Connection name", "Workspace", "Default channel", "Credential"],
} as const satisfies Record<string, readonly string[]>;

export type ResourceTypeId = keyof typeof FIELD_TABLE;

export type TileMeta = {
  id: ResourceTypeId;
  label: string;
  category: "Datasource" | "Connector";
};

export const TYPE_META: readonly TileMeta[] = [
  { id: "postgres", label: "PostgreSQL", category: "Datasource" },
  { id: "s3", label: "Amazon S3", category: "Datasource" },
  { id: "sftp", label: "SFTP", category: "Datasource" },
  { id: "rest", label: "REST connector", category: "Connector" },
  { id: "email", label: "Email connector", category: "Connector" },
  { id: "slack", label: "Slack", category: "Connector" },
] as const;

// Derived: each tile's settings count is the field-table length — picker and forms cannot drift.
export type Tile = TileMeta & { settings: number };
export const TILES: readonly Tile[] = TYPE_META.map((m) => ({
  ...m,
  settings: FIELD_TABLE[m.id].length,
}));

// ── S-50 — confidence threshold + inferred fields (flows/08 § Step 4) ──
export const CONFIDENCE_THRESHOLD = 90 as const;

export type InferredField = { source: string; type: string; target: string | null; confidence: number | null };

export const INFERRED_FIELDS: Record<ResourceTypeId, readonly InferredField[]> = {
  postgres: [
    { source: "employee_no", type: "text", target: "employee_id", confidence: 99 },
    { source: "leave_dt", type: "date", target: "leave_date", confidence: 97 },
    { source: "leave_code", type: "text", target: "leave_type", confidence: 82 },
    { source: "approved_flag", type: "boolean", target: "approval_status", confidence: 76 },
    { source: "manager_note", type: "text", target: null, confidence: null },
  ],
  s3: [
    { source: "badge_id", type: "text", target: "employee_id", confidence: 98 },
    { source: "swipe_ts", type: "timestamp", target: "swiped_at", confidence: 96 },
    { source: "direction", type: "text", target: "swipe_direction", confidence: 91 },
    { source: "reader_loc", type: "text", target: "office_location", confidence: 74 },
    { source: "raw_payload", type: "binary", target: null, confidence: null },
  ],
  sftp: [
    { source: "emp_code", type: "text", target: "employee_id", confidence: 97 },
    { source: "cost_centre", type: "text", target: "cost_centre", confidence: 95 },
    { source: "fte", type: "number", target: "fte", confidence: 88 },
    { source: "grade_band", type: "text", target: "grade", confidence: 71 },
    { source: "file_footer", type: "text", target: null, confidence: null },
  ],
  rest: [
    { source: "id", type: "text", target: "employee_id", confidence: 99 },
    { source: "workEmail", type: "text", target: "email", confidence: 98 },
    { source: "manager.id", type: "text", target: "manager_id", confidence: 93 },
    { source: "employmentStatus", type: "text", target: "status", confidence: 79 },
    { source: "customFields", type: "object", target: null, confidence: null },
  ],
  email: [
    { source: "message_id", type: "text", target: "message_id", confidence: 99 },
    { source: "from", type: "text", target: "sender", confidence: 97 },
    { source: "received_at", type: "timestamp", target: "received_at", confidence: 96 },
    { source: "subject", type: "text", target: "subject", confidence: 84 },
    { source: "attachments[]", type: "binary", target: null, confidence: null },
  ],
  slack: [
    { source: "channel", type: "text", target: "channel", confidence: 99 },
    { source: "user", type: "text", target: "employee_id", confidence: 85 },
    { source: "ts", type: "timestamp", target: "posted_at", confidence: 96 },
    { source: "thread_ts", type: "timestamp", target: "thread_id", confidence: 72 },
    { source: "blocks", type: "object", target: null, confidence: null },
  ],
} as const;
