// @vitest-environment jsdom
//
// /flows/new is an OLD address (2026-10-30): a conversation is a chat now. Links and bookmarks land on /chats.
import { describe, it, expect } from "vitest";
import { newChatTarget } from "@/lib/pi-builder";

describe("/flows/new → /chats", () => {
  it("a new conversation goes to /chats/new, keeping ?q= and ?project=", () => {
    expect(newChatTarget(new URLSearchParams())).toBe("/chats/new");
    expect(newChatTarget(new URLSearchParams("q=hello there&project=p1"))).toBe("/chats/new?q=hello+there&project=p1");
  });

  it("a saved chat goes to its own address", () => {
    expect(newChatTarget(new URLSearchParams("chat=c1"))).toBe("/chats/c1");
  });

  it("an old ?mode= value is dropped rather than carried", () => {
    expect(newChatTarget(new URLSearchParams("mode=chat&q=x"))).toBe("/chats/new?q=x");
  });
});
