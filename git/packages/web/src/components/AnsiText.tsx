import { memo, type CSSProperties } from "react";
import type { AnsiColor, AnsiSpan } from "../lib/ansi";

/**
 * Terminal colours on the theme: the status tokens where a colour means a
 * status (red, green, yellow), the categorical series for the rest, so each
 * reads in light and dark.
 */
const COLOR: Record<AnsiColor, string> = {
  black: "var(--color-on-surface-muted)",
  red: "var(--color-danger)",
  green: "var(--color-success)",
  yellow: "var(--color-warning)",
  blue: "var(--color-series-1)",
  magenta: "var(--color-series-4)",
  cyan: "var(--color-series-6)",
  white: "var(--color-on-surface)",
};

function styleOf(span: AnsiSpan): CSSProperties | undefined {
  if (span.color === null && !span.bold && !span.dim && !span.italic && !span.underline) {
    return undefined;
  }
  return {
    color: span.color === null ? undefined : COLOR[span.color],
    fontWeight: span.bold ? 600 : undefined,
    opacity: span.dim ? 0.7 : undefined,
    fontStyle: span.italic ? "italic" : undefined,
    textDecoration: span.underline ? "underline" : undefined,
  };
}

/** One line of terminal output, already parsed (`parseAnsiLine`). */
export const AnsiLine = memo(function AnsiLine({ spans }: { spans: ReadonlyArray<AnsiSpan> }) {
  if (spans.length === 0) return <>{"\n"}</>;
  return (
    <>
      {spans.map((span, index) => {
        const style = styleOf(span);
        return style === undefined ? (
          span.text
        ) : (
          <span key={index} style={style}>
            {span.text}
          </span>
        );
      })}
    </>
  );
});
