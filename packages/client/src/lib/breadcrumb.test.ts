// src/lib/breadcrumb.test.ts — the crumb trail, which is pure and therefore
// cheap to pin exactly.
import { describe, it, expect } from "vitest";
import { crumbsFor } from "./breadcrumb";

describe("crumbsFor", () => {
  it("names a top-level page with the label the nav uses", () => {
    expect(crumbsFor("/dashboard")).toEqual([{ label: "Dashboard" }]);
    // ⚠ "Workflows", not "Flows" and no longer "My Automations". The URL and the
    // on-screen name still differ
    // deliberately (the route was never renamed), and the crumb follows the
    // NAME — a nav row and a crumb disagreeing is two names for one place.
    expect(crumbsFor("/flows")).toEqual([{ label: "Workflows" }]);
  });

  // The last crumb is where you are. A link to the page you are on is a control
  // that appears to do something and does not.
  it("gives the last crumb no href and every ancestor one", () => {
    const crumbs = crumbsFor("/flows/f-3a91");
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toEqual({ label: "Workflows", href: "/flows" });
    expect(crumbs[1].href).toBeUndefined();
  });

  it("shortens an identifier and marks it as shortened", () => {
    const [, leaf] = crumbsFor("/runs/4f2a91c0-7b3e-4d1a-9c88-2e6f0a1b3d55");
    // Eight characters is enough to tell two runs apart on screen; the ellipsis
    // is what stops somebody copying a truncated id into a query.
    expect(leaf.label).toBe("4f2a91c0…");
  });

  it("leaves a short segment alone", () => {
    expect(crumbsFor("/runs/r-12")[1].label).toBe("r-12");
  });

  // `/flows/new` and `/flows/f-3a91` are the same shape and only one of them is
  // a word somebody typed. Treating `new` as an id would render "new" as a
  // truncated uuid — right by accident, and wrong the moment a word is longer.
  it("treats a static leaf as a word, not an identifier", () => {
    expect(crumbsFor("/flows/new")[1].label).toBe("New");
    // ⚠ `connect` left `STATIC_LEAVES` with the page (I-98, Phase 7.3). `new`
    // is the whole remaining set and the property is unchanged: a word somebody
    // typed is not an id to be truncated.
    expect(crumbsFor("/data-sources/new")).toEqual([
      { label: "Data sources", href: "/data-sources" },
      { label: "New" },
    ]);
  });

  it("titleises a first segment it has no label for", () => {
    expect(crumbsFor("/some-new-page")).toEqual([{ label: "Some new page" }]);
  });

  it("renders nothing at the root", () => {
    expect(crumbsFor("/")).toEqual([]);
    expect(crumbsFor("")).toEqual([]);
  });
});
