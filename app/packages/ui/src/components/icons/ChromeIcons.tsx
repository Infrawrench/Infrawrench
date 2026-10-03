import type { ReactNode } from "react";

/**
 * Interface chrome icons: chevrons, arrows, the settings cog and friends.
 *
 * These replace Unicode glyphs (▶ ◀ ▾ ‹ ↑ ↗ ⚙ ☁) that used to stand in for
 * icons. The OS picks the font for those, so they render at different weights
 * and sizes on macOS, Windows and Linux, and some (▶, ◀, ⚙, ☁) resolve to a
 * full colour emoji that ignores `color` entirely. Paths are from Lucide
 * (https://lucide.dev, ISC licence), on the same 24x24, 2px stroke grid as the
 * rest of `components/icons/`, and they inherit `currentColor` so hover and
 * theme colours keep working.
 */
export interface ChromeIconProps {
  className?: string | undefined;
  size?: number | undefined;
}

export type IconDirection = "up" | "down" | "left" | "right";

function StrokeIcon({ className, size = 14, children }: ChromeIconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

const CHEVRON_PATHS: Record<IconDirection, string> = {
  up: "m18 15-6-6-6 6",
  down: "m6 9 6 6 6-6",
  left: "m15 18-6-6 6-6",
  right: "m9 18 6-6-6-6",
};

/** Disclosure, dropdown and pagination chevron (Lucide `chevron-*`). */
export function ChevronIcon({
  direction = "down",
  ...props
}: ChromeIconProps & { direction?: IconDirection }) {
  return (
    <StrokeIcon {...props}>
      <path d={CHEVRON_PATHS[direction]} />
    </StrokeIcon>
  );
}

const ARROW_PATHS: Record<IconDirection, [string, string]> = {
  up: ["m5 12 7-7 7 7", "M12 19V5"],
  down: ["M12 5v14", "m19 12-7 7-7-7"],
  left: ["m12 19-7-7 7-7", "M19 12H5"],
  right: ["M5 12h14", "m12 5 7 7-7 7"],
};

/** Back links and move up/down controls (Lucide `arrow-*`). */
export function ArrowIcon({
  direction = "left",
  ...props
}: ChromeIconProps & { direction?: IconDirection }) {
  const [a, b] = ARROW_PATHS[direction];
  return (
    <StrokeIcon {...props}>
      <path d={a} />
      <path d={b} />
    </StrokeIcon>
  );
}

/** Settings cog (Lucide `settings`). */
export function SettingsIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </StrokeIcon>
  );
}

/** Collapse the sidebar (Lucide `panel-left-close`). */
export function PanelLeftCloseIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </StrokeIcon>
  );
}

/** Expand the sidebar (Lucide `panel-left-open`). */
export function PanelLeftOpenIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </StrokeIcon>
  );
}

/** Opens in a new window or the system browser (Lucide `external-link`). */
export function ExternalLinkIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </StrokeIcon>
  );
}

/** Reload (Lucide `rotate-cw`). */
export function RefreshIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </StrokeIcon>
  );
}

/** Upload (Lucide `upload`). */
export function UploadIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </StrokeIcon>
  );
}

/** Download (Lucide `download`). */
export function DownloadIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </StrokeIcon>
  );
}

/** Cloud sign-in (Lucide `cloud`). */
export function CloudIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </StrokeIcon>
  );
}

/** Close, dismiss or remove (Lucide `x`). */
export function CloseIcon(props: ChromeIconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </StrokeIcon>
  );
}
