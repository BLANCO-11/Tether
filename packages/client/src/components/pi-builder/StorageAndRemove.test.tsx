// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { errorText, storageLevel } from "@/lib/pi-builder";
import { FileCards, SentAttachments } from "./ChatAttachments";
import { PiSidePane } from "./PiSidePane";

vi.mock("@/lib/api", () => ({ flowReadSources: vi.fn(async () => []) }));
const { StorageNotice, OthersChatNotice } = await import("./PiBuilderWorkbench");
const MB = 1024 * 1024;

afterEach(cleanup);

describe("how full a conversation is", () => {
  it("is fine below 80%, near from 80%, full past the limit", () => {
    expect(storageLevel({ bytes: 100 * MB, limit: 300 * MB, chat: 0 })).toBe("ok");
    expect(storageLevel({ bytes: 240 * MB, limit: 300 * MB, chat: 0 })).toBe("near");
    expect(storageLevel({ bytes: 301 * MB, limit: 300 * MB, chat: 0 })).toBe("full");
    expect(storageLevel(null)).toBe("ok");
  });

  it("says nothing below 80%, warns near the limit, and says why messages stop when full", () => {
    const open = vi.fn();
    const { rerender, container } = render(<StorageNotice storage={{ bytes: 10 * MB, limit: 300 * MB, chat: 5 * MB }} onOpenFiles={open} />);
    expect(container.textContent).toBe("");
    rerender(<StorageNotice storage={{ bytes: 250 * MB, limit: 300 * MB, chat: 200 * MB }} onOpenFiles={open} />);
    expect(screen.getByRole("status").textContent).toContain("250 MB of its 300 MB");
    rerender(<StorageNotice storage={{ bytes: 320 * MB, limit: 300 * MB, chat: 200 * MB }} onOpenFiles={open} />);
    expect(screen.getByRole("alert").textContent).toContain("Forge can't take another message");
    fireEvent.click(screen.getByText("Open Files"));
    expect(open).toHaveBeenCalled();
  });

  it("points at a new chat when the person's files are not what fills it", () => {
    render(<StorageNotice storage={{ bytes: 320 * MB, limit: 300 * MB, chat: 2 * MB }} onOpenFiles={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("a new chat starts fresh");
    expect(screen.queryByText("Open Files")).toBeNull();
  });

  it("reads a server refusal as its sentence", () => {
    expect(errorText(new Error('413 {"error":"request_error","message":"This conversation is full."}'))).toBe("This conversation is full.");
    expect(errorText(new Error("plain words"))).toBe("plain words");
  });
});

describe("a removed file", () => {
  it("keeps its name in the conversation, with nothing to download", () => {
    const f = { name: "old.xlsx", size: 10, type: "x", removed: true };
    render(
      <>
        <SentAttachments files={[f]} hrefOf={() => "/x"} />
        <FileCards files={[{ ...f, name: "made.pdf" }]} hrefOf={() => "/y"} onOpen={() => {}} />
      </>,
    );
    expect(screen.getAllByText("removed")).toHaveLength(2);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("is removed from the Files pane after a second click", async () => {
    const onRemove = vi.fn(async () => {});
    render(
      <PiSidePane
        view={{ kind: "files" }}
        onView={() => {}}
        workflow={{ steps: [] }}
        files={{}}
        baseFiles={null}
        live={false}
        lastRun={null}
        chatFiles={[{ name: "big.csv", size: 5 * MB, type: "text/csv", from: "you" }]}
        chatFileHref={() => "/f"}
        onRemoveChatFile={onRemove}
        storage={{ bytes: 6 * MB, limit: 300 * MB, chat: 5 * MB }}
      />,
    );
    expect(screen.getByText("6 MB of 300 MB used by this chat")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove big.csv" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm removing big.csv" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("big.csv"));
  });

  it("shows no remove button while Forge is working", () => {
    render(
      <PiSidePane
        view={{ kind: "files" }}
        onView={() => {}}
        workflow={{ steps: [] }}
        files={{}}
        baseFiles={null}
        live
        lastRun={null}
        chatFiles={[{ name: "big.csv", size: 5, type: "text/csv", from: "you" }]}
      />,
    );
    expect(screen.getByRole("button", { name: /big\.csv/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove big.csv" })).toBeNull();
  });
});

describe("a message's time", () => {
  it("is a 12-hour clock time, and nothing when unreadable", async () => {
    const { clockTime } = await import("./PiBuilderWorkbench");
    const at = new Date(2026, 9, 13, 15, 42).toISOString();
    expect(clockTime(at)).toMatch(/^3:42\s?PM$/i);
    expect(clockTime(new Date(2026, 9, 13, 9, 5).toISOString())).toMatch(/^9:05\s?AM$/i);
    expect(clockTime("not a date")).toBe("");
    expect(clockTime(undefined)).toBe("");
  });
});

describe("OthersChatNotice (rbac-observability)", () => {
  afterEach(cleanup);
  it("says whose chat an Admin is reading, and that opening it was recorded", () => {
    render(<OthersChatNotice othersChat={{ ownerName: "Ravi" }} />);
    expect(screen.getByRole("status").textContent).toMatch(/This is Ravi's chat\..*recorded in the audit history/);
  });
  it("draws nothing for the person's own chat", () => {
    const { container } = render(<OthersChatNotice othersChat={null} />);
    expect(container.textContent).toBe("");
  });
});
