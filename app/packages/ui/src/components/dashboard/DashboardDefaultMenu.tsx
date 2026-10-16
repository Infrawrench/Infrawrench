import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { DefaultDashboardResolution } from "@infrawrench/client-core";
import { toast } from "../Toast/index.js";

/**
 * Transport for "My default dashboard". Web backs it with `apiFetch`, desktop
 * cloud mode with its `cloud_*_default_dashboard` IPC channels.
 */
export interface DashboardDefaultClient {
  getDefault(): Promise<DefaultDashboardResolution>;
  setMine(dashboardId: string): Promise<DefaultDashboardResolution>;
  clearMine(): Promise<DefaultDashboardResolution>;
}

export interface DashboardDefaultMenuProps {
  dashboardId: string;
  client: DashboardDefaultClient;
  /** After a change: hosts refresh whatever marks the default (the sidebar). */
  onChanged?: ((resolution: DefaultDashboardResolution) => void) | undefined;
}

const triggerClass =
  "text-xs text-on-surface-faint hover:text-on-surface-muted transition-colors px-2 py-1 rounded hover:bg-surface-overlay disabled:opacity-50";
const itemClass =
  "w-full text-left px-3 py-2 text-sm text-on-surface-secondary hover:text-on-surface hover:bg-surface-sunken transition-colors disabled:opacity-50";

/**
 * The dashboard header's "Default" menu: says whether this is the dashboard
 * the viewer lands on (and which layer put it there), and sets or clears the
 * viewer's own default. Role defaults are set by admins in Settings > Roles;
 * this menu only ever writes the viewer's own preference.
 */
export function DashboardDefaultMenu({
  dashboardId,
  client,
  onChanged,
}: DashboardDefaultMenuProps) {
  const gt = useGT();
  const [resolution, setResolution] = useState<DefaultDashboardResolution | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .getDefault()
      .then((r) => {
        if (!cancelled) setResolution(r);
      })
      .catch(() => {
        /* the menu is a convenience: without a resolution it stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [client, dashboardId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const apply = useCallback(
    async (run: () => Promise<DefaultDashboardResolution>, failure: string) => {
      setBusy(true);
      try {
        const next = await run();
        setResolution(next);
        setOpen(false);
        onChanged?.(next);
      } catch (e: unknown) {
        toast.error(failure, { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  if (!resolution) return null;

  const isHere = resolution.dashboardId === dashboardId;
  const isMine = resolution.userDefaultDashboardId === dashboardId;
  const hasMine = resolution.userDefaultDashboardId !== null;
  const mineUnshared = resolution.skipped.includes("user");

  let status: string;
  if (isHere && resolution.source === "user") {
    status = gt("You land here when you open the app. You chose it.");
  } else if (isHere && resolution.source === "role") {
    status = gt("You land here when you open the app: it is the default for your role, {role}.", {
      role: resolution.roleDefault?.roleName ?? "",
    });
  } else if (isHere) {
    status = gt("You land here when you open the app: it is the organization default.");
  } else {
    status = gt("You land on {name} when you open the app.", { name: resolution.dashboardName });
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className={triggerClass}
        title={status}
      >
        {isHere ? `★ ${gt("Default")}` : gt("Default")}
      </button>
      {open && (
        <>
          {/* Mouse-only click-away backdrop; keyboard users close the menu with Escape (handled above). */}
          <div aria-hidden="true" className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={gt("Default dashboard")}
            className="absolute right-0 top-full mt-1 z-30 w-72 rounded-xl border border-border bg-surface-raised shadow-xl overflow-hidden py-1"
          >
            <p className="px-3 py-2 text-xs text-on-surface-muted">{status}</p>
            {mineUnshared && (
              <p className="px-3 pb-2 text-xs text-warning">
                {gt("Your own default dashboard is no longer shared with you, so it was skipped.")}
              </p>
            )}
            {!isMine && (
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() =>
                  void apply(
                    () => client.setMine(dashboardId),
                    gt("Couldn't set your default dashboard"),
                  )
                }
                className={itemClass}
              >
                {gt("Set as my default")}
              </button>
            )}
            {hasMine && (
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() =>
                  void apply(() => client.clearMine(), gt("Couldn't clear your default dashboard"))
                }
                className={itemClass}
              >
                {gt("Clear my default")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
