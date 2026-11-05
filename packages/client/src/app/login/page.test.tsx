// @vitest-environment jsdom
/**
 * Local sign-in is shown in every environment, production included (2026-10-04) — the credentials provider always accepts the accounts
 * created under Organization, and keying the form on LOCAL_ADMIN_PASSWORD hid it from all of them wherever the env admin was unset.
 * The page reads its env at import, so each case imports it fresh.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
// ⚠ Loaded HERE, before any case sets NODE_ENV=production. React picks its dev or production JSX runtime when `react/jsx-dev-runtime`
// is first required, and the production one has no `jsxDEV`. This file used to contain JSX, which loaded it at import time as a side
// effect; the page is called as a function now, so nothing else would, and the first case would load the production build.
import "react/jsx-dev-runtime";

vi.mock("@/auth", () => ({ signIn: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

const KEYS = ["LOCAL_ADMIN_PASSWORD", "LOCAL_ADMIN_EMAIL", "LOCAL_LOGIN", "NODE_ENV", "AUTH_MICROSOFT_ENTRA_ID_ID", "AUTH_MICROSOFT_ENTRA_ID_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else (process.env as Record<string, string>)[k] = saved[k]!; } vi.resetModules(); });

async function page(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { default: LoginPage } = await import("./page");
  // The page is an async server component from Next 15 (it awaits `searchParams`), so call it and await the element it returns.
  return render(await LoginPage({}));
}
const password = (c: HTMLElement) => c.querySelector('input[type="password"]');

describe("the login page's local sign-in", () => {
  it("is shown in PRODUCTION with no env admin configured — created accounts can sign in", async () => {
    const { container } = await page({ NODE_ENV: "production" });
    expect(password(container)).not.toBeNull();
    // and the env admin's email is not pre-filled when that account is not configured
    expect((container.querySelector('input[type="text"], input[type="email"]') as HTMLInputElement | null)?.value ?? "").toBe("");
  });
  it("is shown beside the work account when SSO is configured", async () => {
    const { container } = await page({ NODE_ENV: "production", AUTH_MICROSOFT_ENTRA_ID_ID: "x", AUTH_MICROSOFT_ENTRA_ID_SECRET: "y" });
    expect(password(container)).not.toBeNull();
    expect(screen.getByText(/Sign in with your work account/i)).toBeTruthy();
  });
  it("CONTROL: LOCAL_LOGIN=off hides it", async () => {
    const { container } = await page({ NODE_ENV: "production", LOCAL_LOGIN: "off", AUTH_MICROSOFT_ENTRA_ID_ID: "x", AUTH_MICROSOFT_ENTRA_ID_SECRET: "y" });
    expect(password(container)).toBeNull();
  });
});
