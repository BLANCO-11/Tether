"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MULTI_NONE, type PiAnswered, type PiQuestion } from "@/lib/pi-builder";
import { listWorkspaceFiles } from "@/lib/workspace-files";

/**
 * Forge's questions, asked the way a terminal assistant asks them (2026-10-10): one at a time, the choices as a
 * numbered list you click or press a number for, "Something else" to type your own, then a review before sending.
 * Before this the questions were a stack of chips and textareas, and the answer reached the chat as raw JSON.
 *
 * ⚠ Answers are submitted together, once — the agent continues from all of them in one turn.
 */
export function QuestionCard({
  questions,
  busy,
  onSubmit,
  chatFiles = [],
  loadWorkspaceFiles = listWorkspaceFiles,
}: {
  questions: PiQuestion[];
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  /** The files in this chat, for a file question (`pick`). */
  chatFiles?: string[];
  /** The workspace's Files, read only when a question asks for a file. Injectable for tests. */
  loadWorkspaceFiles?: () => Promise<Array<{ name: string }>>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [at, setAt] = useState(0); // index of the question shown; === questions.length is the review
  const [hi, setHi] = useState(0); // highlighted option
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const reviewing = at >= questions.length;
  const q = reviewing ? null : questions[at]!;
  // A question with its own card (a file pick, ticks, a number or a date) handles its own keys and focus.
  const ownCard = !!q && (!!q.pick || OWN_KINDS.has(q.kind ?? ""));
  const choices = q?.choices ?? [];
  const otherIndex = choices.length; // the "Something else" row

  // Each question opens on its current answer, typed answers back in the box.
  useEffect(() => {
    if (!q) return;
    const prior = answers[q.id];
    const i = prior == null ? 0 : choices.indexOf(prior);
    setHi(i >= 0 ? i : otherIndex);
    const typed = prior != null && i < 0;
    setTyping(typed || choices.length === 0);
    setText(typed ? prior! : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  useEffect(() => {
    if (ownCard) return; // a file, ticks, number or date question focuses its own control
    if (typing) input.current?.focus();
    else root.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing, at]);

  const choose = (value: string) => {
    if (!q || !value.trim()) return;
    const next = { ...answers, [q.id]: value.trim() };
    setAnswers(next);
    // On to the next question nobody has answered, or the review.
    const after = questions.findIndex((x, i) => i > at && next[x.id] == null);
    setAt(after >= 0 ? after : questions.length);
  };

  const pick = (i: number) => {
    if (i < choices.length) choose(choices[i]!);
    else {
      setHi(otherIndex);
      setTyping(true);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (busy || reviewing || typing || ownCard) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, otherIndex));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hi);
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) - 1 <= otherIndex) {
      e.preventDefault();
      pick(Number(e.key) - 1);
    }
  };

  const allAnswered = questions.every((x) => answers[x.id] != null);

  // A file question lists the workspace's Files too: read once, when the card has one. Unread is said, not "none".
  const wantsFiles = questions.some((x) => x.pick);
  const [wsFiles, setWsFiles] = useState<{ names?: string[]; error?: string } | null>(null);
  useEffect(() => {
    if (!wantsFiles) return;
    let live = true;
    loadWorkspaceFiles()
      .then((fs) => live && setWsFiles({ names: fs.map((f) => f.name) }))
      .catch((e: Error) => live && setWsFiles({ error: e.message }));
    return () => {
      live = false;
    };
  }, [wantsFiles, loadWorkspaceFiles]);

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKey}
      data-testid="question-card"
      className="rounded-xl border border-accent/30 bg-surface p-4 text-sm shadow-sm outline-none animate-[chatIn_180ms_ease]"
    >
      {/* One tab per question, then the review — answered ones carry a tick and can be revisited. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
        {questions.map((x, i) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setAt(i)}
            disabled={busy}
            className={`rounded-full px-2 py-0.5 transition-colors ${
              i === at ? "bg-accent/15 text-accent" : "text-muted hover:text-text"
            }`}
          >
            {answers[x.id] != null ? "✓ " : ""}
            Question {i + 1}
          </button>
        ))}
        <button
          type="button"
          onClick={() => allAnswered && setAt(questions.length)}
          disabled={busy || !allAnswered}
          className={`rounded-full px-2 py-0.5 transition-colors disabled:opacity-40 ${reviewing ? "bg-accent/15 text-accent" : "text-muted hover:text-text"}`}
        >
          Review
        </button>
      </div>

      {q?.pick ? (
        <FilePick
          key={q.id}
          question={q}
          prior={answers[q.id]}
          busy={busy}
          chatFiles={chatFiles}
          workspace={wsFiles}
          onChoose={choose}
        />
      ) : q?.kind === "multi" ? (
        <MultiPick key={q.id} question={q} prior={answers[q.id]} busy={busy} onChoose={choose} />
      ) : q && VALUE_KINDS.has(q.kind ?? "") ? (
        <ValueAnswer key={q.id} question={q} prior={answers[q.id]} busy={busy} onChoose={choose} />
      ) : q ? (
        <>
          <p className="mb-3 font-medium leading-snug text-text">{q.prompt}</p>
          <ul role="listbox" aria-label={q.prompt} className="space-y-1">
            {choices.map((c, i) => (
              <li key={c} role="option" aria-selected={hi === i}>
                <button
                  type="button"
                  disabled={busy}
                  onMouseEnter={() => !typing && setHi(i)}
                  onClick={() => pick(i)}
                  className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                    hi === i && !typing ? "bg-accent/10 text-text" : "text-muted hover:text-text"
                  }`}
                >
                  <span className="w-4 shrink-0 font-mono text-xs text-dim">{i + 1}</span>
                  <span className="min-w-0 flex-1">{c}</span>
                  {answers[q.id] === c ? <span className="text-accent">✓</span> : null}
                </button>
              </li>
            ))}
            <li role="option" aria-selected={hi === otherIndex}>
              {typing ? (
                <form
                  className="flex items-center gap-2 rounded-lg bg-accent/5 px-3 py-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    choose(text);
                  }}
                >
                  {choices.length ? <span className="w-4 shrink-0 font-mono text-xs text-dim">{otherIndex + 1}</span> : null}
                  <input
                    ref={input}
                    value={text}
                    disabled={busy}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && choices.length) {
                        e.preventDefault();
                        setTyping(false);
                      }
                    }}
                    aria-label={choices.length ? "Something else" : q.prompt}
                    placeholder={choices.length ? "Type your own answer…" : "Type your answer…"}
                    className="min-w-0 flex-1 bg-transparent py-1 text-sm text-text placeholder:text-dim focus:outline-none"
                  />
                  <button type="submit" disabled={busy || !text.trim()} className="rounded-md px-2 py-1 text-xs font-medium text-accent disabled:opacity-40">
                    Next ↵
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onMouseEnter={() => setHi(otherIndex)}
                  onClick={() => pick(otherIndex)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                    hi === otherIndex ? "bg-accent/10 text-text" : "text-muted hover:text-text"
                  }`}
                >
                  <span className="w-4 shrink-0 font-mono text-xs text-dim">{otherIndex + 1}</span>
                  <span className="italic">Something else…</span>
                </button>
              )}
            </li>
          </ul>
          {choices.length ? (
            <p className="mt-3 text-[11px] text-dim">↑↓ to move · Enter or a number to choose · Esc to go back to the options</p>
          ) : null}
        </>
      ) : (
        <>
          <p className="mb-3 font-medium text-text">Ready to send these?</p>
          <Answered items={questions.map((x) => ({ id: x.id, prompt: x.prompt, answer: answers[x.id] ?? "" }))} />
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={busy || !allAnswered}
              onClick={() => onSubmit(answers)}
              className="btn-primary h-8 rounded-md px-4 text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send answers"}
            </button>
            <span className="text-[11px] text-dim">Click a question above to change it.</span>
          </div>
        </>
      )}
    </div>
  );
}

/** Settled answers — the question muted, the answer plain. Used in the review and once the card is sent. */
export function Answered({ items }: { items: Array<Pick<PiAnswered, "id" | "prompt" | "answer">> }) {
  return (
    <dl className="space-y-2.5">
      {items.map((a) => (
        <div key={a.id}>
          <dt className="text-xs leading-snug text-muted">{a.prompt}</dt>
          <dd className="mt-0.5 flex gap-2 text-[13px] text-text">
            <span aria-hidden className="text-accent">
              ✓
            </span>
            <span className="min-w-0 whitespace-pre-line">{a.answer}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A sent answer in the conversation: the card, done — no controls, just what was asked and what was chosen. */
export function AnsweredCard({ answers, by }: { answers: PiAnswered[]; by?: string | null }) {
  return (
    <div className="ml-auto max-w-[88%] rounded-xl border border-line bg-surface-2/60 px-4 py-3 animate-[chatIn_180ms_ease]">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-dim">{by ? `Answered by ${by}` : "Answers"}</p>
      <Answered items={answers} />
    </div>
  );
}

type PickRow = { name: string; where: "chat" | "workspace" | null; suggested: boolean };

/** The rows a file question offers: Forge's suggestions first, then the chat's files, then the workspace's Files. */
export function pickRows(suggested: string[], chat: string[], workspace: string[]): PickRow[] {
  const where = (n: string): PickRow["where"] => (chat.includes(n) ? "chat" : workspace.includes(n) ? "workspace" : null);
  const seen = new Set<string>();
  const rows: PickRow[] = [];
  for (const n of suggested) if (!seen.has(n)) seen.add(n), rows.push({ name: n, where: where(n), suggested: true });
  for (const n of chat) if (!seen.has(n)) seen.add(n), rows.push({ name: n, where: "chat", suggested: false });
  for (const n of [...workspace].sort((a, b) => a.localeCompare(b))) if (!seen.has(n)) seen.add(n), rows.push({ name: n, where: "workspace", suggested: false });
  return rows;
}

/** Every word of the search appears in the name, in any order, ignoring case and separators. */
export function matchesSearch(name: string, search: string): boolean {
  const hay = name.toLowerCase().replace(/[_\-.]+/g, " ");
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * Which file is meant (2026-10-13): a search box over this chat's files and the workspace's Files, Forge's guesses
 * first. One file is chosen with a click; several are ticked and sent together, one name per line. A name that is not
 * listed can still be typed.
 */
function FilePick({
  question,
  prior,
  busy,
  chatFiles,
  workspace,
  onChoose,
}: {
  question: PiQuestion;
  prior?: string;
  busy: boolean;
  chatFiles: string[];
  workspace: { names?: string[]; error?: string } | null;
  onChoose: (value: string) => void;
}) {
  const many = question.pick === "files";
  const [search, setSearch] = useState("");
  const [hi, setHi] = useState(0);
  const [ticked, setTicked] = useState<string[]>(() => (many && prior ? prior.split("\n").filter(Boolean) : []));
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);

  const rows = useMemo(() => pickRows(question.choices ?? [], chatFiles, workspace?.names ?? []), [question.choices, chatFiles, workspace]);
  const shown = rows.filter((r) => matchesSearch(r.name, search));
  const typed = search.trim();
  const exact = rows.some((r) => r.name.toLowerCase() === typed.toLowerCase());

  const act = (name: string) => {
    if (busy) return;
    if (!many) return onChoose(name);
    setTicked((t) => (t.includes(name) ? t.filter((x) => x !== name) : [...t, name]));
  };

  return (
    <div>
      <p className="mb-3 font-medium leading-snug text-text">{question.prompt}</p>
      <input
        ref={box}
        value={search}
        disabled={busy}
        onChange={(e) => {
          setSearch(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, Math.max(shown.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const row = shown[hi];
            if (row) act(row.name);
            else if (typed && !many) onChoose(typed);
          }
        }}
        placeholder="Search files…"
        aria-label="Search files"
        className="mb-2 w-full rounded-lg border border-line bg-surface-2/50 px-3 py-1.5 text-sm text-text placeholder:text-dim focus:border-accent/50 focus:outline-none"
      />
      <ul role="listbox" aria-label={question.prompt} aria-multiselectable={many || undefined} className="max-h-64 space-y-0.5 overflow-y-auto">
        {shown.map((r, i) => {
          const on = many ? ticked.includes(r.name) : prior === r.name;
          return (
            <li key={r.name} role="option" aria-selected={on}>
              <button
                type="button"
                disabled={busy}
                onMouseEnter={() => setHi(i)}
                onClick={() => act(r.name)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left transition-colors ${
                  hi === i ? "bg-accent/10 text-text" : "text-muted hover:text-text"
                }`}
              >
                {many ? (
                  <span aria-hidden className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[10px] ${on ? "border-accent bg-accent text-on-accent" : "border-line"}`}>
                    {on ? "✓" : ""}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate" title={r.name}>
                  {r.name}
                </span>
                {r.suggested ? <span className="shrink-0 text-[10.5px] text-accent">Suggested</span> : null}
                {r.where ? (
                  <span className="shrink-0 text-[10.5px] text-dim">{r.where === "chat" ? "In this chat" : "In Files"}</span>
                ) : null}
                {!many && on ? <span className="text-accent">✓</span> : null}
              </button>
            </li>
          );
        })}
        {!shown.length ? (
          <li className="px-3 py-2 text-[12.5px] text-dim">{rows.length ? "No file matches that search." : "There are no files in this chat or in Files yet."}</li>
        ) : null}
      </ul>
      {workspace === null ? <p className="mt-2 text-[11px] text-dim">Reading the workspace&apos;s Files…</p> : null}
      {workspace?.error ? <p className="mt-2 text-[11px] text-danger">The workspace&apos;s Files could not be read ({workspace.error}). Only this chat&apos;s files are listed.</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {many ? (
          <button
            type="button"
            disabled={busy || !ticked.length}
            onClick={() => onChoose(ticked.join("\n"))}
            className="btn-primary h-8 rounded-md px-3 text-[12.5px] font-medium disabled:opacity-50"
          >
            {ticked.length ? `Use ${ticked.length} file${ticked.length === 1 ? "" : "s"}` : "Tick the files to use"}
          </button>
        ) : null}
        {typed && !exact && !many ? (
          <button type="button" disabled={busy} onClick={() => onChoose(typed)} className="text-[12px] text-accent hover:underline">
            Answer “{typed}” instead
          </button>
        ) : null}
        <span className="text-[11px] text-dim">↑↓ to move · Enter to {many ? "tick" : "choose"}</span>
      </div>
    </div>
  );
}

const VALUE_KINDS = new Set(["number", "date", "period"]);
const OWN_KINDS = new Set(["multi", ...VALUE_KINDS]);

/** The options a `multi` answer names (one per line); `MULTI_NONE` is none. */
export function multiFromAnswer(answer: string | undefined): string[] {
  const lines = (answer ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length === 1 && lines[0] === MULTI_NONE ? [] : lines;
}

/**
 * Tick any of the options (2026-10-13). "All" and "None" are one click each, because the common answers to "which of
 * these can be blank" are all or none; ticking is for the rest. A long list is shortened, and the answer still covers
 * every option — what is hidden is the list, never the choice.
 */
function MultiPick({
  question,
  prior,
  busy,
  onChoose,
}: {
  question: PiQuestion;
  prior?: string;
  busy: boolean;
  onChoose: (value: string) => void;
}) {
  const options = question.choices ?? [];
  const [ticked, setTicked] = useState<string[]>(() => multiFromAnswer(prior).filter((o) => options.includes(o)));
  const [open, setOpen] = useState(false);
  const SHOWN = 10;
  const shown = open ? options : options.slice(0, SHOWN);
  const toggle = (o: string) => setTicked((t) => (t.includes(o) ? t.filter((x) => x !== o) : [...t, o]));
  const send = (list: string[]) => onChoose(list.length ? options.filter((o) => list.includes(o)).join("\n") : MULTI_NONE);

  return (
    <div>
      <p className="mb-3 font-medium leading-snug text-text">{question.prompt}</p>
      <div className="mb-2 flex items-center gap-3 text-[12px]">
        <button type="button" disabled={busy} onClick={() => setTicked(options)} className="text-accent hover:underline disabled:opacity-40">
          Tick all
        </button>
        <button type="button" disabled={busy} onClick={() => setTicked([])} className="text-accent hover:underline disabled:opacity-40">
          Clear
        </button>
        <span className="text-dim">
          {ticked.length} of {options.length} ticked
        </span>
      </div>
      <ul role="listbox" aria-label={question.prompt} aria-multiselectable className="max-h-64 space-y-0.5 overflow-y-auto">
        {shown.map((o) => {
          const on = ticked.includes(o);
          return (
            <li key={o} role="option" aria-selected={on}>
              <button
                type="button"
                disabled={busy}
                onClick={() => toggle(o)}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-muted transition-colors hover:bg-accent/10 hover:text-text"
              >
                <span aria-hidden className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[10px] ${on ? "border-accent bg-accent text-on-accent" : "border-line"}`}>
                  {on ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate" title={o}>
                  {o}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {options.length > SHOWN ? (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 px-3 text-[12px] text-accent hover:underline">
          {open ? "Show fewer" : `+${options.length - SHOWN} more`}
        </button>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={() => send(ticked)} className="btn-primary h-8 rounded-md px-3 text-[12.5px] font-medium disabled:opacity-50">
          {ticked.length ? `Use ${ticked.length} ticked` : "None of these"}
        </button>
      </div>
    </div>
  );
}

/** A number, a date or a month — the browser's own input for each, checked again by the server. */
function ValueAnswer({
  question,
  prior,
  busy,
  onChoose,
}: {
  question: PiQuestion;
  prior?: string;
  busy: boolean;
  onChoose: (value: string) => void;
}) {
  const [value, setValue] = useState(prior ?? "");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);
  const kind = question.kind;
  const n = Number(value);
  const problem =
    !value.trim()
      ? null
      : kind === "number"
        ? !Number.isFinite(n)
          ? "Enter a number."
          : question.min != null && n < question.min
            ? `At least ${question.min}.`
            : question.max != null && n > question.max
              ? `At most ${question.max}.`
              : null
        : kind === "date"
          ? /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : "Enter a date."
          : /^\d{4}-\d{2}$/.test(value) ? null : "Enter a month.";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() && !problem) onChoose(value.trim());
      }}
    >
      <p className="mb-3 font-medium leading-snug text-text">{question.prompt}</p>
      <div className="flex items-center gap-2">
        <input
          ref={box}
          type={kind === "number" ? "number" : kind === "date" ? "date" : "month"}
          step={kind === "number" ? "any" : undefined}
          min={kind === "number" ? question.min : undefined}
          max={kind === "number" ? question.max : undefined}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          aria-label={question.prompt}
          placeholder={kind === "period" ? "YYYY-MM" : undefined}
          className="w-48 rounded-lg border border-line bg-surface-2/50 px-3 py-1.5 text-sm text-text focus:border-accent/50 focus:outline-none"
        />
        {kind === "number" && question.unit ? <span className="text-[12.5px] text-muted">{question.unit}</span> : null}
        <button type="submit" disabled={busy || !value.trim() || !!problem} className="rounded-md px-2 py-1 text-xs font-medium text-accent disabled:opacity-40">
          Next ↵
        </button>
      </div>
      {problem ? <p className="mt-2 text-[11px] text-danger">{problem}</p> : null}
    </form>
  );
}
