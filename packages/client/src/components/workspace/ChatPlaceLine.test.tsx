// @vitest-environment jsdom
//
// Sharing boundaries P6-I4 — the builder says where a chat lives before anything is saved. ⚠ Pinned: My space says
// only you see it; a project names the project; nothing is shown on somebody else's chat (its own notice says whose),
// nor when an older server answered no place.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatPlaceLine } from "./ChatPlaceLine";

afterEach(cleanup);

describe("ChatPlaceLine", () => {
  it("a new chat in My space says only you (and Admins) see it", () => {
    render(<ChatPlaceLine place={{ key: "mine", projectName: null }} othersChat={false} />);
    expect(screen.getByRole("status").textContent).toBe("This chat lives inMy space: only you (and Admins) see it. Move it from Chats.");
  });
  it("a chat in a project names the project", () => {
    render(<ChatPlaceLine place={{ key: "project:p1", projectName: "Payroll close" }} othersChat={false} />);
    expect(screen.getByText("Payroll close")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("its members (and Admins) see it");
  });
  it("says nothing on somebody else's chat, or with no place", () => {
    const { container } = render(
      <>
        <ChatPlaceLine place={{ key: "mine", projectName: null }} othersChat />
        <ChatPlaceLine place={null} othersChat={false} />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});
