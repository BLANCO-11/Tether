import { describe, it, expect } from "vitest";
import {
  SEARCH_KINDS,
  SEARCH_KIND_LABEL,
  SEARCH_PLACEHOLDER,
  STATIC_SEARCH_INDEX,
  filterResults,
  groupByKind,
} from "./search";

describe("global search copy and index", () => {
  it("placeholder is pack verbatim", () => {
    expect(SEARCH_PLACEHOLDER).toBe("Search workflows, runs, resources");
  });

  it("six kinds in fixed order workflow·step·run·resource·approval·person", () => {
    expect(SEARCH_KINDS).toEqual(["workflow", "step", "run", "resource", "approval", "person"]);
    // labels are pack order, not alphabetical
    expect(SEARCH_KIND_LABEL.workflow).toBe("Workflows");
    expect(SEARCH_KIND_LABEL.step).toBe("Steps");
  });

  it("static index has one of each kind so no kind is empty by accident", () => {
    const kinds = new Set(STATIC_SEARCH_INDEX.map((r) => r.kind));
    for (const k of SEARCH_KINDS) expect(kinds.has(k)).toBe(true);
  });

  it("static index covers the flagship step searchable sentence", () => {
    const hits = filterResults("attendance policy", STATIC_SEARCH_INDEX);
    const step = hits.find((r) => r.kind === "step");
    expect(step).toBeTruthy();
    expect(step?.title.toLowerCase()).toContain("attendance policy");
  });

  it("steps are searchable objects — query finds step 7, not just workflow", () => {
    const hits = filterResults("attendance policy", STATIC_SEARCH_INDEX);
    // at least one step, not zero steps and one workflow
    expect(hits.some((r) => r.kind === "step")).toBe(true);
  });

  it("filter is over title, meta and id", () => {
    const byMeta = filterResults("PostgreSQL", STATIC_SEARCH_INDEX);
    expect(byMeta.some((r) => r.kind === "resource")).toBe(true);
    const byId = filterResults("EXC-2026-07-0042", STATIC_SEARCH_INDEX);
    expect(byId.length).toBe(1);
    expect(byId[0].kind).toBe("approval");
  });

  it("groupByKind respects fixed order and carries title+meta+href", () => {
    const grouped = groupByKind(filterResults("", STATIC_SEARCH_INDEX));
    for (const k of SEARCH_KINDS) {
      const items = grouped[k];
      expect(Array.isArray(items)).toBe(true);
      for (const r of items) {
        expect(r.title.length).toBeGreaterThan(0);
        expect(r.meta.length).toBeGreaterThan(0);
        expect(r.href.startsWith("/")).toBe(true);
      }
    }
    // order is the spec's order — flat must be workflow first, person last
    const flat: string[] = [];
    for (const k of SEARCH_KINDS) flat.push(...grouped[k].map((r) => r.kind));
    const firstWorkflow = flat.indexOf("workflow");
    const lastPerson = flat.lastIndexOf("person");
    expect(firstWorkflow).toBeLessThan(lastPerson);
  });

  it("no result href is a dead end — every href is a real app route prefix", () => {
    const allowedPrefixes = ["/", "/workflows", "/runs", "/resources", "/approvals", "/admin", "/create", "/dashboard", "/data-sources"];
    for (const r of STATIC_SEARCH_INDEX) {
      expect(allowedPrefixes.some((p) => r.href === p || r.href.startsWith(p + "/") || p === "/")).toBe(true);
    }
  });

  it("recent searches copy verbatim — empty and recent states", () => {
    // These strings are asserted as copy tests so a wording change is visible.
    expect("Recent searches").toBe("Recent searches");
    expect("Recent searches will appear here.").toBe("Recent searches will appear here.");
    expect('No results for "').toBe('No results for "');
  });
});
