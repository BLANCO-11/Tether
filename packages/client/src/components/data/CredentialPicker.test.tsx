// @vitest-environment jsdom
//
// CredentialPicker — names only, never values. The assertion that matters is
// the absence: no value is rendered for any option, because none ever arrives
// (`listSecrets` returns presence, and there is no `?reveal=`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ listSecrets: vi.fn() }));
import { listSecrets } from "@/lib/api";
import { CredentialPicker } from "./CredentialPicker";

const mock = vi.mocked(listSecrets);

afterEach(() => {
  cleanup();
  mock.mockReset();
});

const secrets = () => [
  { id: "s1", workspaceId: "w1", name: "HR_DB_DSN", hasValue: true },
  { id: "s2", workspaceId: "w1", name: "PAYROLL_RO", hasValue: false },
];

describe("CredentialPicker", () => {
  it("lists stored names with the current one selected", async () => {
    mock.mockResolvedValue(secrets() as never);
    render(<CredentialPicker value="HR_DB_DSN" onPick={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "HR_DB_DSN" })).toBeTruthy());
    expect(screen.getByRole("option", { name: "PAYROLL_RO" })).toBeTruthy();
    expect((screen.getByLabelText("Credential name") as HTMLSelectElement).value).toBe("HR_DB_DSN");
  });

  it("renders no value anywhere — names are the whole vocabulary", async () => {
    mock.mockResolvedValue(secrets() as never);
    const { container } = render(<CredentialPicker value={null} onPick={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "HR_DB_DSN" })).toBeTruthy());
    expect(container.textContent).not.toContain("postgres://");
    expect(container.textContent).not.toContain("password");
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(screen.getByText(/write-only and never read back/)).toBeTruthy();
  });

  it("picking a name and clearing it both call back with names, never values", async () => {
    mock.mockResolvedValue(secrets() as never);
    const onPick = vi.fn();
    render(<CredentialPicker value={null} onPick={onPick} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "HR_DB_DSN" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Credential name"), { target: { value: "PAYROLL_RO" } });
    expect(onPick).toHaveBeenCalledWith("PAYROLL_RO");
    fireEvent.change(screen.getByLabelText("Credential name"), { target: { value: "" } });
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("an unreadable list says the check did not run — never 'no credential'", async () => {
    mock.mockRejectedValue(new Error("boom"));
    render(<CredentialPicker value={null} onPick={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeTruthy());
    expect(screen.queryByLabelText("Credential name")).toBeNull();
  });
});
