import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  formatElevationCountdown,
  formatGrantDuration,
  type AccessRequest,
  type AccessRequestCatalog,
  type AccessRequestStatus,
} from "@infrawrench/client-core";

import { useSettingsHost } from "./host.js";
import { useDataString } from "../i18n/data-strings.js";
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
  const gt = useGT();
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
      setError(e instanceof Error ? e.message : gt("Could not load access requests"));
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
      setError(e instanceof Error ? e.message : gt("That did not work"));
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

  if (permissionsLoading) return <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>;

  if (!canRead) {
    return (
      <div>
        <Header />
        <T>
          <p className="text-sm text-on-surface-muted">
            Your role does not include{" "}
            <Var>
              <code>access:read</code>
            </Var>
            , so you cannot see the organization’s access requests.
          </p>
        </T>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header />

      {error && <p className="text-sm text-danger">{error}</p>}

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
                  setError(e instanceof Error ? e.message : gt("Could not raise the request"));
                }
              }}
            />
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-on-surface-muted">
                {gt(
                  "Need something your role does not grant? Ask for exactly that, for as long as you need it — not a permanent promotion.",
                )}
              </p>
              <button type="button" className={PRIMARY_BUTTON} onClick={() => setShowForm(true)}>
                {gt("Request access")}
              </button>
            </div>
          )}
        </section>
      )}

      {active.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {gt("Active elevations")}
          </h2>
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
        <h2 className="text-sm font-semibold text-on-surface-secondary">
          {gt("Waiting for a decision")}
        </h2>
        {requests === null ? (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-on-surface-muted">{gt("Nothing is waiting.")}</p>
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
          <T>
            <p className="text-xs text-on-surface-muted">
              You can see what is waiting, but deciding needs{" "}
              <Var>
                <code>access:approve</code>
              </Var>
              .
            </p>
          </T>
        )}
      </section>

      {history.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("History")}</h2>
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
  const gt = useGT();
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">{gt("Break-glass access")}</h1>
      <p className="text-sm text-on-surface-muted mt-1">
        {gt(
          "Time-boxed permission elevation. Ask for the specific permissions you need, for a specific number of minutes, with a reason; someone else approves; the elevation lapses on its own. The usual alternative — making somebody an admin — is how an organization ends up with ten admins and no record of why.",
        )}
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
  const gt = useGT();
  const gtData = useDataString();
  const id = encodeURIComponent(request.id);
  return (
    <li className="p-3 space-y-2">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-on-surface-secondary">
            <span className="font-medium">{request.userName ?? gt("A member")}</span>{" "}
            <span className="text-on-surface-muted">
              {gt("asked for {duration} of", {
                duration: formatGrantDuration(request.durationMinutes),
              })}
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
              ? gt("Live — {countdown}", {
                  countdown: formatElevationCountdown(request.grantExpiresAt),
                })
              : request.status === "pending"
                ? gt("Raised {when} — {countdown}", {
                    when: new Date(request.createdAt).toLocaleString(),
                    countdown: formatElevationCountdown(request.expiresAt),
                  })
                : describeOutcome(gt, request)}
          </p>
        </div>

        <span
          className={`text-xs px-2 py-0.5 rounded-md ${
            request.active
              ? "text-warning bg-amber-500/10"
              : request.status === "approved"
                ? "text-on-surface-tertiary bg-surface-overlay"
                : request.status === "denied"
                  ? "text-danger bg-red-500/10"
                  : "text-on-surface-tertiary bg-surface-overlay"
          }`}
        >
          {request.active ? gt("Live") : gtData(STATUS_LABELS[request.status])}
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
              {gt("Approve")}
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => void onAction(`${base}/${id}/deny`)}
            >
              {gt("Deny")}
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
            {gt("Withdraw")}
          </button>
        )}
        {request.active && (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => void onAction(`${base}/${id}/revoke`)}
          >
            {gt("End now")}
          </button>
        )}
      </div>
    </li>
  );
}

function describeOutcome(gt: ReturnType<typeof useGT>, request: AccessRequest): string {
  if (request.revokedAt) {
    const when = new Date(request.revokedAt).toLocaleString();
    return request.revokedByName
      ? gt("Ended early by {name} on {when}", { name: request.revokedByName, when })
      : gt("Ended early on {when}", { when });
  }
  if (request.status === "approved" && request.grantExpiresAt) {
    const when = new Date(request.grantExpiresAt).toLocaleString();
    return request.decidedByName
      ? gt("Approved by {name}; lapsed {when}", { name: request.decidedByName, when })
      : gt("Approved; lapsed {when}", { when });
  }
  if (request.status === "denied") {
    if (request.decidedByName && request.decisionNote) {
      return gt("Denied by {name} — {note}", {
        name: request.decidedByName,
        note: request.decisionNote,
      });
    }
    if (request.decidedByName) {
      return gt("Denied by {name}", { name: request.decidedByName });
    }
    if (request.decisionNote) {
      return gt("Denied — {note}", { note: request.decisionNote });
    }
    return gt("Denied");
  }
  return request.decisionNote ?? gt("Expired without a decision");
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
  const gt = useGT();
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
        <span className={LABEL}>{gt("Permissions")}</span>
        <div className="max-h-48 overflow-y-auto border border-border rounded-lg p-2 grid grid-cols-2 gap-1">
          {available.map((permission) => {
            const alreadyHeld = held.has(permission);
            return (
              <label
                key={permission}
                className={`flex items-center gap-2 text-xs ${
                  alreadyHeld ? "text-on-surface-faint" : "text-on-surface-secondary"
                }`}
                title={alreadyHeld ? gt("Your role already grants this") : undefined}
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
          {gt("Why (this is what the approver reads, and what a reviewer reads later)")}
        </label>
        <textarea
          id="access-reason"
          className={INPUT}
          rows={2}
          minLength={10}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={gt("Restoring the prod database from last night's snapshot — INC-4417")}
        />
      </div>

      <div>
        <span className={LABEL}>{gt("For how long")}</span>
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
          {submitting ? gt("Requesting…") : gt("Request")}
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
          {gt("Cancel")}
        </button>
      </div>
    </form>
  );
}
