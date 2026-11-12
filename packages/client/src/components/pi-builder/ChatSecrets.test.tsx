// @vitest-environment jsdom
//
// The secret vault dialog and the pasted-key banner. ⚠ What it pins: the value goes into a password input and only to
// createChatSecret / updateChatSecret; a bearer key is saved with placement { kind: "bearer", name: null }.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/pi-builder", () => ({
  listChatSecrets: vi.fn(),
  createChatSecret: vi.fn(),
  updateChatSecret: vi.fn(),
  deleteChatSecret: vi.fn(),
}));
import { createChatSecret, deleteChatSecret, listChatSecrets, updateChatSecret } from "@/lib/pi-builder";
import { PastedSecretBanner, SecretsDialog } from "./ChatSecrets";

const pending = { id: "s1", name: "twitterapi-key", status: "pending", host: null, extraHosts: [], placement: { kind: "bearer", name: null }, createdAt: "2026-11-01T00:00:00Z", expiresAt: null, lastUsedAt: null };

beforeEach(() => {
  vi.mocked(listChatSecrets).mockResolvedValue({ secrets: [] });
  vi.mocked(createChatSecret).mockResolvedValue({ secret: pending } as never);
  vi.mocked(updateChatSecret).mockResolvedValue({ secret: pending } as never);
  vi.mocked(deleteChatSecret).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the secrets dialog", () => {
  it("takes the value in a password input and creates the secret with exactly the form's values", async () => {
    render(<SecretsDialog workspaceId="w1" chatId="c1" open onClose={() => {}} />);
    const value = screen.getByLabelText("Value") as HTMLInputElement;
    expect(value.type).toBe("password");
    fireEvent.change(screen.getByPlaceholderText("twitterapi-key"), { target: { value: "my-key" } });
    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "api.example.com" } });
    fireEvent.change(screen.getByLabelText("How it's sent"), { target: { value: "header" } });
    fireEvent.change(screen.getByPlaceholderText("X-API-Key"), { target: { value: "X-API-Key" } });
    fireEvent.change(value, { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(createChatSecret).toHaveBeenCalledWith("w1", "c1", { name: "my-key", host: "api.example.com", placement: { kind: "header", name: "X-API-Key" }, value: "s3cret" }),
    );
    expect(updateChatSecret).not.toHaveBeenCalled();
    expect(deleteChatSecret).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe(""));
  });
});

describe("the pasted key banner", () => {
  it("names the pending secret; Save sets website and bearer placement; Discard deletes", async () => {
    vi.mocked(listChatSecrets).mockResolvedValue({ secrets: [pending] } as never);
    render(<PastedSecretBanner workspaceId="w1" chatId="c1" refreshKey={1} />);
    expect(await screen.findByText("twitterapi-key")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "api.twitterapi.io" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateChatSecret).toHaveBeenCalledWith("w1", "c1", "twitterapi-key", { host: "api.twitterapi.io", placement: { kind: "bearer", name: null } }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(deleteChatSecret).toHaveBeenCalledWith("w1", "c1", "twitterapi-key"));
  });
  it("renders nothing without a chat", () => {
    const { container } = render(<PastedSecretBanner workspaceId="w1" chatId={null} refreshKey={0} />);
    expect(container.innerHTML).toBe("");
  });
});
