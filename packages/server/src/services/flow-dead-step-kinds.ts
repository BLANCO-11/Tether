/**
 * The step kinds pure enough that output nobody reads is waste: they have no
 * effect of their own, so a step of one of these kinds that nothing reads does
 * nothing but cost a run.
 *
 * ONE definition, read by the two checks that ask the question at two levels:
 * `checkUnusedSteps` (a wired model — `unused_step`) and `checkSkeleton` (an
 * outline, before any wiring). The outline check exists because the wiring is
 * told to keep the outline's steps and edges exactly, so a dead step in the
 * outline cannot be fixed by wiring at all — two copies of this list would let
 * the two levels disagree about what "dead" means.
 */
export const DEAD_STEP_KINDS: Readonly<Record<string, true>> = { code: true, transform: true, query: true, datasource: true };
