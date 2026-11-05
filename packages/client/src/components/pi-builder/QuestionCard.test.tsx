// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AnsweredCard, QuestionCard, matchesSearch, multiFromAnswer, pickRows } from "./QuestionCard";
import { legacyAnswers } from "./PiBuilderWorkbench";

const questions = [
  { id: "q1", prompt: "Which month should it cover?", choices: ["Ask when it runs", "Last month"] },
  { id: "q2", prompt: "What does average mean?" },
];

describe("the question card", () => {
  afterEach(cleanup);
  it("asks one question at a time, takes a choice or typed text, and sends them together after review", () => {
    const onSubmit = vi.fn();
    render(<QuestionCard questions={questions} busy={false} onSubmit={onSubmit} />);
    expect(screen.getByText("Which month should it cover?")).toBeTruthy();
    expect(screen.queryByText("What does average mean?")).toBeNull();

    fireEvent.click(screen.getByText("Ask when it runs"));
    const box = screen.getByRole("textbox", { name: "What does average mean?" });
    fireEvent.change(box, { target: { value: "Mean of recorded days" } });
    fireEvent.submit(box.closest("form")!);

    expect(screen.getByText("Ready to send these?")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Send answers"));
    expect(onSubmit).toHaveBeenCalledWith({ q1: "Ask when it runs", q2: "Mean of recorded days" });
  });

  it("chooses with a number key", () => {
    render(<QuestionCard questions={[questions[0]!]} busy={false} onSubmit={() => {}} />);
    fireEvent.keyDown(screen.getByTestId("question-card"), { key: "2" });
    expect(screen.getByText("Ready to send these?")).toBeTruthy();
    expect(screen.getByText("Last month")).toBeTruthy();
  });

  it("once sent, shows the question and answer with no controls", () => {
    render(<AnsweredCard answers={[{ id: "q1", prompt: "Which month?", answer: "Last month" }]} />);
    expect(screen.getByText("Which month?")).toBeTruthy();
    expect(screen.getByText("Last month")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads an answer turn saved before answers were recorded", () => {
    expect(legacyAnswers('Answers are in answers.json: {"q1":"input","q2":"Average"}. Clear questions.json and continue building.')).toEqual([
      { id: "q1", prompt: "Question 1", answer: "input" },
      { id: "q2", prompt: "Question 2", answer: "Average" },
    ]);
    expect(legacyAnswers("build me a report")).toBeNull();
  });
});

describe("a file question", () => {
  afterEach(cleanup);
  const files = async () => [{ name: "Final India Holiday Calendar 2026.xlsx" }, { name: "HC_Report_Sep.xlsx" }];

  it("lists Forge's suggestions first, then the chat's files, then the workspace's Files, each once", () => {
    expect(pickRows(["HC_Report_Sep.xlsx"], ["muster.xlsx"], ["b.pdf", "HC_Report_Sep.xlsx", "a.pdf"])).toEqual([
      { name: "HC_Report_Sep.xlsx", where: "workspace", suggested: true },
      { name: "muster.xlsx", where: "chat", suggested: false },
      { name: "a.pdf", where: "workspace", suggested: false },
      { name: "b.pdf", where: "workspace", suggested: false },
    ]);
  });

  it("searches by every word, in any order, across separators", () => {
    expect(matchesSearch("HC_Report_Sep.xlsx", "report hc")).toBe(true);
    expect(matchesSearch("HC_Report_Sep.xlsx", "holiday")).toBe(false);
    expect(matchesSearch("anything", "  ")).toBe(true);
  });

  it("takes one file with a click, from the chat and the workspace's Files, after a search", async () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard
        questions={[{ id: "f", prompt: "Which is the holiday calendar?", pick: "file" }]}
        busy={false}
        onSubmit={onSubmit}
        chatFiles={["Temporary Muster.xlsx"]}
        loadWorkspaceFiles={files}
      />,
    );
    await screen.findByText("HC_Report_Sep.xlsx");
    expect(screen.getByText("Temporary Muster.xlsx")).toBeTruthy();
    expect(screen.getByText("In this chat")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), { target: { value: "holiday" } });
    expect(screen.queryByText("HC_Report_Sep.xlsx")).toBeNull();
    fireEvent.click(screen.getByText("Final India Holiday Calendar 2026.xlsx"));
    fireEvent.click(screen.getByText("Send answers"));
    expect(onSubmit).toHaveBeenCalledWith({ f: "Final India Holiday Calendar 2026.xlsx" });
  });

  it("takes several files, one name per line", async () => {
    const onSubmit = vi.fn();
    render(<QuestionCard questions={[{ id: "f", prompt: "Which files?", pick: "files" }]} busy={false} onSubmit={onSubmit} loadWorkspaceFiles={files} />);
    fireEvent.click(await screen.findByText("HC_Report_Sep.xlsx"));
    fireEvent.click(screen.getByText("Final India Holiday Calendar 2026.xlsx"));
    fireEvent.click(screen.getByText("Use 2 files"));
    fireEvent.click(screen.getByText("Send answers"));
    expect(onSubmit).toHaveBeenCalledWith({ f: "HC_Report_Sep.xlsx\nFinal India Holiday Calendar 2026.xlsx" });
  });

  it("says when the workspace's Files could not be read, and still offers the chat's files", async () => {
    render(
      <QuestionCard
        questions={[{ id: "f", prompt: "Which file?", pick: "file" }]}
        busy={false}
        onSubmit={() => {}}
        chatFiles={["a.csv"]}
        loadWorkspaceFiles={() => Promise.reject(new Error("offline"))}
      />,
    );
    await waitFor(() => expect(screen.getByText(/could not be read \(offline\)/)).toBeTruthy());
    expect(screen.getByText("a.csv")).toBeTruthy();
  });

  it("does not read the workspace's Files for an ordinary question", () => {
    const load = vi.fn(files);
    render(<QuestionCard questions={questions} busy={false} onSubmit={() => {}} loadWorkspaceFiles={load} />);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("questions with a kind (2026-10-13)", () => {
  afterEach(cleanup);
  const blank = {
    id: "blank_columns:build_report:rows",
    prompt: "The test found these 3 columns blank in every row. Tick the ones that can genuinely be blank.",
    kind: "multi" as const,
    choices: ["Remarks", "Absent", "First/Second Half"],
  };

  it("multi: ticked columns are sent one per line, in the question's order", () => {
    const onSubmit = vi.fn();
    render(<QuestionCard questions={[blank]} busy={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText("Absent"));
    fireEvent.click(screen.getByText("Remarks"));
    fireEvent.click(screen.getByText("Use 2 ticked"));
    fireEvent.click(screen.getByText("Send answers"));
    expect(onSubmit).toHaveBeenCalledWith({ [blank.id]: "Remarks\nAbsent" });
  });

  it("multi: 'Tick all' and nothing ticked are each one click", () => {
    const onSubmit = vi.fn();
    const { unmount } = render(<QuestionCard questions={[blank]} busy={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText("Tick all"));
    fireEvent.click(screen.getByText("Use 3 ticked"));
    fireEvent.click(screen.getByText("Send answers"));
    expect(onSubmit).toHaveBeenLastCalledWith({ [blank.id]: "Remarks\nAbsent\nFirst/Second Half" });
    unmount();
    render(<QuestionCard questions={[blank]} busy={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "None of these" }));
    fireEvent.click(screen.getByText("Send answers"));
    expect(onSubmit).toHaveBeenLastCalledWith({ [blank.id]: "None of these" });
    expect(multiFromAnswer("None of these")).toEqual([]);
  });

  it("multi: a long list is shortened, and still offers every option", () => {
    const many = { ...blank, choices: Array.from({ length: 14 }, (_, i) => `col_${i}`) };
    render(<QuestionCard questions={[many]} busy={false} onSubmit={() => {}} />);
    expect(screen.queryByText("col_12")).toBeNull();
    fireEvent.click(screen.getByText("+4 more"));
    expect(screen.getByText("col_12")).toBeTruthy();
  });

  it("number: refuses a value outside its bounds before sending", () => {
    const onSubmit = vi.fn();
    render(<QuestionCard questions={[{ id: "n", prompt: "Present from how many hours?", kind: "number", min: 0, max: 24, unit: "hours" }]} busy={false} onSubmit={onSubmit} />);
    const box = screen.getByLabelText("Present from how many hours?");
    fireEvent.change(box, { target: { value: "30" } });
    expect(screen.getByText("At most 24.")).toBeTruthy();
    fireEvent.change(box, { target: { value: "9.5" } });
    fireEvent.submit(box.closest("form")!);
    fireEvent.click(screen.getByText("Send answers"));
    expect(onSubmit).toHaveBeenCalledWith({ n: "9.5" });
  });

  it("CONTROL: a question without a kind is the card it always was", () => {
    render(<QuestionCard questions={[questions[0]!]} busy={false} onSubmit={() => {}} />);
    expect(screen.getByText("Something else…")).toBeTruthy();
    expect(screen.queryByText("Tick all")).toBeNull();
  });
});
