// src/components/ui/MicrosoftMark.tsx — Microsoft's own logo, on the Entra ID
// sign-in button.
//
// ⚠ THIS FILE IS THE ONE PLACE IN `src/**` ALLOWED TO HOLD A COLOUR LITERAL,
// and `scripts/ui-honesty-check.sh` exempts it BY NAME rather than by pattern.
//
// The four hexes below are not Foundry's design tokens and must never become
// them: they are a third party's registered brand mark, fixed by Microsoft's
// brand guidelines, and identical in both of our themes because the mark does
// not have a dark variant to switch to. Tokenising them would put four values
// nobody here controls into the theme map, where the next person would
// reasonably "harmonise" them with the earthy palette — at which point Foundry
// is shipping an altered version of somebody else's trademark.
//
// So the mark is quarantined in its own file, holding nothing else, and the
// exemption is that filename. Anything else needing a colour uses a token.

/** The four-square Microsoft logo, at the button's icon size. */
export function MicrosoftMark() {
  return (
    <svg
      viewBox="0 0 23 23"
      className="h-4 w-4 shrink-0"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}
