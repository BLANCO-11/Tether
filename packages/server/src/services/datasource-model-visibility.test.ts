/**
 * Pausing a data source.
 *
 * The risk in this feature is entirely in what it must NOT reach, so the
 * assertions are split the same way: what a pause hides, and — with controls —
 * the three things it deliberately leaves alone. A test that only checked the
 * hiding would pass just as happily over a pause that suspends every armed flow
 * in the workspace.
 */
import { describe, expect, it } from "vitest";
import {
  DATASOURCE_PAUSED_STATUS,
  isPausedFromModel,
  modelVisible,
} from "./datasource-model-visibility.js";
import { RESOURCE_STATUSES } from "../db/schema.js";
import { updateDatasourceSchema } from "./datasource.service.js";

const ds = (name: string, resourceStatus: string | null = null) => ({ id: name, name, resourceStatus });

describe("isPausedFromModel", () => {
  it("one status hides a datasource", () => {
    expect(isPausedFromModel(ds("a", "paused"))).toBe(true);
  });

  it("⚠ ONLY that one — a lifecycle label somebody else is using must not hide anything", () => {
    for (const status of RESOURCE_STATUSES) {
      if (status === DATASOURCE_PAUSED_STATUS) continue;
      expect({ status, hidden: isPausedFromModel(ds("a", status)) }).toEqual({ status, hidden: false });
    }
  });

  it("an unset status is visible — the default is 'the model may see it'", () => {
    expect(isPausedFromModel(ds("a"))).toBe(false);
    expect(isPausedFromModel(ds("a", null))).toBe(false);
    expect(isPausedFromModel(undefined)).toBe(false);
    expect(isPausedFromModel(null)).toBe(false);
  });

  it("CONTROL: the status this module keys on is a real member of the enum", () => {
    expect(RESOURCE_STATUSES as readonly string[]).toContain(DATASOURCE_PAUSED_STATUS);
  });
});

describe("modelVisible", () => {
  it("drops the paused rows and keeps the rest, in order", () => {
    const rows = [ds("a"), ds("b", "paused"), ds("c", "published")];
    expect(modelVisible(rows, (d) => d).map((d) => d.name)).toEqual(["a", "c"]);
  });

  it("reaches the datasource through the accessor — a {query, datasource} pair", () => {
    const rows = [
      { query: { name: "q1" }, datasource: ds("live") },
      { query: { name: "q2" }, datasource: ds("off", "paused") },
    ];
    expect(modelVisible(rows, (r) => r.datasource).map((r) => r.query.name)).toEqual(["q1"]);
  });

  it("CONTROL: with nothing paused it is the identity", () => {
    const rows = [ds("a"), ds("b")];
    expect(modelVisible(rows, (d) => d)).toEqual(rows);
  });
});

/**
 * The wire shape pause and resume actually send.
 *
 * ⚠ Resume is the half that is easy to leave broken: `resourceStatus` was
 * `.optional()` and not nullable, so a paused datasource could be paused and
 * never un-paused — a one-way door behind a button labelled "Pause". The schema
 * is the only thing standing between that and a 400 the client cannot act on.
 */
describe("updateDatasourceSchema carries both halves of the toggle", () => {
  it("pause sends the status", () => {
    expect(updateDatasourceSchema.parse({ resourceStatus: "paused" })).toEqual({
      resourceStatus: "paused",
    });
  });

  it("⚠ resume sends NULL, which clears the column back to the derived state", () => {
    expect(updateDatasourceSchema.parse({ resourceStatus: null })).toEqual({
      resourceStatus: null,
    });
  });

  it("CONTROL: a status outside the enum is still refused", () => {
    expect(() => updateDatasourceSchema.parse({ resourceStatus: "asleep" })).toThrow();
  });

  it("CONTROL: omitting it entirely is still a no-op patch, not a clear", () => {
    expect(updateDatasourceSchema.parse({})).toEqual({});
  });
});
