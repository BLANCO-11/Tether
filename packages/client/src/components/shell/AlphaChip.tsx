// src/components/shell/AlphaChip.tsx — the word "Beta" and the release version, beside the product name.
//
// The version is the root package.json's, inlined at build (`next.config.mjs`), and `scripts/release.sh` sets it in the same commit it
// tags — so what the screen says is the commit that is running. The template's placeholder (0.x) is never shown as a release.
//
// The per-page disclosure banner is retired; the stage lives here only, as a
// static mark. It opens nothing and says nothing beyond the word: a control
// that looks live and is inert is the defect `ui-honesty-check.sh` exists to
// catch, so this is a span, never a button.
//
// ── ⚠ `--alpha`, never `--warn`. `--warn` means *this automation needs your
// attention*; sharing a hue with a permanent product statement is how a live
// incident stops being read. `text-micro` (10px): the doc's closed scale has
// no 9px step.
export function AlphaChip({ className = "", version = process.env.NEXT_PUBLIC_APP_VERSION }: { className?: string; version?: string }) {
  const release = version && !/^0\./.test(version) ? version : null;
  return (
    <span
      className={
        "inline-flex shrink-0 items-center rounded border border-alpha-line px-1.5 py-px font-mono " +
        "text-micro uppercase tracking-label text-alpha " +
        className
      }
    >
      Beta
      {release ? <span className="ml-1 normal-case">{release}</span> : null}
    </span>
  );
}
