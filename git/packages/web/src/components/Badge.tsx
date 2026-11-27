import type { ReactNode } from "react";
import { languageColor, type StatusState, type Visibility } from "@infrawrench/git-contract";
import { Icon, Spinner } from "./icons";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "notice" | "outline";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-on-surface-secondary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  notice: "bg-notice/15 text-notice",
  outline: "border border-border text-on-surface-muted",
};

/** A small label on a row or beside a title: a state, a kind, a count. */
export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  return (
    <Badge tone="outline">
      <Icon name={visibility === "private" ? "lock" : "globe"} size={10} />
      {visibility === "private" ? "Private" : "Public"}
    </Badge>
  );
}

const STATUS_LABEL: Record<StatusState, string> = {
  success: "Checks passed",
  failure: "Checks failed",
  error: "Checks errored",
  pending: "Checks running",
};

export const commitStatusLabel = (state: StatusState): string => STATUS_LABEL[state];

/** The glyph alone, for a control that names itself (`CommitChecks`). */
export function CommitStatusGlyph({ state, size = 13 }: { state: StatusState; size?: number }) {
  return state === "pending" ? (
    <Spinner size={size} className="text-warning" />
  ) : state === "success" ? (
    <Icon name="checkCircle" size={size} className="text-success" />
  ) : state === "failure" ? (
    <Icon name="xCircle" size={size} className="text-danger" />
  ) : (
    <Icon name="alertCircle" size={size} className="text-danger" />
  );
}

/**
 * A commit's combined status, in the glyphs the app's CI uses. Renders
 * nothing for null. Where the commit's repository is known, use
 * `CommitChecks`, which opens the list of checks.
 */
export function CommitStatusIcon({
  state,
  size = 13,
}: {
  state: StatusState | null;
  size?: number;
}) {
  if (state === null) return null;
  const label = STATUS_LABEL[state];
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex">
      <CommitStatusGlyph state={state} size={size} />
    </span>
  );
}

/** A language's dot and name. The dot's hue is positional (the series palette), not a brand colour. */
export function LanguageLabel({ language }: { language: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span
        aria-hidden="true"
        className="size-2 rounded-full"
        // Linguist's colour, as GitHub shows it (contract `languages.ts`).
        style={{ backgroundColor: languageColor(language) }}
      />
      {language}
    </span>
  );
}
