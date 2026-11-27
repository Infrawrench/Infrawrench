/**
 * A commit's checks where the commit is summarised: the combined state as a
 * small button, and under it, once pressed, each check with its state, what
 * it said and a link to its run.
 *
 * The list is asked for when the box opens (one request for one commit), so
 * a page of commits costs nothing more than the states its rows already
 * carry. `live` is for the one commit a page is about (the strip above a
 * file listing): it asks at once and again while a check runs, so the glyph
 * settles without a reload.
 *
 * The box is drawn in `document.body` at the button's place rather than
 * inside the row: rows live in panels and tables that clip what overflows
 * them, and a list row's own links sit above anything a neighbour draws.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { StatusState } from "@infrawrench/git-contract";
import { queries } from "../api/queries";
import { checkHref, sortChecks, summarizeChecks } from "../lib/checks";
import type { RepoRef } from "../lib/paths";
import { AppLink } from "./AppLink";
import { CommitStatusGlyph, commitStatusLabel } from "./Badge";
import { Spinner } from "./icons";
import { errorMessage } from "./states";
import { CheckStateIcon } from "./StatusIcons";

const WIDTH = 340;
const MARGIN = 16;
const GAP = 4;
/** How often a running check is asked about again. */
const POLL_MS = 4000;

export interface ChecksBoxPlace {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** Under the button and inside the window; above it when there is no room below. */
export function placeChecksBox(
  anchor: { readonly left: number; readonly top: number; readonly bottom: number },
  box: { readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): ChecksBoxPlace {
  const width = Math.min(WIDTH, viewport.width - MARGIN * 2);
  const left = Math.max(MARGIN, Math.min(anchor.left - 6, viewport.width - width - MARGIN));
  const below = anchor.bottom + GAP;
  const fitsBelow = below + box.height <= viewport.height - MARGIN;
  const above = anchor.top - GAP - box.height;
  return { left, width, top: fitsBelow || above < MARGIN ? below : above };
}

export interface CommitChecksProps {
  readonly repo: RepoRef;
  /** The commit's full id. */
  readonly oid: string;
  /** The combined state the row already carries. Null draws nothing unless `live` finds checks. */
  readonly state: StatusState | null;
  readonly size?: number;
  /** Ask for the commit's checks at once, and again while one runs. */
  readonly live?: boolean;
}

export function CommitChecks({ repo, oid, state, size = 13, live = false }: CommitChecksProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<ChecksBoxPlace | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const checks = useQuery({
    ...queries.statuses.forRef({ params: repo, query: { ref: oid } }),
    enabled: live || open,
    refetchInterval: (query) =>
      (query.state.data === undefined ? state : query.state.data.state) === "pending"
        ? POLL_MS
        : false,
  });
  // What was just read is newer than what the row was drawn with.
  const shown = checks.data === undefined ? state : checks.data.state;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) button.current?.focus();
  }, []);

  const position = useCallback(() => {
    if (button.current === null || box.current === null) return;
    setPlace(
      placeChecksBox(
        button.current.getBoundingClientRect(),
        { height: box.current.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, []);

  // Placed before it is painted, and again when its rows arrive and it grows.
  const rows = checks.data?.statuses.length ?? -1;
  useLayoutEffect(() => {
    if (open) position();
  }, [open, rows, position]);
  // Focus goes into the box, so Tab reaches its links: it is not beside the button in the page.
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (button.current?.contains(target) === true || box.current?.contains(target) === true);
    const onPointer = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!inside(event.target)) close(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    // The page moving under a fixed box would leave it pointing at nothing.
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open, close, position]);

  if (shown === null) return null;
  const label = commitStatusLabel(shown);
  const statuses = checks.data === undefined ? null : sortChecks(checks.data.statuses);
  const summary = statuses === null ? null : summarizeChecks(statuses);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`${label}. Show checks`}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          // A row that is itself a link must not follow it.
          event.preventDefault();
          event.stopPropagation();
          if (open) close(false);
          else setOpen(true);
        }}
        className="relative z-10 inline-flex shrink-0 items-center justify-center rounded p-0.5 hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <CommitStatusGlyph state={shown} size={size} />
      </button>
      {open
        ? createPortal(
            <div
              ref={box}
              id={id}
              role="dialog"
              aria-label="Checks"
              tabIndex={-1}
              style={
                place === null
                  ? { position: "fixed", left: 0, top: 0, width: WIDTH, visibility: "hidden" }
                  : { position: "fixed", left: place.left, top: place.top, width: place.width }
              }
              className="z-50 overflow-hidden rounded-md outline-none border border-border bg-surface-raised text-xs text-on-surface shadow-[var(--shadow-tile-hover)]"
            >
              <div className="flex items-baseline gap-2 border-b border-border px-3 py-2">
                <span className="font-semibold">{summary?.title ?? "Checks"}</span>
                <span className="min-w-0 truncate text-on-surface-muted">{summary?.detail}</span>
              </div>
              {checks.error ? (
                <p role="alert" className="px-3 py-2 text-danger">
                  {errorMessage(checks.error)}
                </p>
              ) : statuses === null ? (
                <p
                  role="status"
                  className="flex items-center gap-2 px-3 py-2 text-on-surface-muted"
                >
                  <Spinner size={12} />
                  Loading checks
                </p>
              ) : statuses.length === 0 ? (
                <p className="px-3 py-2 text-on-surface-muted">No checks on this commit</p>
              ) : (
                <ul aria-label="Checks" className="max-h-72 overflow-y-auto">
                  {statuses.map((status) => {
                    const href = checkHref(repo, status);
                    return (
                      <li
                        key={status.id}
                        className="flex items-center gap-2 border-t border-border px-3 py-1.5 first:border-t-0"
                      >
                        <CheckStateIcon state={status.state} size={13} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium" title={status.context}>
                            {status.context}
                          </span>
                          {status.description !== null && status.description !== "" ? (
                            <span
                              className="block truncate text-on-surface-muted"
                              title={status.description}
                            >
                              {status.description}
                            </span>
                          ) : null}
                        </span>
                        {href !== null ? (
                          <AppLink
                            href={href}
                            onClick={() => close(false)}
                            className="shrink-0 text-accent hover:underline"
                          >
                            Details
                          </AppLink>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
