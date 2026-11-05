// ui-upgrade Phase 9 — the plugin registry, and the one number on the page that
// is about THIS PRODUCT rather than about Kestra. D-111.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FOUNDRY_EMITS, iconFor, type PluginIcons } from "./engine-plugin.service.js";

const compilerSource = readFileSync(
  fileURLToPath(new URL("./flow-compiler.service.ts", import.meta.url)),
  "utf8",
);

describe("FOUNDRY_EMITS is pinned to the compiler, not maintained by hand", () => {
  /**
   * ⚠ **This is the assertion the phase turns on.** `/apps` says "the engine
   * registers N classes and an automation can reach 7 of them". That sentence is
   * the difference between a capability page and a catalogue of things you
   * cannot ask for — and it goes silently wrong the moment the compiler learns
   * an eighth task type, because nothing else in the system would notice.
   *
   * Same shape as `kestra:check`'s "a secret is read in exactly three
   * files": the number is the check.
   */
  it("names exactly the task types flow-compiler.service.ts emits", () => {
    const inCompiler = new Set(
      compilerSource.match(/io\.kestra\.plugin\.[A-Za-z0-9._]*/g) ?? [],
    );
    expect([...inCompiler].sort()).toEqual([...FOUNDRY_EMITS].sort());
  });

  it("finds the types at all, so a rename cannot leave it scanning nothing", () => {
    // ⚠ The control. If `flow-compiler.service.ts` moved or stopped writing
    // fully-qualified class names, the regex above would match nothing and the
    // comparison would only pass against an empty FOUNDRY_EMITS — which is a
    // check that reports green over no subject (I-38).
    expect(compilerSource.length).toBeGreaterThan(1000);
    expect(compilerSource.match(/io\.kestra\.plugin\./g)!.length).toBeGreaterThan(6);
  });

  it("includes the Docker task runner and NOT the Process one", () => {
    // `…runner.process.Process` runs a fragment inside the Kestra container —
    // same filesystem, same network, same credentials as the engine. One word,
    // and every containment property of a `code` step disappears. It must never
    // appear on the reachable list, because the reachable list is a claim about
    // what this product will run.
    expect(FOUNDRY_EMITS).toContain("io.kestra.plugin.scripts.runner.docker.Docker");
    expect(FOUNDRY_EMITS).not.toContain("io.kestra.plugin.core.runner.Process");
  });

  it("is small — that is the point, not an omission", () => {
    expect(FOUNDRY_EMITS.length).toBeLessThan(15);
  });
});

/**
 * The gallery's logos — pinned to the two things that were MEASURED against the
 * live engine on 2026-08-09, both of which the obvious implementation gets
 * wrong.
 */
describe("a plugin's logo is picked from its own classes", () => {
  const icons: PluginIcons = {
    "io.kestra.plugin.slack.notifications.SlackIncomingWebhook": { icon: "SLACK" },
    "io.kestra.plugin.slack.notifications.SlackExecution": { icon: "SLACK" },
    // ⚠ Measured: Slack registers a class whose icon is the EMPTY STRING.
    "io.kestra.plugin.slack.app.users.List": { icon: "" },
    "io.kestra.plugin.slack.oddity.Variant": { icon: "VARIANT" },
  };

  it("picks the most common icon, not the first", () => {
    // Sorted first alphabetically is `app.users.List`, whose icon is empty, and
    // `oddity.Variant` is a real but one-off override. Either would render the
    // wrong mark — or none — under a "first non-empty" rule.
    expect(
      iconFor(
        [
          { cls: "io.kestra.plugin.slack.app.users.List" },
          { cls: "io.kestra.plugin.slack.notifications.SlackExecution" },
          { cls: "io.kestra.plugin.slack.notifications.SlackIncomingWebhook" },
          { cls: "io.kestra.plugin.slack.oddity.Variant" },
        ],
        icons,
      ),
    ).toBe("SLACK");
  });

  it("never returns an empty string as an icon", () => {
    // An empty `icon` is falsy in JS but truthy as "a value was returned", so a
    // client would render `data:image/svg+xml;base64,` — a broken image rather
    // than the letter fallback the absence is supposed to produce.
    expect(iconFor([{ cls: "io.kestra.plugin.slack.app.users.List" }], icons)).toBeNull();
  });

  it("is keyed on the class list, so a package-prefix guess cannot apply", () => {
    // ⚠ The reason this takes classes rather than a plugin name. `plugin-email`'s
    // classes live under `io.kestra.plugin.ee.email`, so deriving the lookup key
    // from the plugin's NAME finds nothing and the logo vanishes silently.
    expect(iconFor([{ cls: "io.kestra.plugin.ee.email.MailSend" }], { ...icons,
      "io.kestra.plugin.ee.email.MailSend": { icon: "MAIL" } })).toBe("MAIL");
  });

  it("returns null when the engine served no icons at all", () => {
    // The degraded path: `list()` catches an icon-endpoint failure and carries
    // on with `{}`, because a missing logo is not a missing answer.
    expect(iconFor([{ cls: "io.kestra.plugin.slack.notifications.SlackExecution" }], {})).toBeNull();
  });
});
