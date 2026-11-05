import { describe, expect, it } from "vitest";
import { redactChatMessages, redactLooseText } from "./item-share.service.js";
import { REDACTED } from "@foundry/redact";
import { contentVisibility } from "./content-visibility.service.js";

describe("redactLooseText", () => {
  it("redacts bearer tokens and api_key assignments", () => {
    expect(redactLooseText("Authorization: Bearer abc.def.ghi")).toContain(REDACTED);
    expect(redactLooseText("api_key=super-secret-value")).toContain(REDACTED);
    expect(redactLooseText("sk-abcdefghijklmnopqrst")).toBe(REDACTED);
  });

  it("leaves ordinary prose alone", () => {
    expect(redactLooseText("Always use UTC for due dates")).toBe("Always use UTC for due dates");
  });
});

describe("redactChatMessages", () => {
  it("redacts secret-looking text on messages", () => {
    const out = redactChatMessages([{ text: "use api_key=hunter2 please" }, { text: "hello" }]);
    expect(out[0]!.text).toContain(REDACTED);
    expect(out[1]!.text).toBe("hello");
  });
});

describe("chatVisible with per-person share", () => {
  const base = { createdBySubject: "alice", visibility: "private", projectId: null as string | null };
  it("lets a sharee read a private chat by id", () => {
    const bob = {
      subject: "bob",
      all: false,
      reviewer: false,
      sharedChats: new Set(["chat-1"]),
    };
    expect(contentVisibility.chatVisible(bob, { ...base, id: "chat-1" })).toBe(true);
    expect(contentVisibility.chatVisible(bob, { ...base, id: "chat-2" })).toBe(false);
    expect(contentVisibility.chatChangeable(bob, base)).toBe(false);
  });
});
