// @vitest-environment jsdom
//
// src/components/layout/PageHeader.test.tsx — the inline rename affordance.
//
// `onRenameTitle` is additive and opt-in (see the docblock on PageHeader): a
// page that does not pass it must render byte-identical to before. These
// tests pin that, then the actual rename path — pencil opens the field,
// Enter commits, Escape cancels, and a rejection renders under the title
// rather than silently reverting.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

afterEach(cleanup);

describe("PageHeader without onRenameTitle", () => {
  it("renders no pencil and no editable field", () => {
    render(<PageHeader title="A workflow" purpose="Does a thing." />);
    expect(screen.getByText("A workflow")).toBeTruthy();
    expect(screen.queryByLabelText("Rename")).toBeNull();
    expect(screen.queryByLabelText("Workflow name")).toBeNull();
  });
});

describe("PageHeader with onRenameTitle", () => {
  it("shows a pencil beside the title", () => {
    render(<PageHeader title="A workflow" purpose="Does a thing." onRenameTitle={vi.fn()} />);
    expect(screen.getByLabelText("Rename")).toBeTruthy();
  });

  it("opens an inline field pre-filled with the current title on click", () => {
    render(<PageHeader title="A workflow" purpose="Does a thing." onRenameTitle={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Rename"));
    const input = screen.getByLabelText("Workflow name") as HTMLInputElement;
    expect(input.value).toBe("A workflow");
    // The static <h1> is gone while editing — one title, not two.
    expect(screen.queryByText("A workflow")).toBeNull();
  });

  it("commits the new name on Enter and calls back with the trimmed value", async () => {
    const onRenameTitle = vi.fn().mockResolvedValue(undefined);
    render(<PageHeader title="A workflow" purpose="Does a thing." onRenameTitle={onRenameTitle} />);
    fireEvent.click(screen.getByLabelText("Rename"));
    const input = screen.getByLabelText("Workflow name");
    fireEvent.change(input, { target: { value: "  Renamed flow  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(onRenameTitle).toHaveBeenCalledWith("Renamed flow"));
    await vi.waitFor(() => expect(screen.queryByLabelText("Workflow name")).toBeNull());
  });

  it("also commits when the Save (check) button is clicked", async () => {
    const onRenameTitle = vi.fn().mockResolvedValue(undefined);
    render(<PageHeader title="A workflow" purpose="Does a thing." onRenameTitle={onRenameTitle} />);
    fireEvent.click(screen.getByLabelText("Rename"));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByLabelText("Save name"));
    await vi.waitFor(() => expect(onRenameTitle).toHaveBeenCalledWith("New name"));
  });

  it("cancels on Escape without calling back, and restores the original title", () => {
    const onRenameTitle = vi.fn();
    render(<PageHeader title="A workflow" purpose="Does a thing." onRenameTitle={onRenameTitle} />);
    fireEvent.click(screen.getByLabelText("Rename"));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Something else" } });
    fireEvent.keyDown(screen.getByLabelText("Workflow name"), { key: "Escape" });
    expect(onRenameTitle).not.toHaveBeenCalled();
    expect(screen.getByText("A workflow")).toBeTruthy();
  });

  it("cancels on the Cancel (close) button without calling back", () => {
    const onRenameTitle = vi.fn();
    render(<PageHeader title="A workflow" purpose="Does a thing." onRenameTitle={onRenameTitle} />);
    fireEvent.click(screen.getByLabelText("Rename"));
    fireEvent.click(screen.getByLabelText("Cancel rename"));
    expect(onRenameTitle).not.toHaveBeenCalled();
    expect(screen.getByText("A workflow")).toBeTruthy();
  });

  it("does nothing when committed with an unchanged or blank name", () => {
    const onRenameTitle = vi.fn();
    render(<PageHeader title="A workflow" purpose="Does a thing." onRenameTitle={onRenameTitle} />);
    fireEvent.click(screen.getByLabelText("Rename"));
    fireEvent.keyDown(screen.getByLabelText("Workflow name"), { key: "Enter" });
    expect(onRenameTitle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Rename"));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByLabelText("Workflow name"), { key: "Enter" });
    expect(onRenameTitle).not.toHaveBeenCalled();
  });

  it("shows the rejection under the title and keeps the field open to retry", async () => {
    const onRenameTitle = vi.fn().mockRejectedValue(new Error("that name is taken"));
    render(<PageHeader title="A workflow" purpose="Does a thing." onRenameTitle={onRenameTitle} />);
    fireEvent.click(screen.getByLabelText("Rename"));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Taken name" } });
    fireEvent.keyDown(screen.getByLabelText("Workflow name"), { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not rename: that name is taken");
    // Still editable — a failed rename must not silently revert the field.
    expect(screen.getByLabelText("Workflow name")).toBeTruthy();
  });
});
