// src/app/page.tsx — the root route sends people into the app; the shell layout
// then checks the session and bounces to /login if needed.
//
// ⚠ **`/home` is deleted and `/dashboard` is the landing page** (2026-08-06,
// `ui-upgrade` D-81). This is the THIRD answer to that question — deleted
// 2026-08-04, restored 2026-08-05, deleted again here — and all three stay
// readable rather than being tidied into one: a reader who finds only the latest
// answer cannot tell whether the question was hard or whether somebody was
// careless. `CLAUDE.md` carries the superseded bullet.
//
// Two pages competing to be the first thing you see means neither is trusted as
// the place where the truth is. `/dashboard` wins because its numbers are the
// ones people come back for; `/home`'s were a softer copy of the same figures.
//
// Every landing path points at `/dashboard` now — this redirect, `proxy.ts`'s (`middleware.ts` before Next 16)
// already-signed-in bounce, both sign-in buttons, and the sidebar logo. A missed
// one is a 404 on the first screen after sign-in.
import { redirect } from "next/navigation";

export default function Root() {
  redirect("/dashboard");
}
