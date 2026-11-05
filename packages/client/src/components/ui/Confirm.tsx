// src/components/ui/Confirm.tsx — a confirm dialog that explains what will happen
// before a consequential action (delete, replace a secret). Nothing acts silently.
"use client";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

export function Confirm({ open, title, body, confirmLabel = "Confirm", danger, onConfirm, onClose }: {
  open: boolean; title: string; body: string; confirmLabel?: string; danger?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-muted">{body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
