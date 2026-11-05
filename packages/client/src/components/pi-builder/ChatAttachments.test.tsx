// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { attachRefusal } from "@/lib/pi-builder";
import { AttachmentTray, SentAttachments, useChatAttachments, type PendingAttachment } from "./ChatAttachments";

// The upload itself is XMLHttpRequest; a fake one lets each test drive progress and the answer.
class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  headers: Record<string, string> = {};
  url = "";
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {
    FakeXhr.last = this;
  }
  abort() {
    this.onabort?.();
  }
}

beforeEach(() => {
  FakeXhr.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

const file = (name: string, size = 10, type = "") => new File([new Uint8Array(size)], name, { type });

describe("attachRefusal — the server's limits, checked before upload", () => {
  it("accepts documents, images and text; refuses other kinds, old Office, empty and over 50 MB", () => {
    expect(attachRefusal({ name: "report.pdf", size: 10 })).toBeNull();
    expect(attachRefusal({ name: "shot.PNG", size: 10 })).toBeNull();
    expect(attachRefusal({ name: "run.exe", size: 10 })).toMatch(/can't be attached/);
    expect(attachRefusal({ name: "deck.pptx", size: 10 })).toMatch(/can't be attached/);
    expect(attachRefusal({ name: "clip.mp4", size: 10 })).toMatch(/can't be attached/);
    expect(attachRefusal({ name: "old.doc", size: 10 })).toMatch(/\.docx/);
    expect(attachRefusal({ name: "a.txt", size: 0 })).toMatch(/empty/);
    expect(attachRefusal({ name: "a.txt", size: 50 * 1024 * 1024 + 1 })).toMatch(/50 MB/);
    expect(attachRefusal({ name: "a.pdf", size: 40 * 1024 * 1024 })).toBeNull();
  });
});

describe("useChatAttachments", () => {
  it("uploads with progress, then holds the stored name for the message", async () => {
    const { result } = renderHook(() => useChatAttachments("ws", "sess"));
    act(() => result.current.add([file("spec.pdf", 100, "application/pdf")]));
    const xhr = FakeXhr.last!;
    expect(xhr.url).toBe("/api/foundry/workspaces/ws/pi-builder/sessions/sess/attachments");
    expect(xhr.headers["x-file-name"]).toBe("spec.pdf");
    expect(result.current.uploading).toBe(true);

    act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 40, total: 100 }));
    expect(result.current.pending[0].progress).toBe(0.4);

    xhr.status = 201;
    xhr.responseText = JSON.stringify({ attachment: { name: "spec (2).pdf", size: 100, type: "application/pdf" } });
    await act(async () => {
      xhr.onload?.();
      await Promise.resolve();
    });
    expect(result.current.uploading).toBe(false);
    expect(result.current.ready).toEqual(["spec (2).pdf"]);
  });

  it("refuses a file it cannot send without uploading it, and says why", () => {
    const { result } = renderHook(() => useChatAttachments("ws", "sess"));
    act(() => result.current.add([file("run.exe")]));
    expect(FakeXhr.last).toBeNull();
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.notice).toMatch(/run\.exe can't be attached/);
  });

  it("shows the server's refusal on the file", async () => {
    const { result } = renderHook(() => useChatAttachments("ws", "sess"));
    act(() => result.current.add([file("a.csv")]));
    const xhr = FakeXhr.last!;
    xhr.status = 413;
    xhr.responseText = JSON.stringify({ error: "request_error", message: "The file is larger than 50 MB." });
    await act(async () => {
      xhr.onload?.();
      await Promise.resolve();
    });
    expect(result.current.pending[0]).toMatchObject({ state: "failed", error: "The file is larger than 50 MB." });
    expect(result.current.ready).toEqual([]);
  });

  it("removing a file mid-upload stops it", () => {
    const { result } = renderHook(() => useChatAttachments("ws", "sess"));
    act(() => result.current.add([file("a.csv")]));
    const abort = vi.spyOn(FakeXhr.last!, "abort");
    act(() => result.current.remove(result.current.pending[0].key));
    expect(abort).toHaveBeenCalled();
    expect(result.current.pending).toHaveLength(0);
  });
});

describe("AttachmentTray and SentAttachments", () => {
  const up: PendingAttachment = { key: "1", name: "big.pdf", size: 5_000_000, type: "application/pdf", progress: 0.62, state: "uploading" };
  it("shows each file's progress and lets it be removed", () => {
    const onRemove = vi.fn();
    render(<AttachmentTray pending={[up]} notice={null} onRemove={onRemove} onDismissNotice={() => {}} />);
    expect(screen.getByText("Uploading… 62%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("62");
    fireEvent.click(screen.getByRole("button", { name: "Cancel uploading big.pdf" }));
    expect(onRemove).toHaveBeenCalledWith("1");
  });

  it("renders nothing with no files and no notice", () => {
    const { container } = render(<AttachmentTray pending={[]} notice={null} onRemove={() => {}} onDismissNotice={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("a sent message lists its files with their sizes", () => {
    render(<SentAttachments files={[{ name: "q3.xlsx", size: 2048, type: "x" }]} />);
    expect(screen.getByText("q3.xlsx")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
  });
});

describe("FileCards", () => {
  it("each file Forge made downloads from the chat", async () => {
    const { FileCards } = await import("./ChatAttachments");
    render(<FileCards files={[{ name: "Rates (updated).xlsx", size: 2048, type: "x" }]} hrefOf={(n) => `/dl/${encodeURIComponent(n)}`} />);
    const link = screen.getByLabelText("Download Rates (updated).xlsx");
    expect(link.getAttribute("href")).toBe("/dl/Rates%20(updated).xlsx");
    expect(link.getAttribute("download")).toBe("Rates (updated).xlsx");
  });
});
