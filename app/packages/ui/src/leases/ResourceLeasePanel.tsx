import { useCallback, useEffect, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { LeaseEditorModal, type LeaseEditorTarget } from "./LeaseEditorModal.js";
import type { LeasesClient, ResourceLease } from "./types.js";

export interface ResourceLeasePanelProps {
  client: LeasesClient;
  target: LeaseEditorTarget;
}

/** "in 3d" / "in 5h" / "expired 2d ago" — the lease countdown text. */
function expiresInText(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  const abs = Math.abs(ms);
  const label =
    abs >= 86_400_000
      ? `${Math.round(abs / 86_400_000)}d`
      : abs >= 3_600_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.max(1, Math.round(abs / 60_000))}m`;
  return ms >= 0 ? `in ${label}` : `expired ${label} ago`;
}

function warningStatusText(lease: ResourceLease, gt: (message: string) => string): string | null {
  if (!lease.autoDelete || lease.status !== "active") return null;
  if (lease.finalWarningAt) return gt("Final auto-delete warning sent");
  if (lease.firstWarningAt) return gt("First auto-delete warning sent");
  return gt("No warnings sent yet");
}

/**
 * The resource detail page's Lease tab: this resource's lease (if any) with
 * edit/cancel/remove, or a "Set lease" affordance. Auto-delete leases carry
 * their warning status; terminal leases (deleted / failed / canceled) show
 * their outcome with the option to set a fresh lease.
 */
export function ResourceLeasePanel({ client, target }: ResourceLeasePanelProps) {
  const gt = useGT();
  const [lease, setLease] = useState<ResourceLease | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Guards against out-of-order responses when the panel's target switches:
  // only the newest request may write state.
  const refreshVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    setError(null);
    try {
      const next = await client.getResourceLease(target.resourceId);
      if (version !== refreshVersion.current) return;
      setLease(next);
      setLoaded(true);
    } catch (e) {
      if (version !== refreshVersion.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    }
  }, [client, target.resourceId]);

  useEffect(() => {
    // Target switched: drop the previous resource's lease from view while the
    // new fetch runs, instead of showing it against the wrong resource.
    setLease(null);
    setLoaded(false);
    void refresh();
  }, [refresh]);

  const cancel = async () => {
    if (!lease) return;
    if (
      !window.confirm(
        gt("Cancel the lease on {name}? The resource stays; the countdown stops.", {
          name: target.resourceName,
        }),
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await client.cancelLease(lease.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!lease) return;
    if (!window.confirm(gt("Remove the lease record for {name}?", { name: target.resourceName })))
      return;
    setBusy(true);
    try {
      await client.deleteLease(lease.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const active = lease !== null && lease.status === "active";
  const warningStatus = lease ? warningStatusText(lease, gt) : null;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface">{gt("Lease")}</h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          {gt(
            "Put an expiry on this resource — “a test cluster for 3 days”. The deadline shows up on the Expiring radar; opting into auto-delete removes the resource at expiry after two warnings, and change freezes pause deletion.",
          )}
        </p>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}
      {!loaded && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading…")}
        </p>
      )}

      {loaded && !active && (
        <div className="flex flex-col gap-2">
          {lease !== null && (
            <div className="rounded-xl border border-border bg-surface-sunken px-4 py-3 text-xs text-on-surface-secondary">
              {lease.status === "deleted" &&
                gt("The previous lease expired and the resource was auto-deleted.")}
              {lease.status === "canceled" && gt("The previous lease was canceled.")}
              {lease.status === "failed" && (
                <T>
                  <span className="text-danger">
                    The previous lease&apos;s auto-delete failed:{" "}
                    <Var>{lease.lastError ?? gt("unknown error")}</Var>
                  </span>
                </T>
              )}
            </div>
          )}
          <div>
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
            >
              {gt("Set lease…")}
            </button>
          </div>
        </div>
      )}

      {lease !== null && active && (
        <div className="rounded-xl border border-border bg-surface-sunken px-4 py-3 text-sm text-on-surface">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {gt("Expires {relative} · {date}", {
                relative: expiresInText(lease.expiresAt),
                date: new Date(lease.expiresAt).toLocaleString(),
              })}
            </span>
            {lease.autoDelete && (
              <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-danger">
                {gt("auto-delete")}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-on-surface-secondary">
            {lease.note && <>{lease.note} · </>}
            {lease.lastError && <span className="text-warning">{lease.lastError} · </span>}
            {warningStatus}
            {!lease.autoDelete && gt("Nag-only — the resource is never deleted automatically")}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditorOpen(true)}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-on-surface hover:border-border-strong disabled:opacity-50"
            >
              {gt("Edit")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void cancel()}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-on-surface hover:border-border-strong disabled:opacity-50"
            >
              {gt("Cancel lease")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-xs text-danger hover:border-red-500/50 disabled:opacity-50"
            >
              {gt("Remove")}
            </button>
          </div>
        </div>
      )}

      {editorOpen && (
        <LeaseEditorModal
          client={client}
          target={target}
          existing={active ? lease : null}
          onSaved={() => void refresh()}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}
