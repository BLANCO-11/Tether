// @vitest-environment jsdom
//
// The Email box. The assertions worth having are all about ONE distinction:
// `captured` (held, because the run was a draft) must never read as `sent`.
//
// The simulated list (ops-api's shared demo outbox) went with ops-api on 2026-10-30, and its tests with it.
//
// Every control here is proven by perturbation; see the commit message.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EmailBox } from "@/lib/types";

const getEmailBox = vi.fn(async (): Promise<EmailBox> => box());
const clearUndeliveredEmails = vi.fn(async (): Promise<{ ok: true; cleared: number }> => ({ ok: true, cleared: 0 }));
const deleteEmail = vi.fn(async (_id: string): Promise<{ ok: true; cleared: number }> => ({ ok: true, cleared: 1 }));
const toast = vi.fn();
Object.assign(toast, { success: toast, error: toast, warn: toast });

vi.mock("@/lib/api", () => ({
  getEmailBox: () => getEmailBox(),
  clearUndeliveredEmails: () => clearUndeliveredEmails(),
  deleteEmail: (id: string) => deleteEmail(id),
}));

/** Nothing opens by itself: wait for the list, then click its first message. */
const openFirst = async () => {
  const list = await screen.findByRole("list", { name: "Emails" });
  fireEvent.click(within(list).getAllByRole("button")[0]);
  await screen.findByRole("article", { name: "Selected email" });
};

/** The reading pane — the one place a message's outcome is stated in full. */
const reader = () => within(screen.getByRole("article", { name: "Selected email" }));
// ⚠ A shared mock, not `() => vi.fn()`: the failed-clear test asserts the
// error toast fired, which needs the same fn the page called.
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));

const msg = (over: Partial<EmailBox["foundry"][number]> = {}): EmailBox["foundry"][number] => ({
  id: "m-1",
  subject: "Overdue invoices",
  recipients: ["someone@acme.example"],
  cc: [],
  resolvedFrom: "requester",
  outcome: "captured",
  delivered: false,
  failureReason: null,
  body: "<p>the rendered report</p>",
  flowExecutionId: "ex-1",
  stepId: "notify",
  at: "2026-09-07T10:00:00.000Z",
  ...over,
});

const box = (over: Partial<EmailBox> = {}): EmailBox => ({
  workspaceId: "ws-1",
  foundry: [msg()],
  notes: {},
  ...over,
});

let Page: React.ComponentType;
beforeEach(async () => {
  getEmailBox.mockReset();
  getEmailBox.mockResolvedValue(box());
  clearUndeliveredEmails.mockReset();
  clearUndeliveredEmails.mockResolvedValue({ ok: true, cleared: 0 });
  deleteEmail.mockReset();
  deleteEmail.mockResolvedValue({ ok: true, cleared: 1 });
  toast.mockReset();
  Page = (await import("./page")).default;
});
afterEach(cleanup);

describe("a held message never reads as a delivered one", () => {
  it("labels a captured message as held, and says nothing was delivered", async () => {
    render(<Page />);
    await openFirst();
    expect(reader().getByText(/Held \(test run\)/)).toBeTruthy();
    expect(reader().getByText(/NOT delivered/)).toBeTruthy();
    // ⚠ The word that must NOT appear for this message.
    expect(reader().queryByText("Delivered")).toBeNull();
  });

  it("labels a real send as delivered", async () => {
    getEmailBox.mockResolvedValue(
      box({ foundry: [msg({ outcome: "sent", delivered: true, body: null })] }),
    );
    render(<Page />);
    await openFirst();
    expect(reader().getByText("Delivered")).toBeTruthy();
    expect(reader().queryByText(/Held \(test run\)/)).toBeNull();
  });

  it("has no banner, and keeps the 'not delivered' sentence on the held message itself", async () => {
    render(<Page />);
    await openFirst();
    // The page-level banner was removed on request (2026-10-25)...
    expect(screen.queryByText(/A test run never delivers email/)).toBeNull();
    // ...so the one line that stops a held message reading as a delivered one must still be on the message.
    expect(reader().getByText(/NOT delivered/)).toBeTruthy();
  });

  it("gives refused and failed DIFFERENT sentences — the fix is in different places", async () => {
    getEmailBox.mockResolvedValue(
      box({
        foundry: [
          msg({ id: "a", subject: "first", outcome: "refused", delivered: false, body: null }),
          msg({ id: "b", subject: "second", outcome: "failed", delivered: false, body: null }),
        ],
      }),
    );
    render(<Page />);
    await openFirst();
    expect(reader().getByText(/declined before contacting/)).toBeTruthy();
    // Selecting the second opens it in the reading pane.
    fireEvent.click(screen.getByRole("button", { name: /second/ }));
    expect(reader().getByText(/did not accept it/)).toBeTruthy();
  });
});

describe("the body is shown only for a held message", () => {
  it("shows a held message's body in the reading pane", async () => {
    render(<Page />);
    await openFirst();
    await waitFor(() => expect(screen.getByText("the rendered report")).toBeTruthy());
  });

  it("shows NOTHING to read for a delivered message EVEN IF a body arrives", async () => {
    /**
     * ⚠ `body` is planted here on purpose, and the server promises never to
     * send it: `email_sends.captured_body` is written on the draft path alone,
     * so a delivered message's body is always null. Planting it means the
     * assertion is about the CLIENT's rule and does not depend on the server
     * keeping its half (a `body: null` version once passed with the guard
     * deleted — I-38).
     */
    getEmailBox.mockResolvedValue(
      box({ foundry: [msg({ outcome: "sent", delivered: true, body: "<p>should never render</p>" })] }),
    );
    render(<Page />);
    await openFirst();
    expect(screen.queryByText(/should never render/)).toBeNull();
  });
});

describe("filtering and search", () => {
  it("the Held filter shows only held messages, and search narrows by recipient", async () => {
    getEmailBox.mockResolvedValue(
      box({
        foundry: [
          msg({ id: "a", subject: "held one", recipients: ["ann@acme.example"] }),
          msg({ id: "b", subject: "sent one", outcome: "sent", delivered: true, body: null, recipients: ["bob@acme.example"] }),
        ],
      }),
    );
    render(<Page />);
    const list = await waitFor(() => screen.getByRole("list", { name: "Emails" }));
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: /Held/ }));
    expect(within(screen.getByRole("list", { name: "Emails" })).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    fireEvent.change(screen.getByLabelText("Search emails"), { target: { value: "bob" } });
    const narrowed = within(screen.getByRole("list", { name: "Emails" })).getAllByRole("button");
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0].textContent).toContain("sent one");
  });
});

describe("clearing what was never delivered", () => {
  it("Clear covers held, refused and failed, names what stays, and clears only on confirm", async () => {
    getEmailBox.mockReset();
    getEmailBox.mockResolvedValueOnce(
      box({ foundry: [msg({ id: "a" }), msg({ id: "b", outcome: "refused", delivered: false, body: null })] }),
    );
    getEmailBox.mockResolvedValue(box({ foundry: [] }));
    clearUndeliveredEmails.mockResolvedValue({ ok: true, cleared: 2 });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear undelivered" }));
    // ⚠ The confirmation says delivered mail is NOT removed — it is the record of real mail.
    expect(await screen.findByText(/1 held from test runs and 1 refused or failed. Delivered emails stay/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear 2 emails" }));
    expect(clearUndeliveredEmails).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(/No automation in this workspace has sent an email yet/)).toBeTruthy());
  });

  it("a refused email alone is clearable — the button is not only for held ones", async () => {
    getEmailBox.mockResolvedValue(box({ foundry: [msg({ outcome: "refused", delivered: false, body: null })] }));
    render(<Page />);
    expect(await screen.findByRole("button", { name: "Clear undelivered" })).toBeTruthy();
  });

  it("offers no clear, and no Delete, when everything was delivered", async () => {
    getEmailBox.mockResolvedValue(box({ foundry: [msg({ outcome: "sent", delivered: true, body: null })] }));
    render(<Page />);
    await openFirst();
    expect(screen.queryByRole("button", { name: "Clear undelivered" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete this email" })).toBeNull();
  });

  it("the reading pane deletes ONE undelivered email after a confirmation", async () => {
    getEmailBox.mockResolvedValue(box({ foundry: [msg({ id: "m-9", outcome: "failed", delivered: false, body: null })] }));
    render(<Page />);
    await openFirst();
    fireEvent.click(await screen.findByRole("button", { name: "Delete this email" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete email" }));
    expect(deleteEmail).toHaveBeenCalledWith("m-9");
  });
});

describe("a failed read renders as a failed read", () => {
  it("says so, and does not present an empty list as 'no email was sent'", async () => {
    getEmailBox.mockRejectedValue(new Error("boom"));
    render(<Page />);
    await waitFor(() => expect(screen.getByText(/The Email box could not be read/)).toBeTruthy());
    // ⚠ The empty state below still says "no automation has sent an email yet",

    // because `foundry` is empty when the read failed. THIS sentence is what
    // stops that reading as a confirmed absence, so it is the one asserted.
    expect(screen.getByText(/Nothing below is a claim that no email was sent/)).toBeTruthy();
  });
});

describe("attachments", () => {
  const HREF = "/api/foundry/workspaces/ws/email-box/m1/attachments/0";

  it("offers a HELD attachment to view and download, with its size — at any size (2026-10-13)", async () => {
    getEmailBox.mockResolvedValue(
      box({
        foundry: [
          msg({
            attachments: [{ name: "muster_report.csv", bytes: 23_334_142, position: 0, held: true, contentType: "text/csv", href: HREF }],
          }),
        ],
      }),
    );
    render(<Page />);
    await openFirst();
    await waitFor(() => expect(screen.getByText("muster_report.csv")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(HREF);
    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
  });

  it("View opens the file's preview in a dialog, and closing it leaves the email", async () => {
    getEmailBox.mockResolvedValue(
      box({ foundry: [msg({ attachments: [{ name: "a.pdf", bytes: 10, position: 0, held: true, contentType: "application/pdf", href: HREF }] })] }),
    );
    render(<Page />);
    await openFirst();
    await waitFor(() => expect(screen.getByText("a.pdf")).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.querySelector(`iframe[src*="${HREF}"], embed[src*="${HREF}"], object[data*="${HREF}"]`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("article", { name: "Selected email" })).toBeTruthy();
  });

  it("lists a DELIVERED message's attachment without a download, and says why", async () => {
    getEmailBox.mockResolvedValue(
      box({
        foundry: [
          msg({
            outcome: "sent",
            delivered: true,
            body: null,
            attachments: [{ name: "headcount.csv", bytes: 2048, position: 0, held: false, contentType: null, href: null }],
          }),
        ],
      }),
    );
    render(<Page />);
    await openFirst();
    await waitFor(() => expect(screen.getByText("headcount.csv")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    expect(screen.getByText(/not kept for a delivered message/)).toBeTruthy();
  });

  it("a HELD message with no file behind a name says it was not kept — never 'delivered'", async () => {
    getEmailBox.mockResolvedValue(
      box({ foundry: [msg({ attachments: [{ name: "old.xlsx", bytes: 7_592_744, position: 0, held: false, contentType: null, href: null }] })] }),
    );
    render(<Page />);
    await openFirst();
    await waitFor(() => expect(screen.getByText("old.xlsx")).toBeTruthy());
    expect(screen.getByText(/this file was not kept/)).toBeTruthy();
    expect(screen.queryByText(/delivered message/)).toBeNull();
  });

  it("THE CONTROL — a message with no attachments renders no attachment list", async () => {
    render(<Page />);
    await openFirst();
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });
});

describe("the workflow link beside the title", () => {
  it("opens the live workflow in a NEW tab", async () => {
    getEmailBox.mockResolvedValue(box({ foundry: [msg({ flowId: "flow-7", flowName: "Muster report" })] }));
    render(<Page />);
    await openFirst();
    const link = await screen.findByRole("link", { name: /Open workflow: Muster report/ });
    expect(link.getAttribute("href")).toBe("/flows/flow-7");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("a DELETED workflow keeps its name and offers no link — never a 404", async () => {
    getEmailBox.mockResolvedValue(box({ foundry: [msg({ flowId: null, flowName: "Gone report" })] }));
    render(<Page />);
    await openFirst();
    expect(screen.getByLabelText(/Workflow deleted: Gone report/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open workflow/ })).toBeNull();
  });

  it("THE CONTROL — a message with no run behind it shows no workflow icon at all", async () => {
    getEmailBox.mockResolvedValue(box({ foundry: [msg({ flowId: null, flowName: null })] }));
    render(<Page />);
    await openFirst();
    expect(screen.queryByLabelText(/workflow/i)).toBeNull();
  });
});

describe("nothing is open until a person opens it", () => {
  it("starts with a blank reading pane and no row selected", async () => {
    render(<Page />);
    const list = await screen.findByRole("list", { name: "Emails" });
    expect(screen.queryByRole("article", { name: "Selected email" })).toBeNull();
    expect(screen.getByText("Select an email to read it.")).toBeTruthy();
    expect(within(list).getAllByRole("button")[0].getAttribute("aria-current")).toBeNull();
  });

  it("clicking a message opens it, and clicking it again closes it", async () => {
    render(<Page />);
    await openFirst();
    expect(reader().getByText("Overdue invoices")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("list", { name: "Emails" })).getAllByRole("button")[0]);
    expect(screen.queryByRole("article", { name: "Selected email" })).toBeNull();
    expect(screen.getByText("Select an email to read it.")).toBeTruthy();
  });

  it("a message filtered out closes the pane rather than opening another", async () => {
    getEmailBox.mockResolvedValue(
      box({ foundry: [msg({ id: "m-1", subject: "First" }), msg({ id: "m-2", subject: "Second" })] }),
    );
    render(<Page />);
    await openFirst();
    fireEvent.change(screen.getByLabelText("Search emails"), { target: { value: "Second" } });
    expect(screen.queryByRole("article", { name: "Selected email" })).toBeNull();
    expect(screen.getByText("Select an email to read it.")).toBeTruthy();
  });
});
