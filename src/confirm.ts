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
  // A tick box under the message ("Don't ask again"), or none
  checkLabel: string | null;
  resolve: (ok: boolean, checked: boolean) => void;
}

let queue: ConfirmRequest[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return ask(message, options, null).then((a) => a.ok);
}

// A confirmation with a tick box ("Don't ask again"): says whether it was confirmed and whether the box was ticked
export function confirmWithCheck(message: string, checkLabel: string, options: ConfirmOptions = {}): Promise<{ ok: boolean; checked: boolean }> {
  return ask(message, options, checkLabel);
}

function ask(message: string, options: ConfirmOptions, checkLabel: string | null): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((done) => {
    const resolve = (ok: boolean, checked: boolean) => done({ ok, checked });
    queue = [
      ...queue,
      {
        id: ++seq,
        message,
        title: options.title ?? "Lumina",
        okLabel: options.okLabel ?? "OK",
        cancelLabel: options.cancelLabel ?? "Cancel",
        kind: options.kind ?? "info",
        checkLabel,
        resolve,
      },
    ];
    emit();
  });
}

// Answers the request on screen and shows the next one, if any
export function answerConfirm(id: number, ok: boolean, checked = false) {
  const request = queue.find((r) => r.id === id);
  if (!request) return;
  queue = queue.filter((r) => r.id !== id);
  emit();
  request.resolve(ok, checked);
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
