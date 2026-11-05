// @vitest-environment jsdom
// Sharing boundaries Q1: notices the server keeps for this person (an Admin opened their private work) are shown in
// the bell, count toward its badge, and are marked read when it opens.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const activity = vi.hoisted(() => ({
  live: [],
  notes: [],
  notices: [] as Array<Record<string, unknown>>,
  unread: 0,
  markRead: vi.fn(),
  error: null,
  checkedAt: null,
  epoch: 0,
  refresh: () => {},
}));
vi.mock("@/lib/activity", () => ({ useActivity: () => activity }));

const { NotificationBell } = await import("./NotificationBell");

afterEach(() => {
  cleanup();
  activity.notices = [];
  activity.unread = 0;
  activity.markRead.mockClear();
});

describe("the bell's For you section", () => {
  it("shows a kept notice with its link, and marks it read on opening", () => {
    activity.notices = [
      { id: "n1", kind: "admin_viewed", title: "An Admin opened your chat", body: 'boss@x.example opened "Payroll".', href: "/flows/new?chat=c1", createdAt: "2026-10-30T10:00:00Z", read: false },
    ];
    activity.unread = 1;
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(activity.markRead).toHaveBeenCalled();
    expect(screen.getByText("For you")).toBeTruthy();
    expect(screen.getByRole("link", { name: "An Admin opened your chat" }).getAttribute("href")).toBe("/flows/new?chat=c1");
  });

  it("has no For you section when there is nothing kept for this person", () => {
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(screen.queryByText("For you")).toBeNull();
  });
});
