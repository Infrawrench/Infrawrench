import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createPopper } from "@popperjs/core";
import { useGT } from "gt-react";
import { WarningIcon } from "./icons/ChromeIcons.js";
import { statusIssueTone } from "./schema-tokens.js";

export type IssueTone = "warning" | "danger";

/**
 * The one way the interface flags that something needs attention: a warning
 * triangle whose tooltip says why. Healthy and neutral states show nothing, so
 * the triangle only appears when there is something to read.
 *
 * The tooltip is positioned with Popper rather than a native `title`, which
 * waits a second or more, cannot be styled, and never appears at all for some
 * input methods. It renders into a portal so a sidebar's `overflow: hidden`
 * cannot clip it, and into the nearest open `<dialog>` when there is one,
 * because a native modal sits in the top layer above anything in `body`.
 */
export function IssueIndicator({
  reason,
  tone = "warning",
  size = 12,
  className = "",
}: {
  reason: string;
  tone?: IssueTone | undefined;
  size?: number | undefined;
  className?: string | undefined;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Element | null>(null);
  const tooltipId = useId();

  // Native listeners: the triangle is an image, not a control, so it takes no
  // focus of its own (it often sits inside a row's button). Screen readers get
  // the reason from `aria-label`; the tooltip is for pointers.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const show = () => setContainer(anchor.closest("dialog[open]") ?? document.body);
    const hide = () => setContainer(null);
    anchor.addEventListener("mouseenter", show);
    anchor.addEventListener("mouseleave", hide);
    return () => {
      anchor.removeEventListener("mouseenter", show);
      anchor.removeEventListener("mouseleave", hide);
    };
  }, []);

  useEffect(() => {
    if (!container) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContainer(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [container]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!container || !anchor || !tooltip) return;
    const popper = createPopper(anchor, tooltip, {
      placement: "top",
      modifiers: [
        { name: "offset", options: { offset: [0, 6] } },
        { name: "preventOverflow", options: { padding: 8 } },
        { name: "flip", options: { fallbackPlacements: ["bottom", "right", "left"] } },
      ],
    });
    return () => popper.destroy();
  }, [container]);

  return (
    <>
      <span
        ref={anchorRef}
        role="img"
        aria-label={reason}
        aria-describedby={container ? tooltipId : undefined}
        className={`inline-flex flex-shrink-0 ${tone === "danger" ? "text-danger" : "text-warning"} ${className}`}
      >
        <WarningIcon size={size} />
      </span>
      {container &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className="z-50 max-w-xs rounded-md border border-border-strong bg-surface-overlay px-2 py-1 text-xs text-on-surface shadow-lg pointer-events-none whitespace-pre-wrap break-words"
          >
            {reason}
          </div>,
          container,
        )}
    </>
  );
}

/**
 * A plugin `status-dot` status as an issue: the triangle for `error` and
 * `degraded`, nothing for anything else. `label` becomes the tooltip.
 */
export function StatusIssueIndicator({
  status,
  label,
  size,
  className,
}: {
  status: string | undefined;
  label?: string | undefined;
  size?: number | undefined;
  className?: string | undefined;
}) {
  const gt = useGT();
  const tone = statusIssueTone(status);
  if (!tone) return null;
  return (
    <IssueIndicator
      tone={tone}
      size={size}
      className={className}
      reason={label ?? (tone === "danger" ? gt("Error") : gt("Degraded"))}
    />
  );
}
