import { useGT } from "gt-react";
import { useToastStore } from "./useToast.js";
import { ToastRow } from "./Toast.js";

export function Toaster() {
  const gt = useGT();
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-label={gt("Notifications")}
      className="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastRow toast={t} />
        </div>
      ))}
    </div>
  );
}
