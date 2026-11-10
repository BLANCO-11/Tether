// @vitest-environment jsdom
// The digit-box code step: paste fills six boxes and submits, backspace steps back, a wrong code clears and refocuses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const signIn = vi.fn();
vi.mock("next-auth/react", () => ({ signIn: (...a: unknown[]) => signIn(...a) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ requestLoginCode: vi.fn(async () => ({ ok: true })) }));

import { EmailOtpForm } from "./email-otp-form";

beforeEach(() => signIn.mockReset());
afterEach(() => cleanup());

async function toCodeStep() {
  render(<EmailOtpForm />);
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByRole("button", { name: /email me a code/i }));
  await screen.findByLabelText("Digit 1 of 6", {}, { timeout: 2000 });
  return Array.from({ length: 6 }, (_, i) => screen.getByLabelText(`Digit ${i + 1} of 6`) as HTMLInputElement);
}

describe("code boxes", () => {
  it("first box asks for a one-time code, numeric keypad", async () => {
    const boxes = await toCodeStep();
    expect(boxes[0].getAttribute("autocomplete")).toBe("one-time-code");
    expect(boxes[0].getAttribute("inputmode")).toBe("numeric");
  });

  it("pasting six digits fills every box and submits that code", async () => {
    signIn.mockResolvedValue({ ok: true });
    const boxes = await toCodeStep();
    fireEvent.paste(boxes[0], { clipboardData: { getData: () => "123456" } });
    expect(boxes.map((b) => b.value).join("")).toBe("123456");
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("email-otp", { email: "a@b.co", code: "123456", redirect: false }));
  });

  it("typing advances and backspace on an empty box moves back", async () => {
    const boxes = await toCodeStep();
    fireEvent.change(boxes[0], { target: { value: "1" } });
    expect(document.activeElement).toBe(boxes[1]);
    fireEvent.keyDown(boxes[1], { key: "Backspace" });
    expect(document.activeElement).toBe(boxes[0]);
    expect(boxes[0].value).toBe("");
  });

  it("a wrong code shows the error, clears the boxes and refocuses the first", async () => {
    signIn.mockResolvedValue({ error: "CredentialsSignin", ok: false });
    const boxes = await toCodeStep();
    fireEvent.paste(boxes[0], { clipboardData: { getData: () => "000000" } });
    await screen.findByText(/That code didn't work/);
    await waitFor(() => expect(boxes.every((b) => b.value === "")).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(boxes[0]));
  });
});
