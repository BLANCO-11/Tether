// src/lib/places.ts — where an item lives, as a list filter (sharing-boundaries phase 6).
//
// Three places and the same three words everywhere: My space, a project, the Workspace. Read off the item's own fields
// as the server sent them — the server decided what this person may see; this only groups it.

export type WhereFilter = "any" | "mine" | "project" | "workspace";

export const WHERE_FILTERS: ReadonlyArray<{ key: WhereFilter; label: string }> = [
  { key: "any", label: "Anywhere" },
  { key: "mine", label: "My space" },
  { key: "project", label: "Projects" },
  { key: "workspace", label: "Workspace" },
];

type Placed = { visibility?: string | null; projectId?: string | null };

export function whereOf(item: Placed): Exclude<WhereFilter, "any"> {
  if (item.projectId) return "project";
  return item.visibility === "public" ? "workspace" : "mine";
}

export function inWhere(item: Placed, filter: WhereFilter): boolean {
  return filter === "any" || whereOf(item) === filter;
}
