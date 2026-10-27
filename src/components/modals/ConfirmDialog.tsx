import { AlertTriangle, HelpCircle, Trash2 } from "lucide-react";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { answerConfirm, useConfirmRequest, type ConfirmKind, type ConfirmRequest } from "../../confirm";

const LOOK: Record<ConfirmKind, { icon: typeof HelpCircle; chip: string; ok: string }> = {
  info: {
    icon: HelpCircle,
    chip: "bg-emerald-500/10 border-emerald-500/25 text-emerald-300",
    ok: "bg-emerald-600 hover:bg-emerald-500 border-emerald-500",
  },
  warning: {
    icon: AlertTriangle,
    chip: "bg-amber-500/10 border-amber-500/25 text-amber-300",
    ok: "bg-emerald-600 hover:bg-emerald-500 border-emerald-500",
  },
  danger: {
    icon: Trash2,
    chip: "bg-red-500/10 border-red-500/25 text-red-300",
    ok: "bg-red-600 hover:bg-red-500 border-red-500",
  },
};

// The confirmation asked for with confirmDialog(), on top of everything else. Enter confirms, Escape or a
// click outside cancels. For "danger" the Cancel button has the focus, so a quick Enter deletes nothing.
export default function ConfirmDialog() {
  const request = useConfirmRequest();
  // Keyed per request, so a queued confirmation gets its own focus when it follows another
  return request ? <ConfirmPanel key={request.id} request={request} /> : null;
}

function ConfirmPanel({ request }: { request: ConfirmRequest }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true);
  const look = LOOK[request.kind];
  const Icon = look.icon;
  const answer = (ok: boolean) => answerConfirm(request.id, ok);
  const paragraphs = request.message.split(/\n{2,}/);

  return (
    <div onClick={() => answer(false)} className="fixed inset-0 z-[99997] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6 select-none">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="lumina-confirm-title"
        aria-describedby="lumina-confirm-message"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Keys stay with this dialog, not with the dialog or grid underneath
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            answer(false);
          } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            answer(request.kind !== "danger");
          }
        }}
        className="lumina-tour-enter bg-raised border border-zinc-800 rounded-2xl shadow-2xl w-[min(460px,100%)] flex flex-col outline-none"
      >
        <div className="flex gap-4 px-6 pt-6 pb-5">
          <span className={`w-9 h-9 rounded-xl border grid place-items-center shrink-0 ${look.chip}`}>
            <Icon className="w-4 h-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="lumina-confirm-title" className="text-[15px] font-semibold text-zinc-100 leading-snug">
              {request.title}
            </h2>
            <div id="lumina-confirm-message" className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed text-zinc-400 select-text">
              {paragraphs.map((p, i) => (
                <p key={i} className="whitespace-pre-line break-words">
                  {p}
                </p>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-zinc-800">
          <button
            autoFocus={request.kind === "danger"}
            onClick={() => answer(false)}
            className="px-3.5 py-1.5 rounded-lg text-[12px] text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-500"
          >
            {request.cancelLabel}
          </button>
          <button
            autoFocus={request.kind !== "danger"}
            onClick={() => answer(true)}
            className={`px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 ${look.ok}`}
          >
            {request.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
