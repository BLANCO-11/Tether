import { describe, expect, it } from "vitest";
import { edgeConnectionLabel, edgeConnectionOf, type EdgeDevice } from "./edge";

const base = (over: Partial<EdgeDevice> = {}): EdgeDevice => ({
  id: "d1",
  workspaceId: "w1",
  name: "Mac",
  ownerSubject: "me",
  status: "active",
  pairingExpiresAt: null,
  lastSeenAt: null,
  createdAt: "2026-11-04T00:00:00Z",
  revokedAt: null,
  ...over,
});

describe("edgeConnectionOf", () => {
  it("prefers the server connection field", () => {
    expect(edgeConnectionOf(base({ connection: "online", lastSeenAt: null }))).toBe("online");
  });

  it("derives offline when active with no recent lastSeen", () => {
    expect(edgeConnectionOf(base({ status: "active", lastSeenAt: null }))).toBe("offline");
  });

  it("labels connection states for the devices list", () => {
    expect(edgeConnectionLabel("online")).toBe("Connected");
    expect(edgeConnectionLabel("offline")).toBe("Offline");
  });
});
