// src/components/data/AssetTree.tsx — recursive renderer for a discovered metadata tree
// (db_schema → table → column), in the frozen mock's tree idiom (D-02): a schema
// row with a table-count badge, table rows with column-count badges.
//
// A table expands its columns IN PLACE — a compact Column/Type/Null?/Key grid
// built from the same node children the "View schema" modal reads — so the
// schema is scannable without a modal round-trip per table. The modal stays:
// it carries the explanatory sentence the inline grid does not.
"use client";

import { useState } from "react";
import type { AssetNode } from "@/lib/types";
import { ChevronDown, ChevronRight, Table, Database } from "@/components/ui/icons";

export function AssetTree({ nodes, onPreview }: { nodes: AssetNode[]; onPreview?: (node: AssetNode) => void }) {
  if (!nodes.length) return <p className="text-sm text-muted">No metadata discovered yet.</p>;
  return (
    <ul>
      {nodes.map((n, i) => <AssetRow key={(n.asset_id ?? n.id ?? n.name) + i} node={n} depth={0} onPreview={onPreview} />)}
    </ul>
  );
}

type ColumnRef = { name: string; type: string; nullable: boolean; primaryKey: boolean; foreignKey?: string };

function columnsOf(node: AssetNode): ColumnRef[] {
  return (node.children ?? [])
    .filter((k) => k.asset_type === "column")
    .map((c) => {
      const a = (c.attributes ?? {}) as Record<string, unknown>;
      return {
        name: c.name,
        type: String(a.type ?? "unknown"),
        nullable: a.nullable !== false,
        primaryKey: a.primary_key === true,
        foreignKey: typeof a.foreign_key === "string" ? a.foreign_key : undefined,
      };
    });
}

function AssetRow({ node, depth, onPreview }: { node: AssetNode; depth: number; onPreview?: (node: AssetNode) => void }) {
  const [open, setOpen] = useState(depth === 0);
  const kids = node.children ?? [];
  const isColumn = node.asset_type === "column";
  const isTable = node.asset_type === "table";
  const id = node.asset_id ?? node.id;

  if (isColumn) {
    // Defensive only: tables render their columns as the inline grid below, so
    // a column reaching here has no table parent — keep the mock's line shape.
    const type = node.attributes?.type as string | undefined;
    const fk = node.attributes?.foreign_key as string | undefined;
    return (
      <li className="flex items-center gap-2 px-2 py-1 text-xs text-muted">
        <span className="min-w-0 truncate font-mono text-text">{node.name}</span>
        <span className="text-dim">·</span>
        <span className="truncate font-mono text-dim">{type ?? "unknown"}</span>
        {fk && (
          <span className="truncate font-mono text-dim" title={fk}>
            → {fk}
          </span>
        )}
      </li>
    );
  }

  const tableCount = kids.filter((k) => k.asset_type === "table").length;
  const columns = isTable ? columnsOf(node) : [];
  // The count sits in a fixed gutter so names never collide with it (`ti…`
  // read as a broken name when the two shared one flex line).
  const count = isTable ? columns.length : tableCount;
  const countLabel = isTable ? `${count} ${count === 1 ? "col" : "cols"}` : `${count}`;

  return (
    <li>
      <div className="flex min-h-[34px] items-center gap-1 rounded-md px-2 py-1.5 hover:bg-surface-2">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span className="shrink-0 text-muted">{kids.length ? (open ? <ChevronDown s={14} /> : <ChevronRight s={14} />) : <span className="inline-block w-3.5" />}</span>
          <span className="shrink-0 text-accent">{isTable ? <Table s={14} /> : <Database s={14} />}</span>
          <span className="min-w-0 flex-1 truncate text-body text-text" title={node.name}>{node.name}</span>
          {count > 0 && (
            <span className="w-[52px] shrink-0 text-right font-mono text-micro text-dim">
              {countLabel}
            </span>
          )}
        </button>
        {/* A text link, not a bordered pill: always visible (findable) at a
            third of the width, so the name keeps the line. */}
        {isTable && onPreview && id && (
          <button
            onClick={() => onPreview(node)}
            aria-label={`View schema of ${node.name}`}
            title={`View schema of ${node.name}`}
            className="shrink-0 px-1 text-[11px] text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            View schema
          </button>
        )}
      </div>
      {open && isTable && columns.length > 0 && (
        <div className="ml-[18px] border-l border-line py-1 pl-3 pr-1">
          <div
            role="table"
            aria-label={`Columns of ${node.name}`}
            className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1 font-mono text-[11px] leading-relaxed"
          >
            <span role="columnheader" className="truncate font-sans text-[10px] uppercase tracking-label text-dim">Column</span>
            <span role="columnheader" className="truncate font-sans text-[10px] uppercase tracking-label text-dim">Type</span>
            <span role="columnheader" className="font-sans text-[10px] uppercase tracking-label text-dim">Null?</span>
            <span role="columnheader" className="truncate font-sans text-[10px] uppercase tracking-label text-dim">Key</span>
            {columns.map((c) => (
              <AssetColumnCells key={c.name} column={c} />
            ))}
          </div>
        </div>
      )}
      {open && !isTable && kids.length > 0 && (
        <ul className="ml-[18px] border-l border-line pl-2">
          {kids.map((k, i) => <AssetRow key={(k.asset_id ?? k.id ?? k.name) + i} node={k} depth={depth + 1} onPreview={onPreview} />)}
        </ul>
      )}
    </li>
  );
}

function AssetColumnCells({ column }: { column: ColumnRef }) {
  return (
    <>
      <span role="cell" className="truncate text-text" title={column.name}>{column.name}</span>
      <span role="cell" className="truncate text-dim" title={column.type}>{column.type}</span>
      <span role="cell" className="text-dim">{column.nullable ? "yes" : "no"}</span>
      <span role="cell" className="min-w-0 truncate text-dim" title={column.primaryKey ? "primary key" : (column.foreignKey ?? "")}>
        {column.primaryKey ? "PK" : column.foreignKey ? `→ ${column.foreignKey}` : ""}
      </span>
    </>
  );
}
