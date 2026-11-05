/**
 * Read `GET /api/signals` and exit with a code a scheduler can act on.
 * archive/GAPS.md §6.1b · D-71
 *
 *   pnpm --filter @foundry/server signals
 *   pnpm --filter @foundry/server signals --json
 *
 * ── Why a CLI is half of closing §6.1b ───────────────────────────────────────
 *
 * §6.1 built the endpoint and the entry that replaced it said, correctly,
 * *"nothing reads it yet"*. "A reader" turned out to be two different things and
 * only one of them is a screen:
 *
 *   * **A person** needs to see the four signals when they go looking. That is
 *     `SignalsPanel` on `/dashboard`.
 *   * **A machine** needs to notice when nobody is looking, which is the entire
 *     point of §6.1 — the four things it reports are *"the four things that fail
 *     with nothing raising an error anywhere"*. A screen cannot do that.
 *
 * This is the machine half, and it is deliberately a CLI with an exit code
 * rather than an integration with a named alerting product. Every deployment
 * already has something that can run a command on a timer and page on a non-zero
 * exit — cron, a Kubernetes CronJob, a CI schedule, systemd. Picking a vendor
 * here would be inventing a deployment this repo does not have, and the wrapper
 * would then be the thing nobody wired up.
 *
 * ── The exit codes, and why `unknown` does not page ──────────────────────────
 *
 *   0  ok, or unknown
 *   1  warn or alarm — a signal has something to say
 *   2  the endpoint could not be read at all
 *
 * ⚠ **`unknown` exits 0 on purpose**, and it is the decision most likely to be
 * questioned. `unknown` means a signal had nothing to go on — a workspace with
 * no scheduled flows has no firing history to judge. The service already ranks
 * it BELOW `warn` for the same reason (D-66): a signal that cannot see must not
 * shout over one that can. Paging on it would produce a permanent low-grade
 * alarm on every fresh deployment, and a permanent alarm is an alarm people
 * mute — after which the real one is muted too.
 *
 * ⚠ **Exit 2 is distinct from exit 1, and that matters more than it looks.**
 * "The system is unhealthy" and "I could not find out whether the system is
 * healthy" need different responses, and collapsing them means a monitoring
 * outage reads as a product outage — or, far worse the other way, a product
 * outage gets acknowledged as a flaky check.
 */
import { SignJWT } from "jose";
import { config } from "../config/index.js";

const JSON_OUT = process.argv.includes("--json");
const BASE = process.env.FOUNDRY_API_BASE ?? "http://localhost:4000";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const PAINT: Record<string, (s: string) => string> = {
  ok: c.ok,
  unknown: c.dim,
  warn: c.warn,
  alarm: c.bad,
};

interface Signal {
  name: string;
  state: string;
  detail: string;
  caveat: string;
  facts?: Record<string, unknown>;
}

async function main() {
  const key = config.parentApiKey;
  if (!key) {
    // Refused rather than attempted. An unauthenticated call gets a 401, which
    // would be reported as exit 2 — "the system is unreachable" — when the real
    // problem is this process's own configuration.
    console.error("PARENT_API_KEY is not set; cannot read /api/signals");
    process.exit(2);
  }

  /**
   * ⚠ **`/api/signals` NOW NEEDS `platform.signals.read`, SO THIS CLI HAS TO NAME A
   * PERSON** (RBAC T074). The API key authorises the request; it does not name anybody,
   * and a platform permission is a question about a person. Without an identity this
   * would 401 and be reported as exit 2 — *"the system is unreachable"* — when the real
   * problem is this process's own configuration, and a scheduler would page somebody for
   * a healthy deployment.
   *
   * It presents the FIRST entry of `SUPER_ADMIN_EMAILS`, the same thing `e2e:ui` does for
   * its membership step, because the allowlist is the one authority that exists before
   * anybody has been granted anything.
   *
   * ⚠ **Minting an identity here is acceptable ONLY because this is a READ.** CLAUDE.md's
   * rule — *do not mint an identity with `RUNTIME_JWT_SECRET` to change a setting from a
   * script, because that records a config change against a person who did not make it* —
   * is about writes. This endpoint records nothing. Do not copy this into a script that
   * writes.
   */
  const allowlisted = [...config.superAdminEmails][0];
  if (!allowlisted) {
    console.error(
      "SUPER_ADMIN_EMAILS is not set, so this check cannot name a person and " +
        "GET /api/signals needs the platform.signals.read permission. This is a " +
        "configuration problem in THIS process, not an unhealthy deployment.",
    );
    process.exit(2);
  }
  const identity = await new SignJWT({
    sub: allowlisted,
    email: allowlisted,
    name: "signals-check",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(config.identity.secret));

  let body: { state: string; checkedAt: string; signals: Signal[] };
  try {
    const res = await fetch(`${BASE}/api/signals`, {
      headers: { "x-api-key": key, "x-foundry-identity": identity },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // ⚠ 401/403 is a configuration problem here, not an unhealthy system. Say which,
      // because exit 2 means "I could not find out" and a scheduler acts on that.
      if (res.status === 401 || res.status === 403) {
        console.error(
          `GET /api/signals → ${res.status}. This check presented the first entry of ` +
            `SUPER_ADMIN_EMAILS and was refused, so the allowlist on the API SERVER does ` +
            `not match this process's. The deployment's health is unknown, not bad.`,
        );
      } else {
        console.error(`GET /api/signals → ${res.status}`);
      }
      process.exit(2);
    }
    body = (await res.json()) as typeof body;
  } catch (e) {
    console.error(`GET /api/signals failed: ${(e as Error).message}`);
    process.exit(2);
  }

  if (JSON_OUT) {
    // For a scheduler that wants to forward the payload somewhere. Printed
    // whole, including every caveat — a monitoring pipeline that strips the
    // caveats reproduces the false-green problem one layer up.
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(`\nsignals  ${PAINT[body.state]!(body.state.toUpperCase())}  ${c.dim(body.checkedAt)}\n`);
    for (const s of body.signals) {
      console.log(`  ${(PAINT[s.state] ?? c.dim)(s.state.padEnd(7))} ${s.name}`);
      console.log(`          ${s.detail}`);
      // ⚠ Printed on every signal, not only the unhappy ones. What a signal
      // CANNOT see is exactly the thing a reader will otherwise assume it can.
      console.log(`          ${c.dim(s.caveat)}`);
    }
    console.log();
  }

  const paging = body.state === "warn" || body.state === "alarm";
  process.exit(paging ? 1 : 0);
}

main().catch((e) => {
  console.error(`signals check failed: ${(e as Error).stack ?? e}`);
  process.exit(2);
});
