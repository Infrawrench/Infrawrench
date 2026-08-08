import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatElevationCountdown,
  formatGrantDuration,
  type AccessRequest,
  type AccessRequestCatalog,
  type AccessRequestStatus,
} from "@infrawrench/client-core";

import { useSettingsHost } from "./host.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

/**
 * Durations offered in the picker.
 *
 * Presets rather than a free number field because the honest answer to "how
 * long do you need this for" is almost always one of these, and a field invites
 * the maximum. The server enforces the bounds regardless.
 */
const DURATION_PRESETS = [15, 30, 60, 120, 240, 480];

const STATUS_LABELS: Record<AccessRequestStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
};

/**
 * Break-glass access: ask for permissions your role does not grant, for a
 * bounded window, with a reason.
 *
 * The page is deliberately one screen rather than two. The person who asks and
 * the person who decides are different people, but they are looking at the same
 * queue — splitting it would mean an approver has to go somewhere else to see
 * what they granted last week, which is exactly the review nobody then does.
 */
export function AccessRequestsSection() {
  const { orgId, api, has, permissionsLoading } = useSettingsHost();
  const canRead = has("access:read");
  const canRequest = has("access:request");
  const canApprove = has("access:approve");

  const [requests, setRequests] = useState<AccessRequest[] | null>(null);
  const [catalog, setCatalog] = useState<AccessRequestCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const base = `/api/org/${orgId}/access-requests`;

  const load = useCallback(async () => {
    try {
      setRequests(await api.get<AccessRequest[]>(base));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load access requests");
    }
  }, [api, base]);

  useEffect(() => {
    if (!canRead) return;
    void load();
  }, [canRead, load]);

  useEffect(() => {
    if (!canRequest) return;
    api
      .get<AccessRequestCatalog>(`${base}/catalog`)
      .then(setCatalog)
      .catch(() => setCatalog(null));
  }, [api, base, canRequest]);

  /**
   * Re-render on a minute tick so countdowns move without a refetch. A grant
   * that says "expires in 3m" for twenty minutes is worse than no countdown.
   */
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  async function act(path: string, body?: unknown) {
    setError(null);
    try {
      await api.post(path, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work");
    }
  }

  const { active, pending, history } = useMemo(() => {
    const rows = requests ?? [];
    return {
      active: rows.filter((r) => r.active),
      pending: rows.filter((r) => r.status === "pending"),
      history: rows.filter((r) => r.status !== "pending" && !r.active),
    };
  }, [requests]);

  if (permissionsLoading) return <p className="text-sm text-on-surface-faint">Loading…</p>;

  if (!canRead) {
    return (
      <div>
        <Header />
        <p className="text-sm text-on-surface-muted">
          Your role does not include <code>access:read</code>, so you cannot see the
          organization&rsquo;s access requests.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header />

      {error && <p className="text-sm text-red-400">{error}</p>}

      {canRequest && (
        <section className={CARD}>
          {showForm ? (
            <RequestForm
              catalog={catalog}
              onCancel={() => setShowForm(false)}
              onSubmit={async (input) => {
                setError(null);
                try {
                  await api.post(base, input);
                  setShowForm(false);
                  await load();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Could not raise the request");
                }
              }}
            />
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-on-surface-muted">
                Need something your role does not grant? Ask for exactly that, for as long as you
                need it — not a permanent promotion.
              </p>
              <button type="button" className={PRIMARY_BUTTON} onClick={() => setShowForm(true)}>
                Request access
              </button>
            </div>
          )}
        </section>
      )}

      {active.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-on-surface-secondary">Active elevations</h2>
          <ul className="border border-amber-500/40 rounded-xl divide-y divide-border overflow-hidden">
            {active.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                canApprove={canApprove}
                canRequest={canRequest}
                onAction={act}
                base={base}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-on-surface-secondary">Waiting for a decision</h2>
        {requests === null ? (
          <p className="text-sm text-on-surface-faint">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-on-surface-muted">Nothing is waiting.</p>
        ) : (
          <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
            {pending.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                canApprove={canApprove}
                canRequest={canRequest}
                onAction={act}
                base={base}
              />
            ))}
          </ul>
        )}
        {!canApprove && pending.length > 0 && (
          <p className="text-xs text-on-surface-muted">
            You can see what is waiting, but deciding needs <code>access:approve</code>.
          </p>
        )}
      </section>

      {history.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-on-surface-secondary">History</h2>
          <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
            {history.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                canApprove={canApprove}
                canRequest={canRequest}
                onAction={act}
                base={base}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">Break-glass access</h1>
      <p className="text-sm text-on-surface-muted mt-1">
        Time-boxed permission elevation. Ask for the specific permissions you need, for a specific
        number of minutes, with a reason; someone else approves; the elevation lapses on its own.
        The usual alternative — making somebody an admin — is how an organization ends up with ten
        admins and no record of why.
      </p>
    </div>
  );
}

function RequestRow({
  request,
  canApprove,
  canRequest,
  onAction,
  base,
}: {
  request: AccessRequest;
  canApprove: boolean;
  canRequest: boolean;
  onAction: (path: string, body?: unknown) => Promise<void>;
  base: string;
}) {
  const id = encodeURIComponent(request.id);
  return (
    <li className="p-3 space-y-2">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-on-surface-secondary">
            <span className="font-medium">{request.userName ?? "A member"}</span>{" "}
            <span className="text-on-surface-muted">
              asked for {formatGrantDuration(request.durationMinutes)} of
            </span>{" "}
            {request.permissions.map((p) => (
              <code key={p} className="mr-1">
                {p}
              </code>
            ))}
          </p>
          <p className="text-xs text-on-surface-muted mt-0.5">{request.reason}</p>
          <p className="text-xs text-on-surface-faint mt-0.5">
            {request.active && request.grantExpiresAt
              ? `Live — ${formatElevationCountdown(request.grantExpiresAt)}`
              : request.status === "pending"
                ? `Raised ${new Date(request.createdAt).toLocaleString()} — ${formatElevationCountdown(request.expiresAt)}`
                : describeOutcome(request)}
          </p>
        </div>

        <span
          className={`text-xs px-2 py-0.5 rounded-md ${
            request.active
              ? "text-amber-400 bg-amber-500/10"
              : request.status === "approved"
                ? "text-on-surface-tertiary bg-surface-overlay"
                : request.status === "denied"
                  ? "text-red-400 bg-red-500/10"
                  : "text-on-surface-tertiary bg-surface-overlay"
          }`}
        >
          {request.active ? "Live" : STATUS_LABELS[request.status]}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {request.status === "pending" && canApprove && (
          <>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() => void onAction(`${base}/${id}/approve`)}
            >
              Approve
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => void onAction(`${base}/${id}/deny`)}
            >
              Deny
            </button>
          </>
        )}
        {request.status === "pending" && canRequest && (
          // The requester's own escape hatch. The server checks ownership, so
          // showing it to everyone would just produce a 404 — but it also
          // costs nothing to show, and hiding it would need the caller's id
          // threaded through the settings host for no real gain.
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void onAction(`${base}/${id}/withdraw`)}
          >
            Withdraw
          </button>
        )}
        {request.active && (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void onAction(`${base}/${id}/revoke`)}
          >
            End now
          </button>
        )}
      </div>
    </li>
  );
}

function describeOutcome(request: AccessRequest): string {
  if (request.revokedAt) {
    return `Ended early${request.revokedByName ? ` by ${request.revokedByName}` : ""} on ${new Date(request.revokedAt).toLocaleString()}`;
  }
  if (request.status === "approved" && request.grantExpiresAt) {
    return `Approved${request.decidedByName ? ` by ${request.decidedByName}` : ""}; lapsed ${new Date(request.grantExpiresAt).toLocaleString()}`;
  }
  if (request.status === "denied") {
    return `Denied${request.decidedByName ? ` by ${request.decidedByName}` : ""}${request.decisionNote ? ` — ${request.decisionNote}` : ""}`;
  }
  return request.decisionNote ?? "Expired without a decision";
}

function RequestForm({
  catalog,
  onCancel,
  onSubmit,
}: {
  catalog: AccessRequestCatalog | null;
  onCancel: () => void;
  onSubmit: (input: {
    permissions: string[];
    reason: string;
    durationMinutes: number;
  }) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [submitting, setSubmitting] = useState(false);

  // Permissions the caller already holds are shown but not selectable: asking
  // for them changes nothing, and the server rejects a request made entirely
  // of them. Greying them out explains why rather than 400-ing after the fact.
  const held = useMemo(() => new Set(catalog?.held ?? []), [catalog]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const available = catalog?.permissions ?? [];

  const durations = DURATION_PRESETS.filter(
    (m) => m >= (catalog?.minGrantMinutes ?? 5) && m <= (catalog?.maxGrantMinutes ?? 480),
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        void onSubmit({ permissions: selected, reason, durationMinutes }).finally(() =>
          setSubmitting(false),
        );
      }}
    >
      <div>
        <span className={LABEL}>Permissions</span>
        <div className="max-h-48 overflow-y-auto border border-border rounded-lg p-2 grid grid-cols-2 gap-1">
          {available.map((permission) => {
            const alreadyHeld = held.has(permission);
            return (
              <label
                key={permission}
                className={`flex items-center gap-2 text-xs ${
                  alreadyHeld ? "text-on-surface-faint" : "text-on-surface-secondary"
                }`}
                title={alreadyHeld ? "Your role already grants this" : undefined}
              >
                <input
                  type="checkbox"
                  disabled={alreadyHeld}
                  checked={selectedSet.has(permission)}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(permission);
                      else next.delete(permission);
                      return [...next];
                    })
                  }
                />
                <code>{permission}</code>
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="access-reason">
          Why (this is what the approver reads, and what a reviewer reads later)
        </label>
        <textarea
          id="access-reason"
          className={INPUT}
          rows={2}
          minLength={10}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Restoring the prod database from last night's snapshot — INC-4417"
        />
      </div>

      <div>
        <span className={LABEL}>For how long</span>
        <div className="flex items-center gap-1 flex-wrap">
          {durations.map((minutes) => (
            <button
              key={minutes}
              type="button"
              onClick={() => setDurationMinutes(minutes)}
              aria-pressed={durationMinutes === minutes}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                durationMinutes === minutes
                  ? "bg-surface-overlay text-on-surface"
                  : "text-on-surface-tertiary hover:text-on-surface-secondary"
              }`}
            >
              {formatGrantDuration(minutes)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          className={PRIMARY_BUTTON}
          disabled={submitting || selected.length === 0 || reason.trim().length < 10}
        >
          {submitting ? "Requesting…" : "Request"}
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
