import { describe, expect, it } from "vitest";
import { isPendingAskSurface, parseSurface, surfaceSchema } from "./surface-card.js";

describe("surfaceSchema / parseSurface", () => {
  it("accepts an info list", () => {
    const s = parseSurface({
      mode: "info",
      type: "list",
      title: "Connected devices",
      items: [
        { id: "d1", title: "This computer", subtitle: "online", tone: "ok", meta: "seen just now" },
        { id: "d2", title: "Hands-free host", tone: "muted", meta: "offline" },
      ],
    });
    expect(s.mode).toBe("info");
    expect(s.items).toHaveLength(2);
  });

  it("accepts an ask choice", () => {
    const s = parseSurface({
      mode: "ask",
      type: "choice",
      title: "Which device?",
      items: [{ id: "d1", title: "This computer" }],
    });
    expect(s.type).toBe("choice");
  });

  it("rejects list in ask mode", () => {
    expect(() =>
      surfaceSchema.parse({
        mode: "ask",
        type: "list",
        title: "x",
        items: [{ id: "a", title: "A" }],
      }),
    ).toThrow(/cannot ask/i);
  });

  it("rejects unknown type", () => {
    expect(() =>
      surfaceSchema.parse({
        mode: "info",
        type: "chart",
        title: "x",
        items: [{ id: "a", title: "A" }],
      }),
    ).toThrow();
  });

  it("rejects unsafe action ids", () => {
    expect(() =>
      surfaceSchema.parse({
        mode: "info",
        type: "list",
        title: "x",
        items: [{ id: "a", title: "A" }],
        actions: [{ id: "Run;rm", label: "Nope" }],
      }),
    ).toThrow();
  });

  it("accepts agent-defined actions with payload", () => {
    const s = parseSurface({
      mode: "info",
      type: "list",
      title: "Devices",
      items: [{ id: "d1", title: "This computer" }],
      actions: [
        {
          id: "use_this_computer",
          label: "Use this one",
          itemId: "d1",
          payload: { deviceId: "5b3b875d-3b6d-45da-83f7-08069646d842", name: "This computer" },
        },
      ],
    });
    expect(s.actions?.[0]?.payload?.deviceId).toBe("5b3b875d-3b6d-45da-83f7-08069646d842");
  });

  it("rejects nested action payload", () => {
    expect(() =>
      surfaceSchema.parse({
        mode: "info",
        type: "list",
        title: "x",
        items: [{ id: "a", title: "A" }],
        actions: [{ id: "go", label: "Go", payload: { nested: { x: 1 } } }],
      }),
    ).toThrow();
  });

  it("rejects action itemId not in items", () => {
    expect(() =>
      surfaceSchema.parse({
        mode: "info",
        type: "list",
        title: "x",
        items: [{ id: "a", title: "A" }],
        actions: [{ id: "use", label: "Use", itemId: "missing" }],
      }),
    ).toThrow(/unknown item/i);
  });
});

describe("isPendingAskSurface", () => {
  it("detects open ask cards only", () => {
    expect(isPendingAskSurface({ kind: "surface", status: "pending", surface: { mode: "ask" } })).toBe(true);
    expect(isPendingAskSurface({ kind: "surface", status: "pending", surface: { mode: "info" } })).toBe(false);
    expect(isPendingAskSurface({ kind: "surface", status: "done", surface: { mode: "ask" } })).toBe(false);
    expect(isPendingAskSurface({ kind: "edge", status: "pending" })).toBe(false);
  });
});
