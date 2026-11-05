// src/lib/bulk.ts — run one action over many items, a few at a time, and say which ones failed.
//
// Bulk delete on /chats, /flows and /resources (Files) calls the SAME single-item endpoint once per item, so every item keeps its own
// permission check and its own audit entry. A failure never stops the rest: the caller is told which items failed and
// why, and keeps them selected so the person can see what is left.

export type BulkOutcome<T> = { done: T[]; failed: Array<{ item: T; reason: string }> };

export async function runEach<T>(
  items: readonly T[],
  act: (item: T) => Promise<unknown>,
  reasonOf: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e)),
  concurrency = 4,
): Promise<BulkOutcome<T>> {
  const done: T[] = [];
  const failed: Array<{ item: T; reason: string }> = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await act(item);
        done.push(item);
      } catch (e) {
        failed.push({ item, reason: reasonOf(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { done, failed };
}

/** One toast line for a bulk outcome: "Deleted 3 chats." / "Deleted 12 of 15 chats. 3 could not be deleted: …". */
export function bulkSentence(verb: string, noun: [string, string], total: number, out: { done: unknown[]; failed: Array<{ reason: string }> }): string {
  const word = (n: number) => (n === 1 ? noun[0] : noun[1]);
  if (!out.failed.length) return `${verb} ${out.done.length} ${word(out.done.length)}.`;
  const reasons = [...new Set(out.failed.map((f) => f.reason))].slice(0, 2).join("; ");
  const head = out.done.length ? `${verb} ${out.done.length} of ${total} ${word(total)}.` : `Nothing was ${verb.toLowerCase()}.`;
  return `${head} ${out.failed.length} could not be: ${reasons}`;
}
