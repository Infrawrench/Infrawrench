import { useEffect, useRef, useState } from "react";
import { useGT } from "gt-react";
import type { Toast as ToastT } from "./types.js";
import { useToastStore } from "./useToast.js";

const variantStyles = {
  success: {
    border: "border-green-500/40",
    bg: "bg-green-500/10",
    icon: "text-success",
    iconChar: "✓",
  },
  error: {
    border: "border-red-500/40",
    bg: "bg-red-500/10",
    icon: "text-danger",
    iconChar: "✕",
  },
  warning: {
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
    icon: "text-warning",
    iconChar: "!",
  },
  info: {
    border: "border-blue-500/40",
    bg: "bg-blue-500/10",
    icon: "text-info",
    iconChar: "i",
  },
} as const;

interface ToastRowProps {
  toast: ToastT;
}

export function ToastRow({ toast }: ToastRowProps) {
  const gt = useGT();
  const dismiss = useToastStore((s) => s.dismiss);
  // Auto-dismiss pauses while hovered or while any element inside the toast
  // (action button, dismiss button) has keyboard focus.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remainingRef = useRef(toast.duration);

  useEffect(() => {
    if (paused || !Number.isFinite(toast.duration)) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => dismiss(toast.id), remainingRef.current);
    return () => {
      const elapsed = Date.now() - startedAt;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
      clearTimeout(timer);
    };
  }, [paused, dismiss, toast.id, toast.duration]);

  const style = variantStyles[toast.variant];

  return (
    <output
      aria-live={toast.variant === "error" ? "assertive" : "polite"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
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
        aria-label={gt("Dismiss")}
        className="shrink-0 text-on-surface-tertiary hover:text-on-surface transition-colors text-sm leading-none"
      >
        ✕
      </button>
    </output>
  );
}
