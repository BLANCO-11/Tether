// @vitest-environment jsdom
// src/app/(app)/incidents/break-glass/page.test.tsx — S-58 activate break-glass
//
// Pack: `21-break-glass.png`, `S-58.md`, `flows/11 § Step 2`, `08-validation-and-errors.md`.
// Zones: header (title · purpose, no eyebrow), danger notice above form card,
// form card at measure form with three selects, textarea, checkbox, right-aligned
// danger button. Each assertion has a perturbation that would turn it red.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import BreakGlassPage from "./page";
import { BREAK_GLASS_COPY, BREAK_GLASS_MESSAGES, validateBreakGlass } from "@/lib/break-glass";

afterEach(cleanup);

vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  listIncidents: vi.fn(),
  activeBreakGlass: vi.fn(),
  activateBreakGlass: vi.fn(),
  revokeBreakGlass: vi.fn(),
}));

const SEV2 = {
  id: "INC-2026-08-0004",
  title: "Unusual HRIS access",
  severity: "sev2",
  status: "reported",
  ownerSubject: null,
  openedAt: "2026-08-04T10:00:00.000Z",
  timeline: null,
} as never;
const SEV1 = {
  id: "INC-2026-08-0009",
  title: "Payroll extract exfiltration",
  severity: "sev1",
  status: "investigating",
  ownerSubject: null,
  openedAt: "2026-08-09T10:00:00.000Z",
  timeline: null,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listIncidents).mockResolvedValue([SEV2, SEV1]);
  vi.mocked(api.activeBreakGlass).mockResolvedValue([]);
});

// ---- Pure validation contract (08-validation) -------------------------------

describe("break-glass — validateBreakGlass pure contract (08-validation Break-glass)", () => {
  const validBase = {
    incident: "INC-2026-08-0004",
    scope: "hris-unmasked",
    duration: "2 hours",
    justification: "Investigating an unusual overnight read volume on the HRIS service credential.",
    acknowledged: true,
  };

  it("passes when all five rules satisfied", () => {
    expect(validateBreakGlass(validBase)).toEqual({});
  });

  it("incident empty → incident message", () => {
    expect(validateBreakGlass({ ...validBase, incident: "" }).incident).toBe(BREAK_GLASS_MESSAGES.incident);
  });

  it("scope empty → scope message", () => {
    expect(validateBreakGlass({ ...validBase, scope: "" }).scope).toBe(BREAK_GLASS_MESSAGES.scope);
  });

  it("justification too short → justification message (min 20)", () => {
    expect(validateBreakGlass({ ...validBase, justification: "too short" }).justification).toBe(
      BREAK_GLASS_MESSAGES.justification,
    );
    expect(validateBreakGlass({ ...validBase, justification: "   " }).justification).toBe(
      BREAK_GLASS_MESSAGES.justification,
    );
    expect(validateBreakGlass({ ...validBase, justification: "12345678901234567890" }).justification).toBeUndefined();
  });

  it("acknowledgement false → acknowledgement message", () => {
    expect(validateBreakGlass({ ...validBase, acknowledged: false }).acknowledged).toBe(
      BREAK_GLASS_MESSAGES.acknowledgement,
    );
  });

  it("4 hours with non-SEV1 → duration message; with SEV1 passes", () => {
    // INC-2026-08-0004 is SEV2 → should fail
    expect(
      validateBreakGlass({ ...validBase, incident: "INC-2026-08-0004", duration: "4 hours · SEV1 only" }).duration,
    ).toBe(BREAK_GLASS_MESSAGES.durationSev1);
    // INC-2026-08-0009 is SEV1 → should pass
    expect(
      validateBreakGlass({ ...validBase, incident: "INC-2026-08-0009", duration: "4 hours · SEV1 only" }).duration,
    ).toBeUndefined();
    // Empty incident + 4h still reports duration (so gate never silent)
    expect(validateBreakGlass({ ...validBase, incident: "", duration: "4 hours · SEV1 only" }).duration).toBe(
      BREAK_GLASS_MESSAGES.durationSev1,
    );
  });
});

// ---- Copy and layout (S-58 § Copy, Layout) --------------------------------

describe("break-glass — copy (S-58 § Copy)", () => {
  beforeEach(() => render(<BreakGlassPage />));

  it("header title verbatim, no eyebrow", () => {
    expect(screen.getByRole("heading", { name: BREAK_GLASS_COPY.title })).toBeTruthy();
    // Purpose is the page's one-line purpose
    expect(screen.getByText(BREAK_GLASS_COPY.purpose)).toBeTruthy();
  });

  it("danger notice verbatim (warning copy)", () => {
    expect(screen.getByText(BREAK_GLASS_COPY.noticeTitle)).toBeTruthy();
    expect(screen.getByText(BREAK_GLASS_COPY.noticeBody)).toBeTruthy();
  });

  it("audit trail note and duration gate sentence", () => {
    // The global audit promise + severity-gated label sentence
    expect(screen.getByText(/Every view, query and export in the session is recorded/)).toBeTruthy();
    expect(screen.getAllByText(/4 hours · SEV1 only/).length).toBeGreaterThanOrEqual(1);
  });

  it("button verbatim", () => {
    expect(screen.getByRole("button", { name: BREAK_GLASS_COPY.button })).toBeTruthy();
  });

  it("checkbox copy verbatim", () => {
    expect(screen.getByText(BREAK_GLASS_COPY.checkbox)).toBeTruthy();
  });
});

describe("break-glass — form fields (S-58 § Layout, Fields)", () => {
  beforeEach(() => render(<BreakGlassPage />));

  it("three selects + textarea + checkbox", () => {
    expect(screen.getByLabelText("Incident")).toBeTruthy();
    expect(screen.getByLabelText("Emergency scope")).toBeTruthy();
    expect(screen.getByLabelText("Duration")).toBeTruthy();
    expect(screen.getByLabelText("Justification")).toBeTruthy();
    expect(screen.getByLabelText(BREAK_GLASS_COPY.checkbox)).toBeTruthy();
  });

  it("Incident options list the workspace's open incidents", async () => {
    await waitFor(() => expect(screen.getByLabelText("Incident")).toBeTruthy());
    await waitFor(() => {
      const opts = Array.from(screen.getByLabelText("Incident").querySelectorAll("option")).map((o) => o.textContent);
      expect(opts).toContain("INC-2026-08-0004 — Unusual HRIS access (SEV2)");
      expect(opts).toContain("INC-2026-08-0009 — Payroll extract exfiltration (SEV1)");
    });
  });

  it("Emergency scope options verbatim", () => {
    const opts = Array.from(screen.getByLabelText("Emergency scope").querySelectorAll("option")).map((o) => o.textContent);
    expect(opts).toContain("Read HRIS employee master, unmasked");
    expect(opts).toContain("Read Payroll extract, restricted fields");
  });

  it("Duration options verbatim, default 2 hours, 4h label carries SEV1 only", () => {
    const sel = screen.getByLabelText("Duration") as HTMLSelectElement;
    const opts = Array.from(sel.querySelectorAll("option")).map((o) => o.textContent);
    expect(opts).toEqual(["1 hour", "2 hours", "4 hours · SEV1 only"]);
    expect(sel.value).toBe("2 hours");
  });

  it("Required marks: Incident, Emergency scope, Justification are marked; Duration is not", () => {
    // Stars are rendered as * in accessible hidden spans; the labels contain *
    // We check by finding the label text includes the star span
    const incidentLabel = screen.getByText("Incident").closest("label")!.textContent!;
    expect(incidentLabel).toContain("*");
    const scopeLabel = screen.getByText("Emergency scope").closest("label")!.textContent!;
    expect(scopeLabel).toContain("*");
    const justLabel = screen.getByText("Justification").closest("label")!.textContent!;
    expect(justLabel).toContain("*");
    const durLabel = screen.getByText("Duration").closest("label")!.textContent!;
    expect(durLabel).not.toContain("*");
  });

  it("Justification is NOT pre-filled (S-58 ⚠)", () => {
    const ta = screen.getByLabelText("Justification") as HTMLTextAreaElement;
    expect(ta.value).toBe("");
    expect(ta.placeholder).toBe(BREAK_GLASS_COPY.justificationHint);
    // Hint also renders below field
    expect(screen.getByText(BREAK_GLASS_COPY.justificationHint)).toBeTruthy();
  });

  it("button is right-aligned at card foot (layout)", () => {
    const btn = screen.getByRole("button", { name: BREAK_GLASS_COPY.button });
    const row = btn.closest("div")!;
    expect(row.className).toContain("justify-end");
  });
});

// ---- Validation rendering (08-validation) ---------------------------------

describe("break-glass — validation rendering (08-validation)", () => {
  it("flags all five when submitting empty", async () => {
    render(<BreakGlassPage />);
    await waitFor(() => expect(screen.getByLabelText("Incident").querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: BREAK_GLASS_COPY.button }));
    await waitFor(() => {
      expect(screen.getByText(BREAK_GLASS_MESSAGES.incident)).toBeTruthy();
      expect(screen.getByText(BREAK_GLASS_MESSAGES.scope)).toBeTruthy();
      expect(screen.getByText(BREAK_GLASS_MESSAGES.justification)).toBeTruthy();
      expect(screen.getByText(BREAK_GLASS_MESSAGES.acknowledgement)).toBeTruthy();
    });
  });

  it("4 hours with non-SEV1 shows duration message; SEV1 clears it", async () => {
    render(<BreakGlassPage />);
    await waitFor(() => expect(screen.getByLabelText("Incident").querySelectorAll("option").length).toBeGreaterThan(1));
    // pick non-SEV1 incident + 4h + fill required others
    fireEvent.change(screen.getByLabelText("Emergency scope"), { target: { value: "hris-unmasked" } });
    fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "4 hours · SEV1 only" } });
    fireEvent.change(screen.getByLabelText("Justification"), {
      target: { value: "Investigating an unusual overnight read volume on HRIS." },
    });
    fireEvent.click(screen.getByLabelText(BREAK_GLASS_COPY.checkbox));
    fireEvent.click(screen.getByRole("button", { name: BREAK_GLASS_COPY.button }));
    await waitFor(() => expect(screen.getByText(BREAK_GLASS_MESSAGES.durationSev1)).toBeTruthy());

    // switch to SEV1 incident, message should clear
    fireEvent.change(screen.getByLabelText("Incident"), { target: { value: "INC-2026-08-0009" } });
    fireEvent.click(screen.getByRole("button", { name: BREAK_GLASS_COPY.button }));
    await waitFor(() => expect(screen.queryByText(BREAK_GLASS_MESSAGES.durationSev1)).toBeNull());
  });

  it("justification <20 chars shows message; 20 clears", async () => {
    render(<BreakGlassPage />);
    await waitFor(() => expect(screen.getByLabelText("Incident").querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("Emergency scope"), { target: { value: "hris-unmasked" } });
    fireEvent.change(screen.getByLabelText("Justification"), { target: { value: "short" } });
    fireEvent.click(screen.getByLabelText(BREAK_GLASS_COPY.checkbox));
    fireEvent.click(screen.getByRole("button", { name: BREAK_GLASS_COPY.button }));
    await waitFor(() => expect(document.getElementById("err-justification")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Justification"), { target: { value: "This justification is long enough to pass validation." } });
    fireEvent.click(screen.getByRole("button", { name: BREAK_GLASS_COPY.button }));
    await waitFor(() => expect(document.getElementById("err-justification")).toBeNull());
  });

  it("successful submit activates and names the session", async () => {
    vi.mocked(api.activateBreakGlass).mockResolvedValue({
      id: "sess-1",
      workspaceId: "ws-1",
      incidentId: "INC-2026-08-0009",
      scope: "hris-unmasked",
      durationHours: 4,
      justification: "Investigating an unusual overnight read volume on the HRIS service credential.",
      acknowledged: true,
      activatedBySubject: "oid-x",
      activatedAt: "2026-08-09T10:00:00.000Z",
      expiresAt: "2026-08-09T14:00:00.000Z",
      status: "active",
    } as never);
    render(<BreakGlassPage />);
    await waitFor(() => expect(screen.getByLabelText("Incident").querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("Incident"), { target: { value: "INC-2026-08-0009" } });
    fireEvent.change(screen.getByLabelText("Emergency scope"), { target: { value: "hris-unmasked" } });
    fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "4 hours · SEV1 only" } });
    fireEvent.change(screen.getByLabelText("Justification"), {
      target: { value: "Investigating an unusual overnight read volume on the HRIS service credential." },
    });
    fireEvent.click(screen.getByLabelText(BREAK_GLASS_COPY.checkbox));
    fireEvent.click(screen.getByRole("button", { name: BREAK_GLASS_COPY.button }));
    await waitFor(() => expect(screen.getByText("Break-glass is active")).toBeTruthy());
    expect(screen.getByText(/sess-1/)).toBeTruthy();
    expect(vi.mocked(api.activateBreakGlass)).toHaveBeenCalledWith("ws-1", {
      incidentId: "INC-2026-08-0009",
      scope: "hris-unmasked",
      durationHours: 4,
      justification: "Investigating an unusual overnight read volume on the HRIS service credential.",
      acknowledged: true,
    });
  });
});

// ---- Zone audit: danger notice sits above card, not inside it -------------
describe("break-glass — zone order (S-58 § Layout)", () => {
  it("danger notice is outside the form card", () => {
    render(<BreakGlassPage />);
    const notice = screen.getByText(BREAK_GLASS_COPY.noticeTitle).closest("[role='status']")!;
    const form = screen.getByLabelText("Break-glass activation form");
    expect(notice.contains(form)).toBe(false);
    // form card has border, notice is separate
    expect(form.className).toContain("border");
  });
});
