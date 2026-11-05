"use client";

import { useMemo, useState } from "react";
import { usePermissionCatalogue, labelFor, describeFor, groupByPreset } from "./permission-catalogue";
import { useCan } from "./Can";
import { PermissionBand } from "./PermissionBand";
import type { Permission } from "@/lib/types";

/**
 * Compose a role from the permission catalogue.
 *
 * ⚠ **THE LIST IS THE SERVER'S, AND THAT IS THE POINT.** A hand-written list here could
 * offer a permission the server would refuse to store, or omit one it supports — and
 * either way the screen would look authoritative. There is deliberately no `permissions`
 * table on the server for the same reason: a row naming something the code does not
 * implement is a grant that reads as real and enforces nothing.
 *
 * ⚠ **A permission the AUTHOR does not hold is shown DISABLED, not hidden** (FR-009).
 * The server refuses `role_exceeds_granter` either way; hiding would leave somebody
 * composing a role and quietly wondering why a permission they have seen elsewhere is
 * not on the list. Disabled-with-a-reason is a next step; absent is a mystery.
 *
 * ⚠ **Three states.** An unreadable catalogue renders as *"we could not read the
 * catalogue"* — never as an empty list, which would say "there are no permissions".
 */
export function RoleEditor({
  initialName = "",
  initialDescription = "",
  initialPermissions = [],
  busy = false,
  onSave,
  onCancel,
}: {
  initialName?: string;
  initialDescription?: string;
  initialPermissions?: Permission[];
  busy?: boolean;
  onSave: (input: { name: string; description: string; permissions: Permission[] }) => void;
  onCancel?: () => void;
}) {
  const catalogue = usePermissionCatalogue();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [chosen, setChosen] = useState<Set<string>>(new Set(initialPermissions));

  /**
   * ⚠ **BANDED BY PRESET, not one list of 38** — the same `groupByPreset` the member
   * drawer reads, because two bandings of one catalogue is how they come to disagree
   * about which role carries what. It is a partition, so composing a role still reaches
   * every permission in the tier; see the function for why the subtraction is cumulative.
   *
   * ⚠ **Each band is collapsed unless it already holds something chosen** — see the
   * `defaultOpen` note at the call site, and `PermissionBand` for why the body unmounts.
   *
   * ⚠ What it does NOT add is a "select everything an approver has" control. A custom
   * role that exactly equals a preset is a duplicate of a preset with a different name,
   * and the point of a custom role is the cases the presets do not cover.
   */
  const groups = useMemo(() => groupByPreset(catalogue.data, "workspace"), [catalogue.data]);

  const toggle = (key: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (catalogue.loading) {
    return <p className="text-sm text-muted">Reading the permission catalogue…</p>;
  }

  // ⚠ The third state. NOT an empty list.
  if (catalogue.error) {
    return (
      <p className="text-sm text-warn" data-testid="catalogue-unreadable">
        We could not read the permission catalogue, so there is nothing to choose from
        here. This is not a statement that there are no permissions — the check did not
        run.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <label className="block text-sm">
        <span className="text-text">Name</span>
        <input
          className="mt-1 w-full rounded border border-line px-2 py-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Role name"
        />
      </label>
      <label className="block text-sm">
        <span className="text-text">Description</span>
        <input
          className="mt-1 w-full rounded border border-line px-2 py-1"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Role description"
        />
      </label>

      <fieldset className="space-y-5">
        <legend className="text-sm text-text">Permissions</legend>
        {groups.map((group) => {
          const picked = group.permissions.filter((k) => chosen.has(k)).length;
          return (
            <PermissionBand
              key={group.key}
              bandKey={group.key}
              label={group.label}
              hint={group.hint}
              summary={`${picked} of ${group.permissions.length}`}
              /**
               * ⚠ **A band holding something already chosen starts OPEN.** Editing an
               * existing role behind three closed heads would hide the very thing being
               * edited; the counts would say `4 of 19` and the boxes producing that 4
               * would be a click away. A new role picks nothing, so every band starts
               * closed there — the default falls out of the data rather than being a
               * second rule about which screen this is.
               */
              defaultOpen={picked > 0}
            >
              <div className="space-y-2">
                {group.permissions.map((key) => (
                  <PermissionCheckbox
                    key={key}
                    permissionKey={key}
                    label={labelFor(catalogue.data, key)}
                    description={describeFor(catalogue.data, key)}
                    checked={chosen.has(key)}
                    onToggle={() => toggle(key)}
                  />
                ))}
              </div>
            </PermissionBand>
          );
        })}
      </fieldset>

      <div className="flex gap-2">
        <button
          className="rounded bg-accent px-3 py-1 text-sm text-on-accent disabled:opacity-50"
          disabled={busy || !name.trim() || chosen.size === 0}
          onClick={() =>
            onSave({ name: name.trim(), description, permissions: [...chosen] })
          }
        >
          Save role
        </button>
        {onCancel ? (
          <button className="rounded border border-line px-3 py-1 text-sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One checkbox, disabled when the AUTHOR does not hold that permission.
 *
 * ⚠ FR-009 lives on the server — this only stops somebody composing a role that will be
 * refused. The refusal names the offending permission and never lists what the caller
 * holds, and so does this.
 */
function PermissionCheckbox({
  permissionKey,
  label,
  description,
  checked,
  onToggle,
}: {
  permissionKey: string;
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const { allowed, unreadable } = useCan(permissionKey);
  // ⚠ Unreadable leaves it ENABLED: the server decides, and disabling on a failed check
  // would refuse on the strength of a network error.
  const blocked = !allowed && !unreadable;
  return (
    <div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={checked}
          disabled={blocked}
          onChange={onToggle}
          aria-label={label}
        />
        <span>
          <span className={blocked ? "text-dim" : "text-text"}>{label}</span>
          {description ? <span className="block text-xs text-muted">{description}</span> : null}
          {blocked ? (
            <span className="block text-xs text-dim" data-testid={`blocked-${permissionKey}`}>
              You do not hold this, so you cannot put it in a role.
            </span>
          ) : null}
        </span>
      </label>
    </div>
  );
}
