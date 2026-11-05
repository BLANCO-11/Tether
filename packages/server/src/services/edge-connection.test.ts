import { describe, expect, it } from "vitest";
import { EDGE_ONLINE_MS, connectionOf } from "./edge-device.service.js";

describe("edge connectionOf", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");

  it("online when lastSeen is within the poll window", () => {
    expect(
      connectionOf({ status: "active", lastSeenAt: new Date(now - EDGE_ONLINE_MS + 1) }, now),
    ).toBe("online");
  });

  it("offline when lastSeen is stale or missing", () => {
    expect(connectionOf({ status: "active", lastSeenAt: new Date(now - EDGE_ONLINE_MS - 1) }, now)).toBe("offline");
    expect(connectionOf({ status: "active", lastSeenAt: null }, now)).toBe("offline");
  });

  it("keeps setup states as themselves", () => {
    expect(connectionOf({ status: "pairing", lastSeenAt: new Date(now) }, now)).toBe("pairing");
    expect(connectionOf({ status: "awaiting_connect", lastSeenAt: null }, now)).toBe("awaiting_connect");
    expect(connectionOf({ status: "revoked", lastSeenAt: new Date(now) }, now)).toBe("revoked");
  });
});
