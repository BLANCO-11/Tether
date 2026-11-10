// @vitest-environment jsdom
//
// src/app/login/page.params.test.tsx — the sign-in page reads its two query parameters correctly.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `searchParams` is a plain object on Next 14, a Promise on 15, and only a Promise on 16. The page decides two things from it:
// where the person goes after signing in (`callbackUrl`, restricted to in-app addresses by `safeNext`) and whether to say the
// session ended (`expired=1`). Misreading it does not throw — the page renders, the return address is silently `/dashboard`
// and the "your session ended" line never shows, so nothing in the old suite could have noticed.
//
// The parameter object is handed in a form that reads as an object AND as a Promise (`lib/test-dual-params.ts`), and the page
// is called then awaited, so the same test is green whether the page is a sync or an async component.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { dualParams } from "@/lib/test-dual-params";

vi.mock("@/auth", () => ({ signIn: vi.fn() }));
// The form is the one consumer of `next`; render it as its own prop so the test reads what the page passed.
vi.mock("./email-otp-form", () => ({
  EmailOtpForm: ({ next }: { next: string }) => <div data-testid="otp-form" data-next={next} />,
  GoogleButton: () => <button type="submit">Continue with Google</button>,
}));
vi.mock("./local-login-form", () => ({
  LocalLoginForm: ({ next }: { next: string }) => <div data-testid="form" data-next={next} />,
}));

import LoginPage from "./page";

afterEach(() => cleanup());

type Q = { callbackUrl?: string; expired?: string };
async function renderLogin(q: Q | undefined) {
  const element = await Promise.resolve(LoginPage({ searchParams: q === undefined ? undefined : dualParams(q) } as never));
  return render(element as React.ReactElement);
}
const nextOf = (c: HTMLElement) => c.querySelector('[data-testid="form"]')?.getAttribute("data-next");

describe("the sign-in page and its query parameters", () => {
  it("sends the person back to the in-app page they came from", async () => {
    const { container } = await renderLogin({ callbackUrl: "/flows?view=live" });
    expect(nextOf(container)).toBe("/flows?view=live");
  });

  it("ignores an off-site return address", async () => {
    const { container } = await renderLogin({ callbackUrl: "https://evil.example/" });
    expect(nextOf(container)).toBe("/dashboard");
  });

  it("ignores a protocol-relative return address", async () => {
    const { container } = await renderLogin({ callbackUrl: "//evil.example/x" });
    expect(nextOf(container)).toBe("/dashboard");
  });

  it("defaults to the dashboard when there is no return address", async () => {
    const { container } = await renderLogin({});
    expect(nextOf(container)).toBe("/dashboard");
  });

  it("says the session ended when `expired=1`", async () => {
    const { container } = await renderLogin({ expired: "1" });
    expect(container.textContent).toContain("Your session ended");
  });

  it("CONTROL: says nothing about an ended session otherwise", async () => {
    const { container } = await renderLogin({ callbackUrl: "/flows" });
    expect(container.textContent).not.toContain("Your session ended");
  });

  it("renders with no query parameters at all", async () => {
    const { container } = await renderLogin(undefined);
    expect(nextOf(container)).toBe("/dashboard");
    expect(container.textContent).not.toContain("Your session ended");
  });
});
