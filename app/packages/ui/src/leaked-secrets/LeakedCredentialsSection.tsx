import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  LEAKED_SECRET_STATUSES,
  leakLocationLabel,
  leakSeverity,
  type LeakDismissReason,
  type LeakRotateInput,
  type LeakedSecret,
  type LeakedSecretListResponse,
  type LeakedSecretStatus,
} from "@infrawrench/client-core";

import { useDataString } from "../i18n/data-strings.js";

/**
 * The transport a host hands the section. Web wraps `apiFetch`, desktop the
 * cloud IPC. Only `list` is required: a host without `secrets:write` passes
 * just that and the section is read-only.
 */
export interface LeakedCredentialsClient {
  list(): Promise<LeakedSecretListResponse>;
  rotate?(id: string, input: LeakRotateInput): Promise<LeakedSecret>;
  markRotated?(id: string, input: { resolveUpstream?: boolean }): Promise<LeakedSecret>;
  dismiss?(
    id: string,
    input: { reason: LeakDismissReason; comment?: string; resolveUpstream?: boolean },
  ): Promise<LeakedSecret>;
  reopen?(id: string): Promise<LeakedSecret>;
  scan?(): Promise<{ scanned: number; newLeaks: number; errors: number }>;
}

export interface LeakedCredentialsSectionProps {
  client: LeakedCredentialsClient;
  /** Open a connected account's page (to update its credentials). */
  onOpenAccount?: ((accountId: string) => void) | undefined;
  /** Open the resource a stored secret lives on. */
  onOpenResource?: ((leak: LeakedSecret) => void) | undefined;
  /** Open a provider page. Absent, links open in a new tab. */
  openExternal?: ((url: string) => void) | undefined;
  /** Leak to scroll to and expand, from a push or the account banner. */
  focusLeakId?: string | null | undefined;
}

type Panel = { id: string; kind: "rotate" | "replace" | "mark" | "dismiss" } | null;

function ExternalLink({
  url,
  children,
  openExternal,
}: {
  url: string;
  children: React.ReactNode;
  openExternal?: ((url: string) => void) | undefined;
}) {
  if (openExternal) {
    return (
      <button
        type="button"
        onClick={() => openExternal(url)}
        className="underline hover:text-on-surface"
      >
        {children}
      </button>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-on-surface">
      {children}
    </a>
  );
}

function useStatusLabels(): Record<LeakedSecretStatus, string> {
  const gt = useGT();
  return {
    open: gt("Open"),
    rotated: gt("Rotated"),
    dismissed: gt("Dismissed"),
    resolved: gt("Resolved upstream"),
  };
}

function useDismissReasons(): Array<{ key: LeakDismissReason; label: string }> {
  const gt = useGT();
  return [
    { key: "false-positive", label: gt("False positive") },
    { key: "used-in-tests", label: gt("Used in tests") },
    { key: "wont-fix", label: gt("Won't fix") },
  ];
}

/**
 * The "Leaked credentials" category of the Posture tab: secrets a scanner
 * account found committed to code, what each one belongs to, and the action
 * that closes it. The server decides which action applies
 * (`leak.rotation.mode`); this component only renders it.
 */
export function LeakedCredentialsSection({
  client,
  onOpenAccount,
  onOpenResource,
  openExternal,
  focusLeakId,
}: LeakedCredentialsSectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const statusLabels = useStatusLabels();
  const dismissReasons = useDismissReasons();
  const [data, setData] = useState<LeakedSecretListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LeakedSecretStatus>("open");
  const [panel, setPanel] = useState<Panel>(null);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState<LeakDismissReason>("false-positive");
  const [comment, setComment] = useState("");
  const [resolveUpstream, setResolveUpstream] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await client.list());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const leaks = useMemo(
    () => (data?.leaks ?? []).filter((l) => l.status === status),
    [data, status],
  );

  function openPanel(next: Panel) {
    setActionError(null);
    setValue("");
    setComment("");
    setReason("false-positive");
    setResolveUpstream(true);
    setPanel(next);
  }

  async function act(leak: LeakedSecret, run: () => Promise<LeakedSecret>) {
    setPending(leak.id);
    setActionError(null);
    try {
      const updated = await run();
      setData((d) =>
        d
          ? {
              ...d,
              leaks: d.leaks.map((l) => (l.id === updated.id ? updated : l)),
              counts: {
                ...d.counts,
                [leak.status]: Math.max(0, d.counts[leak.status] - 1),
                [updated.status]:
                  d.counts[updated.status] + (updated.status === leak.status ? 0 : 1),
              },
            }
          : d,
      );
      setPanel(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  async function scanNow() {
    if (!client.scan) return;
    setScanning(true);
    setScanNote(null);
    try {
      const r = await client.scan();
      setScanNote(
        r.errors > 0
          ? gt("Scanned {scanned} accounts, {errors} failed. New leaks: {newLeaks}.", {
              scanned: r.scanned,
              errors: r.errors,
              newLeaks: r.newLeaks,
            })
          : gt("Scanned {scanned} accounts. New leaks: {newLeaks}.", {
              scanned: r.scanned,
              newLeaks: r.newLeaks,
            }),
      );
      await load();
    } catch (e) {
      setScanNote(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  const canWrite = Boolean(client.rotate || client.markRotated || client.dismiss);

  function targetText(leak: LeakedSecret): string {
    if (leak.matchKind === "account") {
      const name = leak.matchedAccountName ?? leak.matchedAccountId ?? "";
      return leak.matchConfidence === "token-type"
        ? gt("Probably account {name} (matched by token type)", { name })
        : gt("Account {name}", { name });
    }
    if (leak.matchKind === "output" || leak.matchKind === "secret-field") {
      return gt("Stored on {resource}", {
        resource: leak.matchedResourceName ?? leak.matchedResourceId ?? "",
      });
    }
    if (leak.candidateAccountIds.length > 0) {
      return gt("One of {count} {provider} accounts (matched by token type)", {
        count: leak.candidateAccountIds.length,
        provider: gtData(leak.ownerPluginName ?? ""),
      });
    }
    return gt("Not a credential Infrawrench holds");
  }

  function statusLine(leak: LeakedSecret): string | null {
    if (leak.status === "rotated" && leak.rotatedAt) {
      const when = new Date(leak.rotatedAt).toLocaleString();
      const how =
        leak.rotationMethod === "reissued"
          ? gt("Reissued in Infrawrench")
          : leak.rotationMethod === "replaced"
            ? gt("New value stored")
            : leak.rotationMethod === "detected"
              ? gt("Stored value changed")
              : gt("Marked rotated");
      return leak.rotatedBy
        ? gt("{how} by {who}, {when}", { how, who: leak.rotatedBy, when })
        : gt("{how}, {when}", { how, when });
    }
    if (leak.status === "dismissed" && leak.dismissedReason) {
      const label = dismissReasons.find((r) => r.key === leak.dismissedReason)?.label ?? "";
      return leak.dismissedComment
        ? gt("Dismissed: {reason}. {comment}", { reason: label, comment: leak.dismissedComment })
        : gt("Dismissed: {reason}", { reason: label });
    }
    if (leak.status === "resolved") {
      return gt("Closed on the scanner ({resolution})", {
        resolution: leak.upstreamResolution ?? "resolved",
      });
    }
    return null;
  }

  return (
    <section aria-labelledby="leaked-credentials-heading" className="mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-1">
        <h2 id="leaked-credentials-heading" className="text-base font-semibold">
          {gt("Leaked credentials")}
        </h2>
        {client.scan && (data?.scanners.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => void scanNow()}
            disabled={scanning}
            className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors disabled:opacity-50"
          >
            {scanning ? gt("Scanning…") : gt("Scan now")}
          </button>
        )}
      </div>
      <p className="text-sm text-on-surface-muted mb-3">
        {gt(
          "Secrets found committed to code by GitHub secret scanning or GitLab secret detection, matched to the account or stored secret they belong to. Infrawrench compares keyed fingerprints and never sends a stored secret anywhere.",
        )}
      </p>

      {error != null && (
        <p role="alert" className="mb-3 text-xs text-danger">
          {gt("Couldn't load leaked credentials: {error}", { error })}{" "}
          <button type="button" onClick={() => void load()} className="underline">
            {gt("Retry")}
          </button>
        </p>
      )}
      {scanNote && (
        <p role="status" className="mb-3 text-xs text-on-surface-tertiary">
          {scanNote}
        </p>
      )}

      {data !== null && data.scanners.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "No scanner connected. Add a GitHub organization or a GitLab account to start finding credentials committed to code.",
          )}
        </p>
      )}

      {data !== null && data.scanners.length > 0 && (
        <>
          <ul className="mb-3 flex flex-col gap-0.5 text-xs text-on-surface-faint">
            {data.scanners.map((s) => (
              <li key={s.accountId}>
                {s.lastError
                  ? gt("{account} ({scanner}): last scan failed: {error}", {
                      account: s.accountName,
                      scanner: gtData(s.label),
                      error: s.lastError,
                    })
                  : s.lastScannedAt
                    ? gt("{account} ({scanner}): scanned {when}", {
                        account: s.accountName,
                        scanner: gtData(s.label),
                        when: new Date(s.lastScannedAt).toLocaleString(),
                      })
                    : gt("{account} ({scanner}): first scan pending", {
                        account: s.accountName,
                        scanner: gtData(s.label),
                      })}
                {!s.returnsSecretValue && (
                  <span>
                    {" "}
                    {gt(
                      "This scanner never returns the secret, so its findings match by token type only.",
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div
            role="tablist"
            aria-label={gt("Leak status")}
            className="mb-3 flex rounded-lg border border-border overflow-hidden w-fit text-xs"
          >
            {LEAKED_SECRET_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={status === s}
                onClick={() => {
                  setStatus(s);
                  setPanel(null);
                }}
                className={`px-2.5 py-1 transition-colors ${
                  status === s
                    ? "bg-surface-overlay text-on-surface"
                    : "text-on-surface-tertiary hover:text-on-surface-secondary"
                }`}
              >
                {gt("{status} ({count})", { status: statusLabels[s], count: data.counts[s] })}
              </button>
            ))}
          </div>

          {actionError != null && (
            <p role="alert" className="mb-3 text-xs text-danger">
              {actionError}
            </p>
          )}

          {leaks.length === 0 ? (
            <p className="text-sm text-on-surface-faint">
              {status === "open" ? gt("No open leaks.") : gt("Nothing here.")}
            </p>
          ) : (
            <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
              {leaks.map((leak) => {
                const critical = leakSeverity(leak) === "critical";
                const busy = pending === leak.id;
                const isOpen = leak.status === "open";
                const location = leakLocationLabel(leak);
                const line = statusLine(leak);
                const scannerName = gtData(
                  data.scanners.find((s) => s.accountId === leak.scannerAccountId)?.label ?? "",
                );
                return (
                  <li
                    key={leak.id}
                    id={`leak-${leak.id}`}
                    className={`px-4 py-3 text-sm ${focusLeakId === leak.id ? "bg-surface-overlay" : ""}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {isOpen && (
                            <span
                              className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                                critical
                                  ? "bg-danger-surface text-danger"
                                  : "bg-warning-surface text-warning"
                              }`}
                            >
                              {critical ? gt("Critical") : gt("High")}
                            </span>
                          )}
                          <span className="font-medium text-on-surface">
                            {gtData(leak.tokenTypeLabel)}
                          </span>
                          {leak.secretHint && (
                            <code className="text-xs text-on-surface-tertiary">
                              {leak.secretHint}
                            </code>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-on-surface-tertiary">
                          {location && leak.url ? (
                            <ExternalLink url={leak.url} openExternal={openExternal}>
                              {location}
                            </ExternalLink>
                          ) : (
                            location
                          )}
                          {leak.publiclyLeaked && (
                            <span className="ml-2 text-danger">{gt("Also public")}</span>
                          )}
                          {leak.validity === "active" && (
                            <span className="ml-2 text-danger">{gt("Still valid")}</span>
                          )}
                          {leak.validity === "inactive" && (
                            <span className="ml-2">{gt("No longer valid")}</span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-on-surface-secondary">
                          {leak.matchKind === "output" || leak.matchKind === "secret-field" ? (
                            onOpenResource ? (
                              <button
                                type="button"
                                className="underline"
                                onClick={() => onOpenResource(leak)}
                              >
                                {targetText(leak)}
                              </button>
                            ) : (
                              targetText(leak)
                            )
                          ) : leak.matchKind === "account" &&
                            leak.matchedAccountId &&
                            onOpenAccount ? (
                            <button
                              type="button"
                              className="underline"
                              onClick={() => onOpenAccount(leak.matchedAccountId!)}
                            >
                              {targetText(leak)}
                            </button>
                          ) : (
                            targetText(leak)
                          )}
                          <span className="ml-2 text-on-surface-faint">
                            {gt("Detected {when}", {
                              when: new Date(leak.detectedAt).toLocaleDateString(),
                            })}
                          </span>
                        </div>
                        {line && (
                          <div className="mt-0.5 text-xs text-on-surface-tertiary">{line}</div>
                        )}
                        {leak.upstreamResolveError && (
                          <div className="mt-0.5 text-xs text-warning">
                            {gt("Couldn't close it on the scanner: {error}", {
                              error: leak.upstreamResolveError,
                            })}
                          </div>
                        )}
                      </div>

                      {canWrite && (
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          {isOpen && leak.rotation.mode === "reissue" && client.rotate && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openPanel({ id: leak.id, kind: "rotate" })}
                              className="px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
                            >
                              {gt("Rotate")}
                            </button>
                          )}
                          {isOpen && leak.rotation.mode === "replace" && client.rotate && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openPanel({ id: leak.id, kind: "replace" })}
                              className="px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
                            >
                              {gt("Replace value")}
                            </button>
                          )}
                          {isOpen && leak.rotation.manageUrl && (
                            <ExternalLink url={leak.rotation.manageUrl} openExternal={openExternal}>
                              {gt("Manage keys at {provider}", {
                                provider: gtData(leak.ownerPluginName ?? ""),
                              })}
                            </ExternalLink>
                          )}
                          {isOpen &&
                            leak.rotation.mode === "account" &&
                            leak.matchedAccountId &&
                            onOpenAccount && (
                              <button
                                type="button"
                                onClick={() => onOpenAccount(leak.matchedAccountId!)}
                                className="px-2.5 py-1 rounded-lg border border-border hover:border-border-strong"
                              >
                                {gt("Update credentials")}
                              </button>
                            )}
                          {isOpen && client.markRotated && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openPanel({ id: leak.id, kind: "mark" })}
                              className="px-2.5 py-1 rounded-lg border border-border hover:border-border-strong disabled:opacity-50"
                            >
                              {gt("Mark rotated")}
                            </button>
                          )}
                          {isOpen && client.dismiss && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openPanel({ id: leak.id, kind: "dismiss" })}
                              className="px-2.5 py-1 text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
                            >
                              {gt("Dismiss")}
                            </button>
                          )}
                          {!isOpen && leak.status !== "resolved" && client.reopen && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void act(leak, () => client.reopen!(leak.id))}
                              className="px-2.5 py-1 text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
                            >
                              {gt("Reopen")}
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {panel?.id === leak.id && (
                      <div className="mt-3 rounded-lg border border-border bg-surface-raised p-3 text-xs flex flex-col gap-2">
                        {panel.kind === "rotate" && (
                          <p>
                            {leak.matchKind === "output"
                              ? gt(
                                  "Issues a new value for {field} on {resource}, and every resource that references it is updated with it.",
                                  {
                                    field: leak.matchedFieldKey ?? "",
                                    resource: leak.matchedResourceName ?? "",
                                  },
                                )
                              : gt("Issues a new value for {field} on {resource}.", {
                                  field: leak.matchedFieldKey ?? "",
                                  resource: leak.matchedResourceName ?? "",
                                })}{" "}
                            {gt(
                              "Anything outside Infrawrench that uses the old value stops working.",
                            )}
                          </p>
                        )}
                        {panel.kind === "replace" && (
                          <label className="flex flex-col gap-1">
                            <span>
                              {gt(
                                "Rotate it at the provider first, then paste the new value for {field}. It is pushed to the provider when the plugin supports it, then stored encrypted.",
                                { field: leak.matchedFieldKey ?? "" },
                              )}
                            </span>
                            <input
                              type="password"
                              autoComplete="off"
                              value={value}
                              onChange={(e) => setValue(e.target.value)}
                              aria-label={gt("New value")}
                              className="rounded-md border border-border bg-surface px-2 py-1 font-mono"
                            />
                          </label>
                        )}
                        {panel.kind === "mark" && (
                          <p>
                            {leak.matchKind === "account"
                              ? gt(
                                  "Update the account's credentials with the new token first; Infrawrench checks that the stored one changed.",
                                )
                              : gt("Record that the credential was rotated at the provider.")}
                          </p>
                        )}
                        {panel.kind === "dismiss" && (
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={reason}
                              onChange={(e) => setReason(e.target.value as LeakDismissReason)}
                              aria-label={gt("Reason")}
                              className="rounded-md border border-border bg-surface px-2 py-1"
                            >
                              {dismissReasons.map((r) => (
                                <option key={r.key} value={r.key}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                            <input
                              type="text"
                              value={comment}
                              maxLength={500}
                              onChange={(e) => setComment(e.target.value)}
                              placeholder={gt("Note (optional)")}
                              className="flex-1 min-w-40 rounded-md border border-border bg-surface px-2 py-1"
                            />
                          </div>
                        )}
                        {leak.canResolveUpstream && (
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={resolveUpstream}
                              onChange={(e) => setResolveUpstream(e.target.checked)}
                            />
                            {panel.kind === "dismiss"
                              ? gt("Also close the alert on {scanner}", { scanner: scannerName })
                              : gt("Close the alert on {scanner} as revoked", {
                                  scanner: scannerName,
                                })}
                          </label>
                        )}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy || (panel.kind === "replace" && value.trim() === "")}
                            onClick={() => {
                              if (panel.kind === "rotate" && client.rotate) {
                                void act(leak, () => client.rotate!(leak.id, { resolveUpstream }));
                              } else if (panel.kind === "replace" && client.rotate) {
                                void act(leak, () =>
                                  client.rotate!(leak.id, { value, resolveUpstream }),
                                );
                              } else if (panel.kind === "mark" && client.markRotated) {
                                void act(leak, () =>
                                  client.markRotated!(leak.id, { resolveUpstream }),
                                );
                              } else if (panel.kind === "dismiss" && client.dismiss) {
                                void act(leak, () =>
                                  client.dismiss!(leak.id, {
                                    reason,
                                    ...(comment.trim() ? { comment: comment.trim() } : {}),
                                    resolveUpstream,
                                  }),
                                );
                              }
                            }}
                            className="px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
                          >
                            {busy
                              ? gt("Working…")
                              : panel.kind === "dismiss"
                                ? gt("Dismiss")
                                : panel.kind === "mark"
                                  ? gt("Mark rotated")
                                  : gt("Rotate now")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPanel(null)}
                            className="px-2.5 py-1 text-on-surface-tertiary hover:text-on-surface-secondary"
                          >
                            {gt("Cancel")}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The account page banner: open leaks matched to (or possibly belonging to)
 * this account. Renders nothing when there are none.
 */
export function AccountLeakBanner({
  leaks,
  onReview,
}: {
  leaks: readonly LeakedSecret[];
  onReview?: (() => void) | undefined;
}) {
  const gt = useGT();
  const gtData = useDataString();
  if (leaks.length === 0) return null;
  const certain = leaks.some((l) => l.matchConfidence === "fingerprint");
  const first = leaks[0]!;
  return (
    <div
      role="alert"
      className="mb-4 rounded-xl border border-danger/40 bg-danger-surface px-4 py-3 text-sm text-on-surface"
    >
      <p className="font-medium text-danger">
        {leaks.length === 1
          ? gt("A credential for this account was found committed to code")
          : gt("{count} credentials for this account were found committed to code", {
              count: leaks.length,
            })}
      </p>
      <p className="mt-0.5 text-xs text-on-surface-secondary">
        {certain
          ? gt("{token} in {location}. Rotate it, then update this account.", {
              token: gtData(first.tokenTypeLabel),
              location: leakLocationLabel(first) || first.scannerAccountName,
            })
          : gt(
              "{token} in {location}. The scanner did not return the value, so it is matched by token type and may be another key from this provider.",
              {
                token: gtData(first.tokenTypeLabel),
                location: leakLocationLabel(first) || first.scannerAccountName,
              },
            )}{" "}
        {onReview && (
          <button type="button" onClick={onReview} className="underline">
            {gt("Review in Posture")}
          </button>
        )}
      </p>
    </div>
  );
}
