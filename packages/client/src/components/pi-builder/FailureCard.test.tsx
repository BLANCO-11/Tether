// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ getFlowExecution: vi.fn() }));
import { FailureCard } from "./PiBuilderWorkbench";

afterEach(cleanup);

describe("a failed turn is a card, not a raw error", () => {
  it("says what went wrong in words, offers Try again, and keeps the raw error behind Show details", () => {
    const onRetry = vi.fn();
    render(<FailureCard error={{ title: "The AI service cut the request off", said: "Trying again normally works.", retryable: true, detail: "403 terminated" }} onRetry={onRetry} />);
    expect(screen.getByText("The AI service cut the request off")).toBeTruthy();
    expect(screen.getByText("Show details")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("⚠ no Try again when it cannot help (a sign-in problem needs an administrator)", () => {
    render(<FailureCard error={{ title: "Foundry could not sign in to the AI service", said: "An administrator needs to check.", retryable: false }} onRetry={() => {}} />);
    expect(screen.queryByText("Try again")).toBeNull();
  });
  it("control: an older turn's card offers no button — only the latest can be tried again", () => {
    render(<FailureCard error={{ title: "x", said: "y", retryable: true }} />);
    expect(screen.queryByText("Try again")).toBeNull();
  });
});
