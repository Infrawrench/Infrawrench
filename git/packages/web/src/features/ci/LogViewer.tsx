/**
 * A job's output: numbered lines with their terminal colours, each number an
 * anchor (`#L12`, shift-click for a range), and, while the job runs, a view
 * that stays at the newest line until the reader scrolls away.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnsiLine } from "../../components/AnsiText";
import { Button } from "../../components/Button";
import { PLAIN, parseAnsiLine, type AnsiSpan } from "../../lib/ansi";
import {
  formatLineHash,
  inRange,
  parseLineHash,
  selectLine,
  type LineRange,
} from "../../lib/lines";
import type { LogLine } from "./live";

/** Lines drawn at once; a longer log starts at its end with a button for the rest. */
const WINDOW = 3000;

export function LogViewer({
  lines,
  label,
  following,
}: {
  lines: ReadonlyArray<LogLine>;
  /** The job's name, for the log's accessible name. */
  label: string;
  /** The job is still running: keep the newest line in view. */
  following: boolean;
}) {
  const parsed = useMemo(() => {
    let style = PLAIN;
    return lines.map((entry) => {
      const result = parseAnsiLine(entry.line, style);
      style = result.style;
      return { stream: entry.stream, spans: result.spans as ReadonlyArray<AnsiSpan> };
    });
  }, [lines]);

  const [selected, setSelected] = useState<LineRange | null>(() =>
    parseLineHash(window.location.hash),
  );
  const [showAll, setShowAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const jumped = useRef(false);

  const hiddenBefore =
    showAll ||
    parsed.length <= WINDOW ||
    (selected !== null && selected.start <= parsed.length - WINDOW)
      ? 0
      : parsed.length - WINDOW;

  // Stay at the bottom while output arrives, unless the reader has scrolled up.
  useLayoutEffect(() => {
    const element = box.current;
    if (element && following && pinned.current && selected === null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [parsed.length, following, selected]);

  // Bring a line named by the URL into view once it exists.
  useEffect(() => {
    if (jumped.current || selected === null || parsed.length < selected.start) return;
    jumped.current = true;
    document.getElementById(`L${selected.start}`)?.scrollIntoView({ block: "center" });
  }, [selected, parsed.length]);

  useEffect(() => {
    const onHash = () => setSelected(parseLineHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = (line: number, extend: boolean) => {
    const next = selectLine(selected, line, extend);
    setSelected(next);
    const url = new URL(window.location.href);
    url.hash = next === null ? "" : formatLineHash(next);
    window.history.replaceState(window.history.state, "", url);
  };

  if (parsed.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-on-surface-muted">
        {following ? "Waiting for output" : "No output"}
      </p>
    );
  }

  return (
    <div
      ref={box}
      role="log"
      aria-label={`Output of ${label}`}
      aria-live="off"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="max-h-[70vh] overflow-auto bg-surface-inset py-1 font-mono text-xs leading-5 focus:outline-none"
    >
      {hiddenBefore > 0 ? (
        <div className="px-3 py-1">
          <Button size="sm" onClick={() => setShowAll(true)}>
            Show {hiddenBefore} earlier lines
          </Button>
        </div>
      ) : null}
      <table className="w-full border-collapse [tab-size:4]">
        <tbody>
          {parsed.slice(hiddenBefore).map((entry, offset) => {
            const number = hiddenBefore + offset + 1;
            return (
              <tr key={number} className={inRange(selected, number) ? "bg-warning/15" : undefined}>
                <td className="w-px select-none whitespace-nowrap p-0 text-right align-top text-on-surface-faint">
                  <a
                    id={`L${number}`}
                    href={`#L${number}`}
                    aria-label={`Line ${number}`}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey) return;
                      event.preventDefault();
                      select(number, event.shiftKey);
                    }}
                    className="block scroll-mt-24 px-3 hover:text-on-surface"
                  >
                    {number}
                  </a>
                </td>
                <td
                  className={`whitespace-pre-wrap break-all p-0 pr-4 align-top text-on-surface ${
                    entry.stream === "stderr" ? "border-l-2 border-danger/50 pl-2" : "pl-2.5"
                  }`}
                >
                  <AnsiLine spans={entry.spans} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
