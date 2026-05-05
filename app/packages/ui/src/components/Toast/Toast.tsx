import { useEffect, useRef, useState } from "react";
import type { Toast as ToastT } from "./types.js";
import { useToastStore } from "./useToast.js";

const variantStyles = {
  success: {
    border: "border-green-500/40",
    bg: "bg-green-500/10",
    icon: "text-green-600 dark:text-green-300",
    iconChar: "✓",
  },
  error: {
    border: "border-red-500/40",
    bg: "bg-red-500/10",
    icon: "text-red-600 dark:text-red-300",
    iconChar: "✕",
  },
  warning: {
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
    icon: "text-amber-600 dark:text-amber-300",
    iconChar: "!",
  },
  info: {
    border: "border-blue-500/40",
    bg: "bg-blue-500/10",
    icon: "text-blue-600 dark:text-blue-300",
    iconChar: "i",
  },
} as const;

interface ToastRowProps {
  toast: ToastT;
}

export function ToastRow({ toast }: ToastRowProps) {
  const dismiss = useToastStore((s) => s.dismiss);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.duration);
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    if (paused || !Number.isFinite(toast.duration)) return;
    startedAtRef.current = Date.now();
    const timer = setTimeout(() => dismiss(toast.id), remainingRef.current);
    return () => {
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
      clearTimeout(timer);
    };
  }, [paused, dismiss, toast.id, toast.duration]);

  const style = variantStyles[toast.variant];

  return (
    <div
      role="status"
      aria-live={toast.variant === "error" ? "assertive" : "polite"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={`flex items-start gap-3 rounded-lg border ${style.border} ${style.bg} bg-surface-raised p-3 shadow-lg backdrop-blur min-w-[300px] max-w-[420px]`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-bold text-xs ${style.icon}`}
        aria-hidden
      >
        {style.iconChar}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-on-surface">{toast.message}</p>
        {toast.description && (
          <p className="mt-0.5 text-xs text-on-surface-secondary break-words">
            {toast.description}
          </p>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              dismiss(toast.id);
            }}
            className="mt-2 text-xs font-medium text-accent hover:text-accent-hover transition-colors"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss"
        className="shrink-0 text-on-surface-tertiary hover:text-on-surface transition-colors text-sm leading-none"
      >
        ✕
      </button>
    </div>
  );
}
