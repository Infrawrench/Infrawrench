import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  JIT_LIMITS,
  formatElevationCountdown,
  formatGrantDuration,
  jitExtensionHeadroom,
  type JitAccessRequest,
  type JitPolicy,
  type JitPrincipalOption,
  type JitPrincipalResolution,
  type JitRequestStatus,
} from "@infrawrench/client-core";

import type { SettingsApi } from "../settings/host.js";
import { useDataString } from "../i18n/data-strings.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../settings/styles.js";

export interface JitAccessPanelProps {
  orgId: string;
  /** The same transport the settings sections use (web fetch, desktop IPC proxy). */
  api: SettingsApi;
  /** Whether the caller holds `access:read`; without it the panel explains instead. */
  canRead: boolean;
  /** Whether the caller holds `access:request`. */
  canRequest: boolean;
  /** Opens the policies settings section; omitted, the link is hidden. */
  onOpenPolicies?: (() => void) | undefined;
}

const DURATION_PRESETS = [15, 30, 60, 120, 240, 480, 720];
const HOLDING: ReadonlySet<JitRequestStatus> = new Set([
  "granting",
  "active",
  "revoking",
  "revoke_failed",
]);

function useStatusLabel() {
  const gt = useGT();
  return (status: JitRequestStatus): string => {
    switch (status) {
      case "pending":
        return gt("Waiting");
      case "timed_out":
        return gt("Timed out");
      case "denied":
        return gt("Denied");
      case "cancelled":
        return gt("Cancelled");
      case "granting":
        return gt("Granting");
      case "active":
        return gt("Active");
      case "grant_failed":
        return gt("Grant failed");
      case "revoking":
        return gt("Revoking");
      case "revoked":
        return gt("Ended");
      case "revoke_failed":
        return gt("Revoke failed");
    }
  };
}

/**
 * Just-in-time access: ask for a provider role for a bounded window, and decide
 * other people's asks. One screen for both halves, as break-glass does: the
 * requester and the approver look at the same queue, and an approver should be
 * able to see what they granted last week without going somewhere else.
 *
 * Network-agnostic: the host passes the same `SettingsApi` transport the
 * settings sections use.
 */
export function JitAccessPanel({
  orgId,
  api,
  canRead,
  canRequest,
  onOpenPolicies,
}: JitAccessPanelProps) {
  const gt = useGT();
  const base = `/api/org/${orgId}/jit-access`;
  const [requests, setRequests] = useState<JitAccessRequest[] | null>(null);
  const [policies, setPolicies] = useState<JitPolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([
        api.get<JitAccessRequest[]>(`${base}/requests`),
        api.get<JitPolicy[]>(`${base}/policies`),
      ]);
      setRequests(r);
      setPolicies(p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not load just-in-time access"));
    }
  }, [api, base, gt]);

  useEffect(() => {
    if (!canRead) return;
    void load();
    // A request somebody else decides should show up without a reload; the
    // queue is small, so a modest poll is cheaper than a push channel.
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [canRead, load]);

  // Countdowns move on a tick, without refetching.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const act = useCallback(
    async (requestId: string, path: string, body?: unknown) => {
      setBusy(requestId);
      setError(null);
      try {
        await api.post(`${base}/requests/${encodeURIComponent(requestId)}/${path}`, body ?? {});
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : gt("That did not work"));
      } finally {
        setBusy(null);
      }
    },
    [api, base, gt, load],
  );

  const requestable = useMemo(() => (policies ?? []).filter((p) => p.canRequest), [policies]);
  const { pending, holding, history } = useMemo(() => {
    const rows = requests ?? [];
    return {
      pending: rows.filter((r) => r.status === "pending"),
      holding: rows.filter((r) => HOLDING.has(r.status)),
      history: rows.filter((r) => r.status !== "pending" && !HOLDING.has(r.status)),
    };
  }, [requests]);

  if (!canRead) {
    return (
      <div className="p-6">
        <Header onOpenPolicies={onOpenPolicies} />
        <T>
          <p className="text-sm text-on-surface-muted">
            Your role does not include{" "}
            <Var>
              <code>access:read</code>
            </Var>
            , so you cannot see just-in-time access requests.
          </p>
        </T>
      </div>
    );
  }

  const policyMax = (r: JitAccessRequest) =>
    policies?.find((p) => p.id === r.policyId)?.maxDurationMinutes ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <Header onOpenPolicies={onOpenPolicies} />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {canRequest && (
        <section className={CARD}>
          {showForm ? (
            <RequestForm
              api={api}
              base={base}
              policies={requestable}
              onCancel={() => setShowForm(false)}
              onCreated={async () => {
                setShowForm(false);
                await load();
              }}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-on-surface-muted">
                {policies === null
                  ? gt("Loading…")
                  : requestable.length === 0
                    ? gt("No policy lets you request access yet. An admin adds them in Settings.")
                    : gt(
                        "Need a cloud role you do not hold? Ask for it for as long as you need it.",
                      )}
              </p>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                disabled={requestable.length === 0}
                onClick={() => setShowForm(true)}
              >
                {gt("Request access")}
              </button>
            </div>
          )}
        </section>
      )}

      <RequestList
        title={gt("Waiting for a decision")}
        empty={gt("Nothing is waiting.")}
        rows={requests === null ? null : pending}
        busy={busy}
        policyMax={policyMax}
        onAct={act}
      />
      <RequestList
        title={gt("Granted now")}
        empty={gt("Nobody holds just-in-time access right now.")}
        rows={requests === null ? null : holding}
        busy={busy}
        policyMax={policyMax}
        onAct={act}
        highlight
      />
      <RequestList
        title={gt("History")}
        empty={gt("No earlier requests.")}
        rows={requests === null ? null : history}
        busy={busy}
        policyMax={policyMax}
        onAct={act}
      />
    </div>
  );
}

function Header({ onOpenPolicies }: { onOpenPolicies?: (() => void) | undefined }) {
  const gt = useGT();
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold text-on-surface">{gt("Just-in-time access")}</h1>
        <p className="text-sm text-on-surface-muted max-w-2xl">
          {gt(
            "Time-boxed cloud roles: ask for a role on an account for a set time with a reason, an approver says yes, and the access is removed from the provider when the time is up.",
          )}
        </p>
      </div>
      {onOpenPolicies && (
        <button type="button" className={SECONDARY_BUTTON} onClick={onOpenPolicies}>
          {gt("Manage policies")}
        </button>
      )}
    </header>
  );
}

function RequestList({
  title,
  empty,
  rows,
  busy,
  policyMax,
  onAct,
  highlight = false,
}: {
  title: string;
  empty: string;
  rows: JitAccessRequest[] | null;
  busy: string | null;
  policyMax: (r: JitAccessRequest) => number;
  onAct: (id: string, path: string, body?: unknown) => Promise<void>;
  highlight?: boolean;
}) {
  const gt = useGT();
  return (
    <section className="space-y-2" aria-label={title}>
      <h2 className="text-sm font-semibold text-on-surface-secondary">{title}</h2>
      {rows === null ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-on-surface-muted">{empty}</p>
      ) : (
        <ul
          className={`border rounded-xl divide-y divide-border overflow-hidden ${
            highlight ? "border-amber-500/40" : "border-border"
          }`}
        >
          {rows.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              busy={busy === r.id}
              maxDuration={policyMax(r)}
              onAct={onAct}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestRow({
  request: r,
  busy,
  maxDuration,
  onAct,
}: {
  request: JitAccessRequest;
  busy: boolean;
  maxDuration: number;
  onAct: (id: string, path: string, body?: unknown) => Promise<void>;
}) {
  const gt = useGT();
  const statusLabel = useStatusLabel();
  const headroom = jitExtensionHeadroom(r, maxDuration);
  const tone =
    r.status === "revoke_failed" || r.status === "grant_failed"
      ? "bg-red-500/15 text-danger"
      : r.status === "active"
        ? "bg-amber-500/15 text-warning"
        : r.status === "pending"
          ? "bg-blue-500/15 text-info"
          : "bg-surface-overlay text-on-surface-tertiary";
  const confirmRevoke = () => {
    if (window.confirm(gt("End this grant now and remove the access from the provider?"))) {
      void onAct(r.id, "revoke");
    }
  };
  return (
    <li className="p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tone}`}>
          {statusLabel(r.status)}
        </span>
        <span className="text-sm font-medium text-on-surface">
          {r.roleName}
          <span className="text-on-surface-muted">
            {" · "}
            {r.scopeName}
            {r.accountName ? ` · ${r.accountName}` : ""}
          </span>
        </span>
      </div>
      <p className="text-sm text-on-surface-secondary">
        {gt("{who} for {principal} · {duration}", {
          who: r.userName ?? gt("A member"),
          principal: r.principalName,
          duration: formatGrantDuration(r.durationMinutes + r.extendedMinutes),
        })}
        {r.status === "pending" && ` · ${formatElevationCountdown(r.requestExpiresAt)}`}
        {HOLDING.has(r.status) &&
          r.grantExpiresAt &&
          ` · ${formatElevationCountdown(r.grantExpiresAt)}`}
      </p>
      {!r.principalMatched && (
        <p className="text-xs text-warning">
          {gt(
            "This grant goes to a principal that was not matched from the requester's own email.",
          )}
        </p>
      )}
      <p className="text-sm text-on-surface-muted whitespace-pre-wrap">{r.reason}</p>
      {r.ticket && (
        <p className="text-xs text-on-surface-tertiary">
          {gt("Ticket: {ticket}", { ticket: r.ticket })}
        </p>
      )}
      {r.decidedByName && (
        <p className="text-xs text-on-surface-tertiary">
          {r.selfApproved
            ? gt("Self-approved by {name} during an open incident", { name: r.decidedByName })
            : gt("Decided by {name}", { name: r.decidedByName })}
          {r.decisionNote ? `: ${r.decisionNote}` : ""}
        </p>
      )}
      {r.preexisting && (
        <p className="text-xs text-on-surface-tertiary">
          {gt(
            "The principal already held this role, so nothing was granted and nothing will be removed.",
          )}
        </p>
      )}
      {r.lastError &&
        (r.status === "revoke_failed" ||
          r.status === "grant_failed" ||
          r.status === "granting") && (
          <p className="text-xs text-danger break-words">
            {r.status === "revoke_failed"
              ? gt("Revoking failed after {count} attempts and is being retried: {error}", {
                  count: r.revokeAttempts,
                  error: r.lastError,
                })
              : r.lastError}
          </p>
        )}
      <div className="flex flex-wrap gap-2 pt-1">
        {r.canDecide && (
          <>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={busy}
              onClick={() => void onAct(r.id, "approve")}
            >
              {gt("Approve")}
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => {
                const note = window.prompt(gt("Why are you denying this? (optional)")) ?? undefined;
                void onAct(r.id, "deny", note ? { note } : {});
              }}
            >
              {gt("Deny")}
            </button>
          </>
        )}
        {r.canCancel && (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => void onAct(r.id, "cancel")}
          >
            {gt("Cancel request")}
          </button>
        )}
        {r.canExtend &&
          [30, 60]
            .filter((m) => m <= headroom)
            .map((m) => (
              <button
                key={m}
                type="button"
                className={SECONDARY_BUTTON}
                disabled={busy}
                onClick={() => void onAct(r.id, "extend", { minutes: m })}
              >
                {gt("Extend {duration}", { duration: formatGrantDuration(m) })}
              </button>
            ))}
        {r.canRevoke && (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={busy}
            onClick={confirmRevoke}
          >
            {gt("Revoke now")}
          </button>
        )}
      </div>
    </li>
  );
}

function RequestForm({
  api,
  base,
  policies,
  onCancel,
  onCreated,
}: {
  api: SettingsApi;
  base: string;
  policies: JitPolicy[];
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const gt = useGT();
  const ds = useDataString();
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "");
  const policy = policies.find((p) => p.id === policyId) ?? null;
  const [targetKey, setTargetKey] = useState("0");
  const [duration, setDuration] = useState(policy?.defaultDurationMinutes ?? 60);
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const [resolution, setResolution] = useState<JitPrincipalResolution | null>(null);
  const [principals, setPrincipals] = useState<JitPrincipalOption[] | null>(null);
  const [principalId, setPrincipalId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!policy) return;
    setTargetKey("0");
    setDuration(policy.defaultDurationMinutes);
    setResolution(null);
    setPrincipals(null);
    setPrincipalId("");
    let cancelled = false;
    api
      .get<JitPrincipalResolution>(`${base}/policies/${encodeURIComponent(policy.id)}/principal`)
      .then(async (res) => {
        if (cancelled) return;
        setResolution(res);
        if (!res.principal && res.canPick) {
          const list = await api.get<JitPrincipalOption[]>(
            `${base}/policies/${encodeURIComponent(policy.id)}/principals`,
          );
          if (!cancelled) setPrincipals(list);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, base, policy]);

  const target = policy?.targets[Number(targetKey)] ?? null;
  const presets = DURATION_PRESETS.filter((m) => m <= (policy?.maxDurationMinutes ?? 0));
  const reasonOk = !policy?.requireReason || reason.trim().length >= JIT_LIMITS.minReasonLength;
  const ticketOk = !policy?.requireTicket || ticket.trim().length > 0;
  const principalOk = Boolean(resolution?.principal) || Boolean(principalId);
  const labels = resolution?.labels ?? policy?.labels ?? null;

  async function submit() {
    if (!policy || !target) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`${base}/requests`, {
        policyId: policy.id,
        scopeId: target.scopeId,
        roleId: target.roleId,
        durationMinutes: duration,
        reason: reason.trim(),
        ...(ticket.trim() ? { ticket: ticket.trim() } : {}),
        ...(!resolution?.principal && principalId ? { principalId } : {}),
      });
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not raise the request"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>{gt("Policy")}</span>
          <select className={INPUT} value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.accountName ? ` (${p.accountName})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>
            {labels ? `${ds(labels.roleLabel)} / ${ds(labels.scopeLabel)}` : gt("Role")}
          </span>
          <select
            className={INPUT}
            value={targetKey}
            onChange={(e) => setTargetKey(e.target.value)}
          >
            {(policy?.targets ?? []).map((t, i) => (
              <option key={`${t.scopeId}:${t.roleId}`} value={String(i)}>
                {`${t.roleName} · ${t.scopeName}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset>
        <legend className={LABEL}>{gt("For how long")}</legend>
        <div className="flex flex-wrap gap-2">
          {presets.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={duration === m}
              className={duration === m ? PRIMARY_BUTTON : SECONDARY_BUTTON}
              onClick={() => setDuration(m)}
            >
              {formatGrantDuration(m)}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <span className={LABEL}>{labels ? ds(labels.principalLabel) : gt("Granted to")}</span>
        {resolution === null ? (
          <p className="text-sm text-on-surface-faint">{gt("Looking you up in the provider…")}</p>
        ) : resolution.principal ? (
          <p className="text-sm text-on-surface-secondary">
            {resolution.principal.name}
            {resolution.principal.email && resolution.principal.email !== resolution.principal.name
              ? ` (${resolution.principal.email})`
              : ""}
          </p>
        ) : resolution.canPick ? (
          <select
            className={INPUT}
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            aria-label={gt("Pick who receives the grant")}
          >
            <option value="">{gt("Pick yourself from the list…")}</option>
            {(principals ?? []).map((p) => (
              <option key={`${p.kind}:${p.id}`} value={p.id}>
                {p.email && p.email !== p.name ? `${p.name} (${p.email})` : p.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-danger">
            {gt("Nobody in the provider matches your email address, so this cannot be requested.")}
          </p>
        )}
        {labels?.providerEnforcedExpiry && (
          <p className="text-xs text-on-surface-tertiary mt-1">
            {gt("The provider itself ends this access on time, as well as Infrawrench.")}
          </p>
        )}
      </div>

      <label className="block">
        <span className={LABEL}>
          {policy?.requireReason ? gt("Reason (required)") : gt("Reason")}
        </span>
        <textarea
          className={INPUT}
          rows={3}
          value={reason}
          maxLength={JIT_LIMITS.maxReasonLength}
          onChange={(e) => setReason(e.target.value)}
          placeholder={gt("What you need it for. Approvers and the audit log read this.")}
        />
      </label>
      <label className="block">
        <span className={LABEL}>
          {policy?.requireTicket ? gt("Ticket (required)") : gt("Ticket (optional)")}
        </span>
        <input
          className={INPUT}
          value={ticket}
          maxLength={JIT_LIMITS.maxTicketLength}
          onChange={(e) => setTicket(e.target.value)}
          placeholder={gt("A ticket or incident reference")}
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className={PRIMARY_BUTTON}
          disabled={submitting || !target || !reasonOk || !ticketOk || !principalOk}
        >
          {submitting ? gt("Sending…") : gt("Send request")}
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
          {gt("Cancel")}
        </button>
      </div>
    </form>
  );
}
