import { useSyncExternalStore } from "react";

// Lumina's own confirmation dialog, styled like the rest of the app (instead of the Windows message box).
// `confirmDialog` can be awaited from anywhere: hooks, components, event handlers. <ConfirmDialog /> in App
// shows the request; a second request waits until the first is answered.

export type ConfirmKind = "info" | "warning" | "danger";

export interface ConfirmOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  // "danger" for actions that delete or can't be undone: the OK button turns red
  kind?: ConfirmKind;
}

export interface ConfirmRequest extends Required<ConfirmOptions> {
  id: number;
  message: string;
  resolve: (ok: boolean) => void;
}

let queue: ConfirmRequest[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [
      ...queue,
      {
        id: ++seq,
        message,
        title: options.title ?? "Lumina",
        okLabel: options.okLabel ?? "OK",
        cancelLabel: options.cancelLabel ?? "Cancel",
        kind: options.kind ?? "info",
        resolve,
      },
    ];
    emit();
  });
}

// Answers the request on screen and shows the next one, if any
export function answerConfirm(id: number, ok: boolean) {
  const request = queue.find((r) => r.id === id);
  if (!request) return;
  queue = queue.filter((r) => r.id !== id);
  emit();
  request.resolve(ok);
}

// For window-level key handlers: while a confirmation is open, its keys belong to it
export function isConfirmOpen() {
  return queue.length > 0;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConfirmRequest(): ConfirmRequest | null {
  return useSyncExternalStore(subscribe, () => queue[0] ?? null);
}
