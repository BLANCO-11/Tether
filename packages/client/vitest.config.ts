/**
 * The client's first test runner.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `packages/client` had no tests at all, and that is not a neutral fact. It is
 * how `use(params)` — the Next 15 form of unwrapping route params, against the
 * Next 14 this repo pins — broke EVERY `/flows/[id]` and `/runs/[id]` load for
 * two days while 400+ server-side assertions stayed green. `e2e:ui` only speaks
 * HTTP, `ui-honesty-check.sh` greps source, and the vitest suites all live in
 * `packages/server`. Nothing exercised a line of client code.
 *
 * It started narrow — the pure data-seam modules (`lib/adapters.ts` and friends),
 * where silent data loss lives — and grew the rendering half in programme 3
 * Stage 2. `src/app/routes.smoke.test.tsx` and `src/components/components.smoke
 * .test.tsx` render every page and every flow component in jsdom, which is the
 * layer that would have caught `use(params)` on the first run.
 *
 * ⚠ The DOM environment is set PER FILE with a `// @vitest-environment jsdom`
 * pragma rather than globally. jsdom costs about 400ms of setup per file, and
 * the pure suites — which are the ones people run in a watch loop — need none of
 * it. Making it the default would make the fast tests slow to buy nothing.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * ⚠ **FAIL LOUDLY ON AN OLD NODE, because the failure mode was SILENT and it
 * cost this suite its entire rendering half.**
 *
 * Measured 2026-08-18 on Node 20.20.0: all **21** files carrying the
 * `@vitest-environment jsdom` pragma failed to load with
 * `TypeError: webidl.util.markAsUncloneable is not a function` (jsdom 30 calling
 * into undici 8.9, which needs a Node 22 API). Vitest reported them as
 * "Unhandled Errors" and then printed **`Test Files 30 passed`** — so the summary
 * line a person actually reads said green while `routes.smoke.test.tsx`,
 * `FlowCanvas.test.tsx`, `ChatPanel.test.tsx` and 18 others had not executed a
 * single assertion. On Node 22 the same command runs **51 files / 709 tests**.
 *
 * That is I-38 at the largest scale in this repo — a whole layer of controls that
 * could not fail — and it is worse than a missing suite, because
 * `ui-honesty-check.sh` asserts every page under `(app)` HAS a render test and
 * was satisfied the whole time: it greps, and greps pass over a file that never
 * runs.
 *
 * Both `package.json`s have said `"node": ">=22"` throughout. A declaration is
 * not a control, so this throws — at config load, where the message can name the
 * version, the consequence and the number of files at stake, rather than leaving
 * 21 stack traces above a green count.
 */
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  throw new Error(
    `This suite needs Node >= 22 (package.json "engines" says so); this is ${process.versions.node}. ` +
      "Refusing to run rather than silently skipping every jsdom file: on Node 20, jsdom 30 + undici " +
      "8.9 throw `webidl.util.markAsUncloneable is not a function` at environment setup, all 21 " +
      "render-test files fail to load, and vitest still prints a green `Test Files N passed` count " +
      "for the pure suites that did run.",
  );
}

export default defineConfig({
  // Next compiles JSX with the automatic runtime; `tsconfig.json` says
  // `"jsx": "preserve"` because Next owns that step. Vitest has no Next, so it
  // has to be told — without this every `.tsx` suite fails with
  // "React is not defined", which reads like a missing import in the component
  // rather than a missing setting here.
  esbuild: { jsx: "automatic" },
  resolve: {
    // Mirror the `@/*` path alias from tsconfig.json. Without it every import
    // inside the modules under test fails to resolve and the suite reports
    // "0 tests" rather than a missing alias — which reads like an empty file.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // React 18 + Testing Library need this to avoid `act()` warnings being
    // promoted into noise on every async state settle.
    globals: false,
    // The render suites import whole route trees; the first one to be
    // transformed pays for most of the app. 5s is not enough on a cold cache and
    // the failure is a timeout, which reads like a hung component.
    testTimeout: 15_000,
  },
});
