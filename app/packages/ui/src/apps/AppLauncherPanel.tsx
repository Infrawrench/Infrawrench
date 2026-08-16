import { useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import type { AppEntry } from "@infrawrench/appstream-core";

/**
 * The application launcher for one host: what is installed, and what is
 * running.
 *
 * Presentational on purpose — it takes a list and two callbacks, so the desktop
 * and the web app can drive it from their own transports and a test can drive
 * it from an array.
 */
export interface AppLauncherPanelProps {
  apps: AppEntry[];
  /** Windows already open, so the launcher can offer them rather than a second copy. */
  running?: Array<{ windowId: number; title: string; icon?: string; appId?: string }>;
  status?: "connecting" | "uploading" | "ready" | "error";
  statusMessage?: string;
  /**
   * The most recent launch: one still starting, or the reason one failed.
   *
   * Launching is the one action here with no visible result of its own — the
   * window it opens becomes a tab, and a launch that fails opens nothing at
   * all. Without this, clicking a broken entry and clicking a slow one look
   * exactly alike.
   */
  notice?: { kind: "pending" | "error"; message: string } | null;
  onLaunch: (app: AppEntry) => void;
  onRunCommand?: (command: string) => void;
  onFocusWindow?: (windowId: number) => void;
  onRefresh?: () => void;
}

export function AppLauncherPanel({
  apps,
  running = [],
  status = "ready",
  statusMessage,
  notice,
  onLaunch,
  onRunCommand,
  onFocusWindow,
  onRefresh,
}: AppLauncherPanelProps) {
  const gt = useGT();
  const dataString = useDataString();
  const [query, setQuery] = useState("");
  const [command, setCommand] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter((app) =>
      [app.name, app.comment, app.id, ...(app.categories ?? [])]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle)),
    );
  }, [apps, query]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <header className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={gt("Search applications…")}
          aria-label={gt("Search applications")}
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-faint"
        />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md border border-border px-3 py-2 text-xs text-on-surface-secondary hover:text-on-surface"
          >
            <T>Rescan</T>
          </button>
        )}
      </header>

      {status !== "ready" && (
        <p
          className={`text-sm ${status === "error" ? "text-danger-on-surface" : "text-on-surface-muted"}`}
          role={status === "error" ? "alert" : "status"}
        >
          {statusMessage ??
            (status === "uploading" ? gt("Starting the app server…") : gt("Connecting…"))}
        </p>
      )}

      {notice && (
        <p
          className={`text-sm ${notice.kind === "error" ? "text-danger-on-surface" : "text-on-surface-muted"}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {dataString(notice.message)}
        </p>
      )}

      {running.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-on-surface-faint">
            <T>Running</T>
          </h2>
          <ul className="flex flex-wrap gap-2">
            {running.map((window) => (
              <li key={window.windowId}>
                <button
                  type="button"
                  onClick={() => onFocusWindow?.(window.windowId)}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm hover:border-border-strong"
                >
                  {window.icon && (
                    <img src={window.icon} alt="" aria-hidden="true" className="size-4" />
                  )}
                  <span className="max-w-52 truncate">{dataString(window.title)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {status === "ready" && apps.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          <T>
            No graphical applications are installed on this host. Infrawrench brings the display;
            the host brings the applications.
          </T>
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
          {filtered.map((app) => (
            <li key={app.id}>
              <button
                type="button"
                onClick={() => onLaunch(app)}
                disabled={app.needsTerminal}
                title={
                  app.needsTerminal
                    ? gt("This entry needs a terminal — open it from the SSH tab instead")
                    : (app.comment ?? app.id)
                }
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {app.icon ? (
                  <img
                    src={app.icon}
                    alt=""
                    aria-hidden="true"
                    className="size-10 object-contain"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-10 items-center justify-center rounded-md bg-surface-sunken text-on-surface-faint"
                  >
                    {app.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{dataString(app.name)}</span>
                    {app.needsTerminal && (
                      <span className="rounded border border-warning-border px-1 text-[10px] uppercase text-warning-on-surface">
                        <T>terminal</T>
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-on-surface-faint">
                    {dataString(app.comment ?? app.categories?.join(" · ") ?? app.id)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {onRunCommand && (
        <form
          className="mt-auto flex gap-2 border-t border-border pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = command.trim();
            if (!trimmed) return;
            onRunCommand(trimmed);
            setCommand("");
          }}
        >
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder={gt("Run a command…")}
            aria-label={gt("Run a command")}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-on-surface placeholder:text-on-surface-faint"
          />
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-2 text-xs text-on-surface-secondary hover:text-on-surface"
          >
            <T>Run</T>
          </button>
        </form>
      )}
    </div>
  );
}
