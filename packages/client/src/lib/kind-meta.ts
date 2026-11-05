// src/lib/kind-meta.ts — the registry's label, colour and icon, in component form.
//
// `NODE_TYPES` in `@foundry/flow-edit` is the one definition of every component
// (label, colour token, icon name). Before this file, four hand-synced tables
// (`FlowCanvas`'s KIND, `StepInspector`'s KIND_LABEL/KIND_COLOUR, `FlowReview`'s
// and `ChatWorkbench`'s copies) restated it — and had already drifted. Every
// surface that names a kind reads through here instead, so a rename lands once.
import { NODE_TYPES, type StepKind } from "@foundry/flow-edit";
import {
  Bot,
  Box,
  Check,
  Clock,
  Database,
  Fork,
  Link,
  Merge,
  RefreshCw,
  Search,
  Split,
  Table,
  Wrench,
} from "@/components/ui/icons";

type IconProps = { s?: number };
export type KindIcon = (p: IconProps) => JSX.Element;

/** The registry's `icon` strings, each wired to its component exactly once. */
export const KIND_ICONS: Record<string, KindIcon> = {
  Wrench,
  Database,
  Split,
  Box,
  Check,
  Fork,
  Merge,
  Bot,
  Link,
  Table,
  RefreshCw,
  Clock,
  Search,
};

/** What a person who knows the business calls this kind — the card, the chip, the menu. */
export function kindLabel(kind: StepKind): string {
  return NODE_TYPES[kind].label;
}

/** The `--k-*` token for this kind. Colour is never the only carrier: the word is always beside it. */
export function kindColour(kind: StepKind): string {
  return NODE_TYPES[kind].colour;
}

/** The registry's `icon` name as a component. */
export function kindIcon(kind: StepKind): KindIcon {
  // Unreachable by contract: every `icon` string in the frozen registry has a
  // row above. `Box` keeps the card drawable rather than crashing the canvas
  // if a future kind ever arrives without one.
  return KIND_ICONS[NODE_TYPES[kind].icon] ?? Box;
}
