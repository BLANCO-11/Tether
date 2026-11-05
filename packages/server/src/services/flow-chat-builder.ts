/**
 * A chat turn (compiled-builder phase 8, extended by phase X). Chat is the builder's conversation, and since phase X it also
 * answers questions and makes edits — each where it belongs:
 *
 *   1. a reply to the builder's pending question → `builderAnswer` (never routed: it answers the question);
 *   2. a reply to an EDIT's pending question → `resumeEdit` (only when it answers it; otherwise it is a new message);
 *   3. anything else is ROUTED (`chat-route.ts`, one compact call, D-334): `build` → `builderStart`; `change` → one canvas action
 *      (`chat-edit.service.ts`, D-336/D-337); `about_flow` / `capabilities` / `chat` → an answer written by code (D-335).
 *
 * I-309 is why step 3 exists: the phase-8 cutover sent every message to `builderStart`, so "What can you build?" was built as a
 * goal and ended in "what do you mean?".
 *
 * Builder status mapping (every value is an existing chat turn status, so the panel needs no new branch for any of them):
 *   asks        → `needs_input`            — the builder's question, its options as chips, free text allowed
 *   complete    → `applied`                — revision written; readback lines filed as the change lines
 *   incomplete  → `incomplete`             — built, and the goal still not entirely met; the working copy is kept, open rows named
 *   cannot      → `insufficient_catalogue` — the workspace cannot do what was asked; nothing written
 *   unchanged   → `answered`               — the request changes nothing in this automation
 *
 * `incomplete` and `cannot` are TWO statuses (2026-10-01): "built, and here is what it does not yet do" and "this workspace cannot
 * do it" ask different things of the person, and one status filed a saved, nearly-right draft under the refusal's words. Both are
 * refusals of the unmet part, never failures (D-38).
 */
import type { BuilderTurn } from "./builder/conversation.js";
import type { FlowChatThread, FlowChatTurn } from "../repositories/flow-chat.repo.js";
import { flowChatRepo } from "../repositories/flow-chat.repo.js";
import { flowService } from "./flow.service.js";
import { flowApprovalService } from "./flow-approval.service.js";
import type { RevisionAuthor } from "./revision-author.js";
import type { Chooser } from "./builder/build.js";
import type { EditReply } from "./builder/chat-edit.service.js";

/** The chat status a builder outcome is filed under. */
export const BUILDER_STATUS: Record<BuilderTurn["status"], string> = {
  asks: "needs_input",
  complete: "applied",
  incomplete: "incomplete",
  cannot: "insufficient_catalogue",
  unchanged: "answered",
};

/**
 * A hole id as a question id the panel can echo back. Hole ids carry colons (`delivery:0:delivery`), and the panel's
 * `id: value` answer format splits at the FIRST colon — so a raw hole id would never match its own question.
 */
export function questionIdOf(holeId: string): string {
  return holeId.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "answer";
}

/**
 * The answer inside a reply. The panel sends a free-text or chip answer as `<question id>: <value>` (it FILLS the
 * composer when free text is allowed); a person may also just type the answer. The prefix is stripped so the builder
 * gets the words, never the id — an answer carrying `delivery_0_delivery:` would not fit its slot.
 */
export function answerText(reply: string, holeId: string): string {
  const ids = new Set([questionIdOf(holeId), holeId]);
  for (const line of reply.split("\n")) {
    const m = line.match(/^\s*(.+?)\s*:\s*(.+)$/);
    if (m && ids.has(m[1]!.trim())) return m[2]!.trim();
  }
  // A hole id with colons cannot be matched by the lazy split above when the person typed it raw; check it directly.
  const raw = reply.trim();
  if (raw.startsWith(`${holeId}:`)) return raw.slice(holeId.length + 1).trim();
  return raw;
}

/**
 * The readback as a person reads it in chat (2026-09-28: "looks so horrible"). The readback stays the engine's record — refs,
 * field names, the quote each line answers — and this only tidies how a line is SHOWN: a ref's datasource prefix and parentheses,
 * backticks, `(as sum_x)` aliases and a repeated "— for “…”" go; field names read as words. The person's own quoted words
 * (inside “…”) are never rewritten.
 */
export function chatLines(readback: string[]): string[] {
  const seen = new Set<string>();
  const words = (x: string) => x.replace(/_+/g, " ");
  const tidy = (seg: string) => seg
    .replace(/^Then \([^)]*\):\s*/, "Then: ")
    .replace(/\s\(as `[^`]+`\)/g, "")
    .replace(/\s\((?:[a-z][a-z0-9_]*\.)+[a-z][a-z0-9_]*\)/gi, "")
    .replace(/(?<![@\w.-])(?:[a-z][a-z0-9_]*\.)+([a-z][a-z0-9_]*)\b(?![@\w.-])/gi, (_, last: string) => words(last))
    .replace(/`([^`]+)`/g, (_, f: string) => words(f.slice(f.lastIndexOf(".") + 1)))
    .replace(/(?<![@\w.-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![@\w.-])/gi, words);
  return readback.map((line) => {
    // A repeated "— for “quote”" says nothing new: shown once, on the first line it answers.
    const m = line.match(/ — for “([^”]*)”$/);
    const body = m && seen.has(m[1]!) ? line.slice(0, m.index) : line;
    if (m) seen.add(m[1]!);
    return body.split(/(“[^”]*”)/).map((seg) => (seg.startsWith("“") ? seg : tidy(seg))).join("");
  });
}

const saidLine = (bt: BuilderTurn) => (bt.said ? [bt.said] : []);
const summaryLine = (bt: BuilderTurn) => (bt.summary ? [`Summary: ${bt.summary}`] : []);
const isPreviewLine = (l: string) => /^Preview:\s*/i.test(l) || /\bin preview\b/i.test(l) || /projects columns/i.test(l);
/** Split readback into dry-run / column previews vs the rest (Intent IR UI fold). */
export function splitReadback(readback: string[]): { details: string[]; previews: string[] } {
  const tidied = chatLines(readback);
  const previews = tidied.filter(isPreviewLine).map((l) => (l.startsWith("Preview:") ? l : `Preview: ${l}`));
  const details = tidied.filter((l) => !isPreviewLine(l));
  return { details, previews };
}
const understood = (readback: string[]) => {
  const { details, previews } = splitReadback(readback);
  return [...previews, ...details.map((l) => `Understood: ${l}`)];
};

/** The turn row a `BuilderTurn` is finished with — pure, so the mapping is testable without a database. */
export function builderTurnPatch(bt: BuilderTurn): { status: string; findingsJson: string[]; revision?: number } {
  const status = BUILDER_STATUS[bt.status];
  switch (bt.status) {
    case "asks": {
      const q = bt.question;
      // The framing line is the readback: code-written from the spec, what the builder understood so far.
      // One line per item (the panel keeps line breaks) — never one run-on sentence.
      // The framing is the flow so far, in a sentence; what the builder understood is folded beneath it (2026-09-28: the bulleted
      // readback was the whole bubble, "ugly and cluttered"). The canvas beside the chat shows the steps as they are built.
      // What the builder did with the last reply, when it says (an answer it could not use, an option it could not match), leads.
      const lead = bt.summary ? `So far: ${bt.summary.replace(/^It /, "it ")}` : "One thing before I can build it.";
      const text = bt.said ? `${bt.said}\n${lead}` : lead;
      const questions = q
        ? [
            {
              id: questionIdOf(q.holeId),
              question: q.ask,
              // A label in words: identifiers become words, a sentence keeps its punctuation (a reader's description is one).
              ...(q.options?.length ? { options: q.options.map((o) => ({ label: chatLines([o])[0] ?? o, value: o })) } : {}),
              // The builder's answer is words, so a typed answer is allowed beside the options — unless only the options answer
              // it (a scheduled flow's month or date, worked out when it runs).
              allow_custom: !q.onlyOptions,
              // A complete-save question has no incomplete to hold it: the typed pending rides the payload so the
              // next turn can answer it (a drafted subject/body confirm). Never a regex.
              ...(q.pending ? { pending: q.pending } : {}),
            },
          ]
        : [];
      const { details, previews } = splitReadback(bt.readback);
      // CLARIFY / PART: person can accept every open gap, or skip only this question ("not now").
      const acceptGaps = !!(q && (q.holeId === "clarify:unsettled" || q.holeId.startsWith("part:")));
      return {
        status,
        findingsJson: [
          JSON.stringify({
            text,
            questions,
            ...(details.length ? { details } : {}),
            ...(previews.length ? { previews } : {}),
            ...(acceptGaps ? { acceptGaps: true } : {}),
          }),
        ],
        // An asks turn that wrote a revision (complete-save drafted confirm): the surface must reload the canvas.
        ...(bt.revision !== undefined ? { revision: bt.revision } : {}),
      };
    }
    case "complete":
      return {
        status,
        findingsJson: [...saidLine(bt), ...summaryLine(bt), ...understood(bt.readback), ...chatLines(bt.unmet).map((u) => `Not done: ${u}`), ...bt.suggestions.map((x) => `Suggestion: ${x}`)],
        ...(bt.revision !== undefined ? { revision: bt.revision } : {}),
      };
    case "incomplete":
      return {
        status,
        findingsJson: [
          ...saidLine(bt),
          ...summaryLine(bt),
          "The draft is kept, but it does not yet do all of this:",
          ...chatLines(bt.unmet),
          ...understood(bt.readback),
          ...bt.suggestions.map((x) => `Suggestion: ${x}`),
        ],
      };
    case "cannot":
      return {
        status,
        findingsJson: [
          "This workspace cannot build that, so nothing was written:",
          ...chatLines(bt.unmet),
          ...understood(bt.readback),
        ],
      };
    case "unchanged":
      return { status, findingsJson: bt.said ? [bt.said] : ["That changes nothing in this automation.", ...understood(bt.readback)] };
  }
}

/** The hole the flow's working copy says is waiting for an answer, or null (none, or the working copy is stale). */
/** The question a `needs_input` turn asked, in its own words (the builder's and an edit's are filed the same way), or null. */
function askedOf(t: FlowChatTurn | undefined): string | null {
  if (t?.status !== "needs_input") return null;
  const raw = Array.isArray(t.findingsJson) ? t.findingsJson[0] : null;
  try {
    const j = JSON.parse(typeof raw === "string" ? raw : "") as { text?: string; questions?: Array<{ question?: string; options?: Array<{ label?: string }> }> };
    const q = j.questions?.[0];
    return [j.text, q?.question, q?.options?.length ? `(options: ${q.options.map((o) => o.label).join(" / ")})` : ""].filter(Boolean).join(" ") || null;
  } catch { return null; }
}

/** One read of the unfinished build: what dispatch routes on — the working copy's open question (null when none or stale). */
export type DispatchState = { pending: string | null };
export async function resolveState(workspaceId: string, flowId: string | null): Promise<DispatchState> {
  return { pending: flowId ? await pendingHole(workspaceId, flowId) : null };
}
async function pendingHole(workspaceId: string, flowId: string): Promise<string | null> {
  const view = await flowService.getIncomplete(workspaceId, flowId);
  if (!view || view.stale) return null;
  const pending = (view.build as { goalSpec?: { conversation?: { pending?: unknown } } } | undefined)?.goalSpec
    ?.conversation?.pending;
  return typeof pending === "string" && pending ? pending : null;
}

/** The chat row an edit's reply or an answer is finished with — pure. */
export function editTurnPatch(r: EditReply): { status: string; findingsJson: string[]; revision?: number } {
  switch (r.status) {
    case "applied": return { status: "applied", findingsJson: r.lines, ...(r.revision !== undefined ? { revision: r.revision } : {}) };
    // The pending decision rides in the question's own payload (D-338); the panel reads `text` and `questions` and ignores it.
    case "needs_input": return { status: "needs_input", findingsJson: [JSON.stringify({ text: r.text, questions: [r.question], pending: r.pending })] };
    // One paragraph, its lines kept: the panel renders an `answered` turn's first finding as text.
    // The suggestions, when there are any, ride in a second entry as structured data — the text stays the first finding.
    case "answered": {
      const extra = { ...(r.suggestions?.length ? { suggestions: r.suggestions } : {}), ...(r.card ? { card: r.card } : {}) };
      return { status: "answered", findingsJson: [r.lines.join("\n"), ...(Object.keys(extra).length ? [JSON.stringify(extra)] : [])] };
    }
    case "insufficient_catalogue": return { status: "insufficient_catalogue", findingsJson: r.lines };
  }
}

/**
 * One chat turn. The caller has already run the policy gate, the concurrency bounds, and written the turn `running`; this
 * finishes it. `chooser` is the model (tests pass their own).
 */
export async function builderChatTurn(ctx: {
  workspaceId: string;
  thread: FlowChatThread;
  turn: FlowChatTurn;
  message: string;
  author: RevisionAuthor;
  chooser?: Chooser;

  /** Composer Build/Ask toggle — narrows the route kinds. Absent is today's list. */
  mode?: "build" | "ask";
}): Promise<{ turn: FlowChatTurn; flowId: string | null; diff?: unknown }> {
  const { workspaceId, thread, turn, message, author } = ctx;
  const { builderStart, builderAnswer, builderRebuild, builderContinue, discardBuild, REPLAN_DONE } = await import("./builder/conversation.js");
  const { EDIT_NOT_ADDITIVE } = await import("./builder/goal-spec.js");
  const { builderCatalogue, modelChooser } = await import("./builder/builder.service.js");
  // S8: a flow that configured a chat model runs this whole turn on it — one bind point, every leaf inherits it. No
  // configured model (the common case) returns the base chooser itself: byte-for-byte today's behavior.
  const { parseChatConfig, resolveChatModel, withChatModel } = await import("./flow-chat-config.js");
  const { resolveGenerationProvider } = await import("./generation-provider.service.js");
  const { flowRepo } = await import("../repositories/flow.repo.js");
  const configured = thread.flowId ? parseChatConfig((await flowRepo.get(workspaceId, thread.flowId))?.chatConfig)?.model : undefined;
  const { model: chatModel, substitution: modelNote } = resolveChatModel(configured ?? null, await resolveGenerationProvider());
  const chooser = withChatModel(ctx.chooser ?? modelChooser, chatModel);
  const withReplanSaid = (bt: BuilderTurn): BuilderTurn => ({
    ...bt,
    said: bt.said ? `${REPLAN_DONE}\n${bt.said}` : REPLAN_DONE,
  });
  const runRebuild = async (change: string, via: string) => {
    console.info("[builder] rebuild why=%s", via);
    const rb = await builderRebuild(workspaceId, thread.flowId!, change, author, chooser);
    return fileBuilder(ctx, { ...withReplanSaid(rb), calls: rb.calls + 1 });
  };
  /** Middle gear: column/output reshape — pin-path rebuild, no “context cleared” copy. */
  const runShapeEdit = async (change: string, via: string) => {
    console.info("[builder] rebuild why=shape_only via=%s", via);
    const rb = await builderRebuild(workspaceId, thread.flowId!, change, author, chooser);
    return fileBuilder(ctx, { ...rb, calls: rb.calls + 1 });
  };

  const edits = await import("./builder/chat-edit.service.js");
  const { items, cat } = await builderCatalogue(workspaceId, { flowId: thread.flowId });
  const { loadState } = await import("./builder/canvas.service.js");
  const loaded = thread.flowId ? await loadState(workspaceId, thread.flowId, cat) : null;
  const state = loaded && "state" in loaded ? loaded.state : null;
  const hasSteps = state ? state.steps.length > 0 : !!loaded; // a legacy flow has steps the engine cannot read
  const { routeMessage } = await import("./builder/chat-route.js");

  // One read of the unfinished build per turn: an open question (answerable).
  const prev = (await flowChatRepo.listTurns(workspaceId, thread.id)).filter((t) => t.seq < turn.seq).at(-1);
  const { pending } = await resolveState(workspaceId, thread.flowId);
  const pe = thread.flowId && prev?.status === "needs_input" ? edits.pendingOf(prev.findingsJson) : null;

  // Typed control replies: the router states the kind, never a regex. (The replan gate, its “go ahead” and the Build/Ask
  // narrowing are DELETED, 2026-10-10: a change to an unfinished build is applied, never held for permission.)
  const preKind = await routeMessage(message, hasSteps, chooser, askedOf(prev) ?? undefined);
  // A typed discard drops the unfinished build before anything else reads the message.
  if (thread.flowId && preKind === "discard") {
    const { builderContinue: cont } = await import("./builder/conversation.js");
    const dropped = await cont(workspaceId, thread.flowId, message, author, chooser, { kind: "discard" });
    if (dropped) return fileBuilder(ctx, { ...dropped, calls: dropped.calls + 1 });
    return fileBuilder(ctx, { ...(await discardBuild(workspaceId, thread.flowId)), calls: 0 });
  }

  // builder-behaviour P4 (R11): whether the message ANSWERS that question is decided with the question in view — one route call,
  // `answer` among its kinds. A message that asks for something else goes on as any message does (an unfinished build continues
  // with it), never forced into the question ("send the email to X instead" was taken as "what is 2 days ago?").
  // `preKind` above already routed once; reuse it when a question was open instead of calling again.
  const routed = pending || pe ? preKind : undefined;

  // 1. The builder's own question, answered.
  if (pending && (!routed || routed === "answer")) return fileBuilder(ctx, await builderAnswer(workspaceId, thread.flowId!, answerText(message, pending), author, chooser));
  // 1b. A complete-save drafted confirm, answered from the turn payload (no incomplete holds it — the revision
  // already carries the drafted wording). "Yes" keeps it; anything else becomes a change to the wording. Typed, never a regex.
  if (pe && (pe as { kind?: string }).kind === "drafted" && thread.flowId && (!routed || routed === "answer")) {
    const { CONFIRMS } = await import("./builder/reply-intents.js");
    const dp = pe as { key: string; subject?: string; body?: string };
    if (CONFIRMS.test(message.trim())) {
      const kept = [dp.subject !== undefined ? `subject “${dp.subject}”` : null, dp.body !== undefined ? `message “${dp.body}”` : null].filter(Boolean).join(" and ");
      return fileEdit(ctx, { status: "answered", lines: [`Kept it — the ${kept || "drafted wording"} stays as drafted.`] }, 1);
    }
    const r = await edits.editTurn(workspaceId, thread.flowId, message, author, chooser);
    if (r.decision === "none_fit" && thread.flowId) return runRebuild(message, "none_fit");
    return fileEdit(ctx, r, r.calls + 1);
  }
  // 2. An edit's question, asked on the previous turn: resumed only by an answer to it.
  // (A drafted confirm is consumed by 1b above, never here — the union narrows on the kind.)
  const resumePe = pe && (pe as { kind?: string }).kind !== "drafted" ? (pe as Parameters<typeof edits.resumeEdit>[2]) : null;
  if (resumePe && (!routed || routed === "answer")) {
    const resumed = await edits.resumeEdit(workspaceId, thread.flowId!, resumePe, message, author);
    if (resumed) return fileEdit(ctx, resumed, 0);
  }
  // 3. Route (reuse the pre-route when nothing was pending).
  const kind = routed && routed !== "answer" ? routed : preKind;
  const answers = await import("./builder/chat-answers.js");
  switch (kind) {
    case "build": {
      const bt = await builderStart(workspaceId, message, author, thread.flowId ?? null, chooser);
      // One-step additive start refused a change to existing steps → rebuild now (no toggle + go ahead).
      if (thread.flowId && bt.status === "cannot" && [bt.said ?? "", ...bt.unmet].some((l) => l.includes(EDIT_NOT_ADDITIVE))) {
        return runRebuild(message, "edit_not_additive");
      }
      return fileBuilder(ctx, { ...bt, calls: bt.calls + 1 });
    }
    case "shape": {
      // Typed shape fast path (was `isShapeOnlyEdit` regex): column reshape via the pin path.
      if (thread.flowId) return runShapeEdit(message, "shape");
      const bt = await builderStart(workspaceId, message, author, thread.flowId ?? null, chooser);
      return fileBuilder(ctx, { ...bt, calls: bt.calls + 1 });
    }
    case "change": {
      const r = await edits.editTurn(workspaceId, thread.flowId!, message, author, chooser);
      // No listed one-step edit fits → rebuild now (critique / SQL fix / swap action).
      if (r.decision === "none_fit" && thread.flowId) {
        return runRebuild(message, "none_fit");
      }
      return fileEdit(ctx, r, r.calls + 1);
    }
    case "about_flow":
      // One or two sentences, the steps folded beneath them (2026-09-28: "not very clean response").
      // …with the facts a question about it is usually after, read from what is STORED (2026-10-01: "which step is not finished?" and
      // "why is there period as start input?" both got the same summary): what the build left undone, and what each run asks for
      // and which step needs it. Code-written; the panel shows each as its own group.
      // Strategy B: when BUILDER_INTENT_IR is on, phrase the same fact card warmly (model optional) — never invent steps.
      if (!state) return fileEdit(ctx, { status: "insufficient_catalogue", lines: [`This automation cannot be read from chat: ${(loaded as { legacy: string }).legacy}`] }, 1);
      // Spec-grounded step + claim answers (2026-10-08): a question naming a step ("what does read_1 do", "what does
      // the query return") is answered from that STORED step's own form — the sibling of the numeric-claim band path,
      // tried first when a step resolves; neutral questions keep the summary path below. No model call.
      if (thread.flowId) {
        const stepId = answers.resolveStepRef(message, state.steps.map((s) => ({ id: s.id, kind: s.kind })));
        if (stepId || answers.hasVerifiableClaim(message)) {
          const { flowRepo } = await import("../repositories/flow.repo.js");
          const flow = await flowRepo.get(workspaceId, thread.flowId);
          const rev = flow && flow.draftRevision > 0 ? await flowRepo.getRevision(flow.id, flow.draftRevision) : undefined;
          if (rev?.goalSpec && typeof rev.goalSpec === "object" && "spec" in rev.goalSpec) {
            const goalSpec = rev.goalSpec as { spec?: { summary?: Parameters<typeof answers.answerStepAbout>[2] } };
            if (stepId) {
              const stepped = answers.answerStepAbout(message, state.steps, goalSpec.spec?.summary);
              if (stepped) return fileEdit(ctx, { status: "answered", lines: stepped }, 1);
            }
            if (answers.hasVerifiableClaim(message)) {
              const quoted = goalSpec.spec ? answers.verifyAgainstBands(message, goalSpec.spec as Parameters<typeof answers.verifyAgainstBands>[1]) : null;
              if (quoted) return fileEdit(ctx, { status: "answered", lines: quoted }, 1);
            }
          } else if (stepId) {
            const stepped = answers.answerStepAbout(message, state.steps);
            if (stepped) return fileEdit(ctx, { status: "answered", lines: stepped }, 1);
          }
        }
      }
      {
        const notBuilt = loaded && "working" in loaded ? loaded.working?.notBuilt ?? [] : [];
        const groups = [
          ...(notBuilt.length ? [{ title: "Not done yet", items: notBuilt }] : []),
          ...(state.inputs.length ? [{ title: "Each run asks for", items: answers.inputFacts(state, items) }] : []),
        ];
        const intro = answers.describeFlow(state, items, cat);
        const inventory = answers.aboutFlow(state, items, cat).slice(1);
        const { intentIrEnabled } = await import("./builder/intent-ir.js");
        if (intentIrEnabled()) {
          const { factCardFromLines, assistantReply } = await import("./builder/assistant-voice.js");
          const card = factCardFromLines({
            summary: intro,
            inventory,
            gaps: notBuilt,
            catalogueHints: items.items.map((i) => i.ref),
          });
          const voiced = await assistantReply(card, chooser);
          return fileEdit(ctx, {
            status: "answered",
            lines: [voiced.text],
            ...(state.steps.length ? { card: { intro: voiced.text, groups, inventory, more: "See the steps" } } : {}),
          }, 1 + voiced.calls);
        }
        return fileEdit(ctx, { status: "answered", lines: [intro], ...(state.steps.length ? { card: { intro, groups, inventory, more: "See the steps" } } : {}) }, 1);
      }
    case "capabilities": {
      // D-341: the overview a person reads, over the code-written inventory — which is also the whole answer when the overview
      // could not be written (the call failed, or nothing it wrote survived the checks).
      const inventory = answers.capabilities(items);
      const ov = await answers.overview(items, chooser);
      const o = ov.overview;
      if (!o) return fileEdit(ctx, { status: "answered", lines: inventory, suggestions: answers.fallbackStarters(items) }, 1 + ov.calls);
      const lines = [o.intro];
      return fileEdit(ctx, { status: "answered", lines, suggestions: o.starters, card: { intro: o.intro, groups: o.groups, inventory: answers.inventoryLines(items) } }, 1 + ov.calls);
    }
    case "accept":
      // Typed accept: continue the unfinished build so gaps close as accepted-with-gaps.
      if (thread.flowId) {
        const cont = await builderContinue(workspaceId, thread.flowId, message, author, chooser);
        if (cont) return fileBuilder(ctx, { ...cont, calls: cont.calls + 1 });
      }
      return fileEdit(ctx, { status: "answered", lines: ["Nothing is waiting for an answer."] }, 1);
    case "discard":
      if (thread.flowId) return fileBuilder(ctx, { ...(await discardBuild(workspaceId, thread.flowId)), calls: 0 });
      return fileEdit(ctx, { status: "answered", lines: ["Nothing is waiting for an answer."] }, 1);
    case "answer": // only offered while a question waits, and answered above
    case "chat":
      return fileEdit(ctx, { status: "answered", lines: answers.CHAT_REPLY }, 1);
  }
}

async function fileEdit(ctx: { workspaceId: string; thread: FlowChatThread; turn: FlowChatTurn }, r: EditReply, calls: number): Promise<{ turn: FlowChatTurn; flowId: string | null; diff?: unknown }> {
  const { workspaceId, thread, turn } = ctx;
  const patch = editTurnPatch(r);
  const finished = await flowChatRepo.finishTurn(turn.id, { status: patch.status, attempts: calls, findingsJson: patch.findingsJson as never, ...(patch.revision !== undefined ? { revision: patch.revision } : {}) });
  let diff: unknown;
  if (r.status === "applied" && thread.flowId && r.revision !== undefined && r.revision > 1) {
    diff = await flowApprovalService.diff(workspaceId, thread.flowId, r.revision - 1, r.revision).catch(() => undefined);
  }
  return { turn: finished!, flowId: thread.flowId ?? null, ...(diff !== undefined ? { diff } : {}) };
}

async function fileBuilder(ctx: { workspaceId: string; thread: FlowChatThread; turn: FlowChatTurn }, bt: BuilderTurn): Promise<{ turn: FlowChatTurn; flowId: string | null; diff?: unknown }> {
  const { workspaceId, thread, turn } = ctx;
  const flowId = bt.flowId ?? thread.flowId ?? null;
  // Linked the way the one-op editor links it: once, when the builder first creates the flow.
  if (flowId && !thread.flowId) await flowChatRepo.attachFlow(workspaceId, thread.id, flowId);

  const patch = builderTurnPatch(bt);
  const finished = await flowChatRepo.finishTurn(turn.id, {
    status: patch.status,
    // The model calls this turn made, counted by the builder where they are made.
    attempts: bt.calls,
    findingsJson: patch.findingsJson as never,
    ...(patch.revision !== undefined ? { revision: patch.revision } : {}),
  });

  // The same "what changed" the approval screen reads; absent on the seeding revision (nothing to compare against).
  // ⚠ A diff that cannot be computed never fails a turn that already wrote its revision.
  let diff: unknown;
  if (bt.status === "complete" && flowId && bt.revision !== undefined && bt.revision > 1) {
    diff = await flowApprovalService.diff(workspaceId, flowId, bt.revision - 1, bt.revision).catch(() => undefined);
  }
  return { turn: finished!, flowId, ...(diff !== undefined ? { diff } : {}) };
}
