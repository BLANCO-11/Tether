// @vitest-environment jsdom
//
// A new conversation is a CHAT (2026-10-30): /chats/new opens Forge straight away, seeded by `?q=`, inside a project by
// `?project=`, and in a chosen mode only by `?mode=workflow|agent`.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let params = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => params }));
vi.mock("@/components/pi-builder/PiBuilderWorkbench", () => ({
  PiBuilderWorkbench: (p: { initialDraft?: string | null; projectId?: string | null; mode?: string | null }) => (
    <div data-testid="pi-workbench">{`${p.initialDraft ?? "(empty)"}|${p.projectId ?? "-"}|${p.mode ?? "default"}`}</div>
  ),
}));

import NewChatPage from "./page";

afterEach(() => {
  cleanup();
  params = new URLSearchParams();
  document.body.classList.remove("wb");
});

describe("/chats/new", () => {
  it("opens Forge straight away, in the person's default mode", () => {
    render(<NewChatPage />);
    expect(screen.getByTestId("pi-workbench").textContent).toBe("(empty)|-|default");
  });

  it("seeds the first message from ?q= and starts in a project from ?project=", () => {
    params = new URLSearchParams("q=chase late invoices&project=p1");
    render(<NewChatPage />);
    expect(screen.getByTestId("pi-workbench").textContent).toBe("chase late invoices|p1|default");
  });

  it("starts in Workflow Builder when asked (the Workflows page's New workflow); an old ?mode= value is ignored", () => {
    params = new URLSearchParams("mode=workflow");
    render(<NewChatPage />);
    expect(screen.getByTestId("pi-workbench").textContent).toBe("(empty)|-|workflow");
    cleanup();
    params = new URLSearchParams("mode=template");
    render(<NewChatPage />);
    expect(screen.getByTestId("pi-workbench").textContent).toBe("(empty)|-|default");
  });
});
