/**
 * The route (phase X, D-334) and the answers written by code (D-335).
 */
import { describe, expect, it } from "vitest";
import type { EFlow } from "@foundry/flow-edit";
import { routeKinds, routeMessage, routePrompt, routeSchema, ROUTE_KINDS } from "./chat-route.js";
import { aboutFlow, capabilities, TABLES_NAMED, CHAT_REPLY, codeStarters, describeFlow, grounded, inventoryLines, LIST_MAX, overview, STARTERS_MAX, GROUPS_MAX } from "./chat-answers.js";
import type { BuilderCatalogue } from "./goal-spec.js";

describe("the route", () => {
  it("with no steps, `change` and `about_flow` are not in the enum — the model cannot choose them", () => {
    expect(routeKinds(false)).toEqual(["build", "capabilities", "chat"]);
    // `answer` is offered only while a question waits (builder-behaviour R11); `accept`/`discard` need steps or a waiting question.
    expect(routeKinds(true)).toEqual(ROUTE_KINDS.filter((k) => k !== "answer"));
    expect(routeKinds(true)).toEqual(["build", "change", "shape", "about_flow", "capabilities", "chat", "accept", "discard"]);
    const e = (routeSchema(false) as unknown as { properties: { kind: { enum: string[] } } }).properties.kind.enum;
    expect(e).not.toContain("change");
  });
  it("the replan gate's “go ahead” kind and the Build/Ask narrowing are gone (2026-10-10) — the router decides alone", async () => {
    expect(ROUTE_KINDS as readonly string[]).not.toContain("replan_go_ahead");
    expect(routePrompt("go ahead", true)).not.toMatch(/replan_go_ahead/);
    // A model reply naming the deleted kind is a schema refusal, never repaired into one.
    await expect(routeMessage("go ahead", true, async () => JSON.stringify({ kind: "replan_go_ahead" }))).rejects.toThrow(/schema/);
    // CONTROL: the same call with a live kind is accepted.
    await expect(routeMessage("go ahead", true, async () => JSON.stringify({ kind: "accept" }))).resolves.toBe("accept");
  });


  it("returns the model's kind, from one strict call labelled chat:route", async () => {
    const labels: string[] = [];
    const k = await routeMessage("What can you build?", false, async (_p, _s, label) => { labels.push(label); return JSON.stringify({ kind: "capabilities" }); });
    expect(k).toBe("capabilities");
    expect(labels).toEqual(["chat:route"]);
  });

  it("a reply outside the enum is a gateway defect, never repaired into a kind", async () => {
    await expect(routeMessage("hi", false, async () => JSON.stringify({ kind: "change" }))).rejects.toThrow(/schema/);
  });

  it("the message comes LAST, and the prompt carries no catalogue", () => {
    const p = routePrompt("do the thing", true);
    expect(p.trimEnd().endsWith("do the thing")).toBe(true);
    expect(p).not.toMatch(/READERS|ACTIONS/);
  });

  it("a challenge to existing logic is taught as `change`, not `about_flow` (cea88c67: overlap question got a summary)", () => {
    const p = routePrompt("dont you think using >= and <= will overlap?", true);
    expect(p).toMatch(/challenge[\s\S]*wrong or overlapping|rhetorical|double-count/i);
    expect(p).toMatch(/never `about_flow`|Not a challenge to its logic/);
    // The kinds block must put the critique under change, not only under about_flow.
    const changeLine = p.split("\n").find((l) => l.includes("`change`"));
    const aboutLine = p.split("\n").find((l) => l.includes("`about_flow`"));
    expect(changeLine).toMatch(/wrong|overlap|rhetorical|double-count|fixed/i);
    expect(aboutLine).toMatch(/NEUTRAL|Not a challenge/i);
  });
  it("cold pass: with no question pending the prompt carries no question block and `answer` is not offered", async () => {
    const msg = "Show me open orders by region, channel, priority";
    const cold = routePrompt(msg, false, undefined);
    expect(cold).not.toMatch(/THE BUILDER JUST ASKED/);
    expect(cold).not.toMatch(/a question about the automation/);
    expect(cold.trimEnd().endsWith(msg)).toBe(true);
    // Control: a waiting question is passed through verbatim.
    const warm = routePrompt(msg, false, "Which field means priority?");
    expect(warm).toMatch(/THE BUILDER JUST ASKED[\s\S]*Which field means priority\?/);
    // A build-shaped imperative routes `build`, not `chat`, with no pending question.
    const seen: string[] = [];
    const kind = await routeMessage(msg, false, async (p) => { seen.push(p); return JSON.stringify({ kind: "build" }); }, undefined);
    expect(kind).toBe("build");
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/THE BUILDER JUST ASKED/);
    // `answer` is not in the cold enum — a cold reply claiming it is a gateway defect.
    await expect(routeMessage(msg, false, async () => JSON.stringify({ kind: "answer" }), undefined)).rejects.toThrow(/schema/);
  });
});

const items: BuilderCatalogue = { items: [
  { ref: "shop.orders", kind: "reader", about: "Every order placed this month. One row per order." },
  { ref: "shop.table.customers", kind: "reader", about: "The customers table." },
  { ref: "notify", kind: "tool", about: "Send a message to a person. Delivered at once." },
] };

describe("answers written by code", () => {
  it("capabilities: the saved readers and the actions in their own first sentences; tables counted", () => {
    const lines = capabilities(items);
    expect(lines).toContain("• Every order placed this month.");
    expect(lines).toContain("• Send a message to a person.");
    // The DATASOURCE and its tables by name — "the rows of 28 tables directly" named neither (2026-10-01).
    expect(lines).toContain("• and, from shop, the rows of 1 table directly: customers");
    expect(lines).toContain("Data I can read:");
    expect(lines).toContain("Things I can do with it:");
    expect(lines.at(-1)).toMatch(/^Pick one below to start/);
  });

  it("capabilities: tables are grouped per datasource, named up to a cap, the rest counted", () => {
    const tables = Array.from({ length: TABLES_NAMED + 2 }, (_, i) => `t_${i}`);
    const cat: BuilderCatalogue = {
      items: [...tables.map((t) => ({ ref: `att.table.main.${t}`, kind: "reader" as const, about: t })), { ref: "hr.table.people", kind: "reader" as const, about: "people" }],
      tables: { ...Object.fromEntries(tables.map((t) => [`att.table.main.${t}`, { datasource: "att", spec: {}, sql: "", tables: [t] }])), "hr.table.people": { datasource: "hr", spec: {}, sql: "", tables: ["people"] } },
    };
    const lines = capabilities(cat);
    expect(lines).toContain(`• from att, the rows of ${TABLES_NAMED + 2} tables directly: ${tables.slice(0, TABLES_NAMED).map((t) => t.replace(/_/g, " ")).join(", ")} and 2 more`);
    expect(lines).toContain("• from hr, the rows of 1 table directly: people");
  });

  it("capabilities: a long list is cut and counted, never silently", () => {
    const many: BuilderCatalogue = { items: Array.from({ length: LIST_MAX + 3 }, (_, i) => ({ ref: `r${i}`, kind: "reader" as const, about: `Reader ${i}.` })) };
    expect(capabilities(many)).toContain("• …and 3 more");
  });

  it("capabilities on an empty workspace says so, rather than listing nothing", () => {
    expect(capabilities({ items: [] })[0]).toMatch(/no data sources or actions yet/);
  });

  it("about_flow: a sentence, then the steps numbered — no step ids, no refs; an empty flow says so", () => {
    const f = { id: "f", inputs: [], holes: [], steps: [
      { id: "read_orders", kind: "datasource", ref: "shop.orders", inputs: [] },
      { id: "tell", kind: "tool", ref: "notify", inputs: [], over: { stepId: "read_orders" } },
    ], output: { stepId: "read_orders" } } as unknown as EFlow;
    expect(describeFlow(f, items)).toBe("It reads every order placed this month, then uses notify for each row. Runs when you start it.");
    const lines = aboutFlow(f, items);
    expect(lines).toEqual(["This automation has 2 steps:", "1. Reads every order placed this month", "2. Then uses notify for each row"]);
    expect(lines.join(" ")).not.toMatch(/read_orders|shop\.orders|\btell\b/);
    expect(aboutFlow({ id: "f", inputs: [], holes: [], steps: [] } as unknown as EFlow, items)[0]).toMatch(/no steps yet/);
  });

  it("describeFlow: an action by what it DECLARES — an address port emails, a model-text tool summarises — and open holes counted", () => {
    const cat = { refs: {
      mail: { kind: "tool", params: [{ name: "to", ty: { t: "List", of: { t: "Address" } }, required: true }], payload: { t: "Opaque" } },
      write: { kind: "tool", params: [], payload: { t: "Opaque" }, modelText: true },
    } } as never;
    const f = { id: "f", inputs: [], holes: [{ id: "h" }], steps: [
      { id: "r", kind: "datasource", ref: "shop.orders", inputs: [] },
      { id: "t", kind: "transform", from: "r", pipeline: [{ op: "filter", where: { notNull: "x" } }, { op: "group" }], expr: "", dependsOn: ["r"] },
      { id: "w", kind: "tool", ref: "write", inputs: [] },
      { id: "m", kind: "tool", ref: "mail", inputs: [{ name: "to", source: { from: "literal", value: "me@x.example" } }] },
    ], schedule: { cron: "0 9 * * 1" } } as unknown as EFlow;
    expect(describeFlow(f, items, cat)).toBe("It reads every order placed this month, totals the rows, writes a summary of it and emails it to me@x.example. Runs every Monday at 09:00. One detail is still to decide.");
    // An unset `to` that falls back to the requester goes to "you" — the run's starter — never "someone still to choose".
    const mailYou = { refs: { mail: { kind: "tool", params: [{ name: "to", ty: { t: "Address" }, required: false, fallsBackToRequester: true }], payload: { t: "Opaque" } } } } as never;
    expect(describeFlow({ id: "f", inputs: [], holes: [], steps: [{ id: "m", kind: "tool", ref: "mail", inputs: [] }] } as unknown as EFlow, items, mailYou)).toBe("It reads nothing yet, emails it to you. Runs when you start it.");
  });

  // Honest restatement (UAT 2026-10-05, RC-5): the summary says what the FLOW holds — an undecided recipient is unset, two sends
  // of one tool are told apart by their own words, and a condition is said in the person's words when the flow carries them.
  const mailCat = { refs: { mail: { kind: "tool", params: [
    { name: "to", ty: { t: "List", of: { t: "Address" } }, required: false, fallsBackToRequester: true },
    { name: "subject", ty: { t: "Text" }, required: true, heading: true },
  ], payload: { t: "Opaque" } } } } as never;
  const openOn = (stepId: string, port: string) => ({ id: `h_${stepId}_${port}`, site: { at: "port", stepId, port }, why: "required", owner: "person", reason: "unset" });
  const send = (id: string, subject: string, to?: string) => ({ id, kind: "tool", ref: "mail", dependsOn: [], inputs: [
    { name: "subject", source: { from: "literal", value: subject } },
    ...(to ? [{ name: "to", source: { from: "literal", value: to } }] : []),
  ] });

  it("RC-5 (a)(c): an unbound recipient whose port holds a hole is UNSET — never 'you', in the summary's words and the steps'", () => {
    const f = { id: "f", inputs: [], holes: [openOn("m", "to")], steps: [send("m", "Profile reminder")] } as unknown as EFlow;
    const said = describeFlow(f, items, mailCat);
    expect(said).toContain("sends “Profile reminder”, the recipient not set yet");
    expect(said).not.toContain("to you"); // the schedule's own "when you start it" is not a recipient
    // Same category the findings report on that turn: still undecided, not a delivered send.
    expect(said).toContain("One detail is still to decide.");
    expect(aboutFlow(f, items, mailCat)[1]).toBe("1. Sends “Profile reminder”, the recipient not set yet");
    // (e) the answers still work with no catalogue at all — no model, no crash.
    expect(describeFlow(f, items)).toContain("then uses mail");
  });

  it("RC-5 CONTROL: the same unbound recipient with NO hole is the receiver's own fallback — 'you' stays correct", () => {
    const f = { id: "f", inputs: [], holes: [], steps: [send("m", "Invoice count")] } as unknown as EFlow;
    expect(describeFlow(f, items, mailCat)).toContain("emails “Invoice count” to you");
    // …and a bound recipient is its address, said as bound (the pinned case above keeps `emails it to …` with no heading).
    expect(describeFlow({ id: "f", inputs: [], holes: [openOn("m", "to")], steps: [send("m", "Invoice count", "ops@x.example")] } as unknown as EFlow, items, mailCat))
      .toContain("emails “Invoice count” to ops@x.example");
  });

  it("RC-5 (b): two sends of one tool in one flow render distinguishably — each by its own words", () => {
    const unset = { id: "f", inputs: [], holes: [openOn("m1", "to"), openOn("m2", "to")], steps: [
      send("m1", "Tax document reminder"), send("m2", "Report of who still hasn't submitted"),
    ] } as unknown as EFlow;
    const said = describeFlow(unset, items, mailCat);
    expect(said).toContain("sends “Tax document reminder”, the recipient not set yet");
    expect(said).toContain("sends “Report of who still hasn't submitted”, the recipient not set yet");
    // Same recipient, different words — still two different sends on screen.
    const bound = { id: "f", inputs: [], holes: [], steps: [
      send("m1", "Reminder", "ops@x.example"), send("m2", "Weekly report", "ops@x.example"),
    ] } as unknown as EFlow;
    const text = describeFlow(bound, items, mailCat);
    expect(text).toContain("emails “Reminder” to ops@x.example");
    expect(text).toContain("emails “Weekly report” to ops@x.example");
  });

  it("RC-5 (d): a condition is said in the GOAL's own words when the flow carries them; by structure when it does not", () => {
    const flow = (quote?: string) => ({ id: "f", inputs: [], holes: [], steps: [
      { id: "r", kind: "datasource", ref: "shop.orders", inputs: [], dependsOn: [] },
      { id: "t", kind: "transform", from: "r", expr: "", dependsOn: ["r"], pipeline: [{ op: "filter", where: { cmp: "gt", left: { field: "due_date" }, right: { lit: { value: 30, from: "goal", ...(quote ? { quote } : {}) } } } }] },
      { id: "w", kind: "branch", conditions: [{ left: { stepId: "t", field: "" }, op: "any" }], dependsOn: ["t"] },
      { id: "m", kind: "tool", ref: "mail", dependsOn: ["w"], inputs: [{ name: "to", source: { from: "literal", value: "finance@x.example" } }] },
    ] } as unknown as EFlow);
    expect(describeFlow(flow("if an invoice is overdue by more than 30 days"), items, mailCat))
      .toContain("If “an invoice is overdue by more than 30 days”, it emails it to finance@x.example.");
    // CONTROL: a path's literal wears its compared VALUE as the quote — that is not the goal's words; the structure is said, as before.
    const asValue = describeFlow(flow("30"), items, mailCat);
    expect(asValue).toContain("due date is more than 30");
    expect(asValue).not.toContain("overdue by more than 30 days");
    expect(describeFlow(flow(), items, mailCat)).toContain("due date is more than 30");
  });

  it("the chat reply is fixed", () => {
    expect(CHAT_REPLY).toHaveLength(1);
  });
});

describe("the overview — a capabilities answer a person reads (D-341; explores the live catalogue, 2026-10-03)", () => {
  const good = {
    intro: "Automations here keep orders moving and tell people what they need to know.",
    groups: [{ title: "Orders", ideas: ["Message me each week with the orders that came in.", "Message me each week with the orders that came in."] }],
    starters: [{ reader: "shop.orders", action: "notify", prompt: "Every Monday, message me this month's orders" }],
  };
  const call = (reply: unknown) => overview(items, async () => JSON.stringify(reply));

  it("the schema asks for a sentence, themed groups and starters; every starter bound to this workspace's components", async () => {
    let schema: any;
    await overview(items, async (_p: string, s: { schema: unknown }) => { schema = s.schema; return JSON.stringify(good); });
    expect(Object.keys(schema.properties).sort()).toEqual(["groups", "intro", "starters"]);
    expect(schema.properties.groups.maxItems).toBe(GROUPS_MAX);
    expect(schema.properties.starters.items.properties.reader.enum).toEqual(items.items.filter((i) => i.kind === "reader").map((i) => i.ref).sort((a, b) => Number(a.includes(".table.")) - Number(b.includes(".table.")))) // saved readers first, then tables;
    expect(schema.properties.starters.maxItems).toBe(STARTERS_MAX);
  });

  it("a grounded answer survives whole; a repeated idea is kept once", async () => {
    const r = await call(good);
    expect(r.calls).toBe(1);
    expect(r.overview).toEqual({ intro: good.intro, groups: [{ title: "Orders", items: [good.groups[0]!.ideas[0]] }], starters: [{ label: good.starters[0]!.prompt, value: good.starters[0]!.prompt }] });
  });

  it("⚠ an intro inventing a specific, or running past two sentences, is refused — the caller answers with the inventory", async () => {
    for (const intro of ["Post the orders to #sales every day.", "Email boss@x.example the orders.", "Read shop.orders and summarise.", "One. Two. Three."])
      expect((await call({ ...good, intro })).overview).toBeNull();
  });

  it("a starter inventing a specific is dropped, and none left ⇒ code-written ones, never an empty offer", async () => {
    const r = await call({ ...good, starters: [{ reader: "shop.orders", action: "none", prompt: "Send it to a@b.example" }] });
    expect(r.overview!.starters).toEqual(codeStarters([items.items[0]!]));
  });

  it("a failed call, or an exclaiming intro ⇒ null", async () => {
    expect((await call({ ...good, intro: "I'd love to help!" })).overview).toBeNull();
    expect((await overview(items, async () => { throw new Error("gateway down"); })).overview).toBeNull();
  });

  it("no reader at all: no call", async () => {
    let called = false;
    const r = await overview({ items: [{ ref: "notify", kind: "tool", about: "Send." }] }, async () => { called = true; return "{}"; });
    expect(r).toEqual({ overview: null, calls: 0 });
    expect(called).toBe(false);
  });

  it("a workspace whose data is ALL tables is explored too — its tables and fields reach the call (2026-10-03: it got the static list)", async () => {
    let prompt = "";
    const tables = { items: [{ ref: "fin.table.invoices", kind: "reader" as const, about: "each row of the table `invoices`", fields: [{ name: "due_date", ty: "Date" }] }, { ref: "notify", kind: "tool" as const, about: "Send." }] };
    const r = await overview(tables, async (p: string) => { prompt = p; return JSON.stringify({ ...good, groups: [], starters: [] }); });
    expect(r.calls).toBe(1);
    expect(prompt).toContain("fin.table.invoices");
    expect(prompt).toContain("due date");
    // No surviving starter ⇒ the table's own name, never an empty offer.
    expect(r.overview!.starters).toEqual([{ label: "Show me the invoices", value: "Show me the invoices" }]);
  });

  it("an idea or a group title inventing a specific is dropped; a group left empty goes", async () => {
    const r = await call({ ...good, groups: [{ title: "Orders", ideas: ["Post them to #sales daily."] }] });
    expect(r.overview!.groups).toEqual([]);
  });

  it("grounded: a specific the catalogue itself gives passes", () => {
    expect(grounded("Post to #finance-ops monthly", "Posts to #finance-ops for month-end.")).toBe(true);
    expect(grounded("Post to #ops monthly", "Posts to #finance-ops for month-end.")).toBe(false);
  });

  it("the inventory keeps the lists and drops the framing sentences", () => {
    const inv = inventoryLines(items);
    expect(inv).toContain("Data I can read:");
    expect(inv.some((l) => l.startsWith("Pick one"))).toBe(false);
  });
});
