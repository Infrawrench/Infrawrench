import { useCallback, useEffect, useState } from "react";
import { IAC_STATUS_LABELS, type IacResourceStatus } from "@infrawrench/client-core";
import { ResourceFieldDiffList } from "../changes/ChangeParts.js";
import { formatErrorMessage } from "../utils.js";
import { IacImportPlanModal } from "./IacImportPlanModal.js";
import type {
  IacAccountOption,
  IacClient,
  IacReconciliationEntry,
  IacReconciliationResponse,
  IacStateSummary,
} from "./types.js";

const STATUS_BADGE: Record<IacResourceStatus, string> = {
  managed: "bg-green-500/10 text-green-400",
  drifted: "bg-amber-500/10 text-amber-400",
  unmanaged: "bg-red-500/10 text-red-400",
};

type StatusFilter = IacResourceStatus | "";

export interface IacPanelProps {
  /**
   * Org-scoped data access. Hosts mount the panel with `key={orgId}` so an org
   * switch remounts it rather than an effect resetting every state value.
   */
  client: IacClient;
  /** Whether the viewer may upload and delete state documents (`iac:write`). */
  canWrite?: boolean;
  /** Jump to a resource's detail view. Omitted, names are plain text. */
  onOpenResource?: ((entry: IacReconciliationEntry) => void) | undefined;
  /** Host download handler for the generated HCL; defaults to a browser download. */
  onDownload?: (file: { filename: string; mimeType: string; content: string }) => void;
}

function StatusBadge({ status }: { status: IacResourceStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[status]}`}
    >
      {IAC_STATUS_LABELS[status]}
    </span>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  active,
  onClick,
}: {
  label: string;
  value: number;
  hint: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-2xl font-semibold text-on-surface tabular-nums">{value}</div>
      <div className="text-xs text-on-surface-tertiary mt-0.5">{label}</div>
      <div className="text-[11px] text-on-surface-faint mt-1 leading-snug">{hint}</div>
    </>
  );
  const className = `rounded-xl border px-4 py-3 text-left ${
    active ? "border-blue-500/60 bg-blue-500/5" : "border-border bg-surface-raised"
  }`;
  return onClick ? (
    <button type="button" onClick={onClick} className={`${className} hover:border-border-strong`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * **Infrastructure as Code** — the ClickOps detector.
 *
 * Upload the Terraform state your organization already has, and every synced
 * resource is classified as managed, drifted, or unmanaged. The unmanaged ones
 * are the point: they are what somebody made by hand, and they can be turned
 * into `import` blocks here.
 *
 * One of four Terraform-named things in Infrawrench and the only one that
 * reads state *in* — see the feature docs. Cloud-only by nature: the inventory
 * it classifies is the org's synced resources.
 */
export function IacPanel({ client, canWrite = true, onOpenResource, onDownload }: IacPanelProps) {
  const [states, setStates] = useState<IacStateSummary[]>([]);
  const [selectedStateId, setSelectedStateId] = useState<string>("");
  const [report, setReport] = useState<IacReconciliationResponse | null>(null);
  const [accounts, setAccounts] = useState<IacAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showPlan, setShowPlan] = useState(false);

  // Upload form
  const [showUpload, setShowUpload] = useState(false);
  const [label, setLabel] = useState("");
  const [scopeAccountId, setScopeAccountId] = useState("");
  const [document, setDocument] = useState("");
  const [uploading, setUploading] = useState(false);

  const refreshStates = useCallback(async () => {
    const rows = await client.listStates();
    setStates(rows);
    setSelectedStateId((current) =>
      current && rows.some((r) => r.id === current) ? current : (rows[0]?.id ?? ""),
    );
    return rows;
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await client.listAccounts();
        if (!cancelled) setAccounts(rows);
      } catch {
        // The scope picker is a convenience; uploading without it still works.
        if (!cancelled) setAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        await refreshStates();
        if (!cancelled) setError(null);
      } catch (e) {
        if (!cancelled) setError(formatErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStates]);

  useEffect(() => {
    if (!selectedStateId) {
      setReport(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const result = await client.reconcile(selectedStateId);
        if (!cancelled) {
          setReport(result);
          setSelected(new Set());
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setReport(null);
          setError(formatErrorMessage(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selectedStateId]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    setUploading(true);
    try {
      const state = await client.uploadState({
        label: label.trim(),
        accountId: scopeAccountId || null,
        document,
      });
      await refreshStates();
      setSelectedStateId(state.id);
      setShowUpload(false);
      setLabel("");
      setDocument("");
      setScopeAccountId("");
      setError(null);
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  async function readFile(file: File) {
    try {
      setDocument(await file.text());
      if (!label.trim()) setLabel(file.name.replace(/\.json$|\.tfstate$/i, ""));
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  async function removeState(stateId: string) {
    try {
      await client.deleteState(stateId);
      await refreshStates();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  const rows = (report?.resources ?? []).filter((r) => !statusFilter || r.status === statusFilter);
  const unmanagedIds = (report?.resources ?? [])
    .filter((r) => r.status === "unmanaged")
    .map((r) => r.resourceId);

  function toggle(resourceId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(resourceId)) next.delete(resourceId);
      else next.add(resourceId);
      return next;
    });
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-on-surface">Infrastructure as Code</h1>
          <p className="text-sm text-on-surface-muted mt-1 max-w-[70ch]">
            Upload the Terraform state you already have and every synced resource is classified as
            managed, drifted, or unmanaged. The unmanaged ones are what somebody made by hand — and
            they can be turned into <code>import</code> blocks from here.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowUpload((v) => !v)}
            className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors shrink-0"
          >
            {showUpload ? "Cancel" : "Upload state"}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-100 dark:bg-red-900/20 border border-red-500/30 px-3 py-2 text-xs text-red-700 dark:text-red-200 break-words">
          {error}
        </div>
      )}

      {showUpload && canWrite && (
        <form
          onSubmit={(e) => void upload(e)}
          className="rounded-xl border border-border bg-surface-raised p-4 space-y-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-on-surface-tertiary">
              Label
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
                maxLength={120}
                placeholder="prod / us-east-1"
                className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface"
              />
            </label>
            <label className="text-xs text-on-surface-tertiary">
              Scope
              <select
                value={scopeAccountId}
                onChange={(e) => setScopeAccountId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface"
              >
                <option value="">Whole organization</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-xs text-on-surface-tertiary">
            State document
            <input
              type="file"
              accept=".json,.tfstate,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
              className="mt-1 block w-full text-xs text-on-surface-tertiary"
            />
          </label>
          <textarea
            value={document}
            onChange={(e) => setDocument(e.target.value)}
            required
            rows={6}
            placeholder="Paste a .tfstate or the output of `terraform show -json`"
            className="w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 font-mono text-[11px] text-on-surface"
          />
          <p className="text-[11px] text-on-surface-faint leading-snug">
            Both formats are accepted and version-checked. Attributes the state marks sensitive are
            dropped before anything is stored, and the document itself is never kept — only the
            attributes the drift comparison reads.
          </p>
          <button
            type="submit"
            disabled={uploading || !document}
            className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
          >
            {uploading ? "Parsing…" : "Upload"}
          </button>
        </form>
      )}

      {states.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs text-on-surface-tertiary">
            State
            <select
              value={selectedStateId}
              onChange={(e) => setSelectedStateId(e.target.value)}
              className="ml-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface"
            >
              {states.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.accountName ?? "whole org"} · {s.resourceCount} resources
                </option>
              ))}
            </select>
          </label>
          {report && (
            <span className="text-[11px] text-on-surface-faint">
              {report.state.format === "tfstate" ? "state file v" : "terraform show -json v"}
              {report.state.formatVersion}
              {report.state.terraformVersion ? ` · Terraform ${report.state.terraformVersion}` : ""}
              {report.state.redactedAttributeCount > 0
                ? ` · ${report.state.redactedAttributeCount} sensitive attribute(s) redacted`
                : ""}
              {" · uploaded "}
              {new Date(report.state.createdAt).toLocaleString()}
              {report.state.uploadedByName ? ` by ${report.state.uploadedByName}` : ""}
            </span>
          )}
          {canWrite && selectedStateId && (
            <button
              type="button"
              onClick={() => void removeState(selectedStateId)}
              className="text-[11px] text-on-surface-faint hover:text-red-400"
            >
              Delete this state
            </button>
          )}
        </div>
      )}

      {loading && <p className="text-xs text-on-surface-faint">Loading…</p>}

      {!loading && states.length === 0 && (
        <div className="rounded-xl border border-border bg-surface-raised px-4 py-6 text-center">
          <p className="text-sm text-on-surface-tertiary">No state uploaded yet.</p>
          <p className="text-xs text-on-surface-faint mt-1 max-w-[60ch] mx-auto">
            Run <code>terraform show -json &gt; state.json</code> in your workspace and upload the
            result. Until then Infrawrench has no way to tell a resource Terraform manages from one
            somebody clicked into existence — and it will not guess.
          </p>
        </div>
      )}

      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryTile
              label="Managed"
              value={report.summary.managed}
              hint="Matched a state entry and agrees with it."
              active={statusFilter === "managed"}
              onClick={() => setStatusFilter((f) => (f === "managed" ? "" : "managed"))}
            />
            <SummaryTile
              label="Drifted"
              value={report.summary.drifted}
              hint="Matched, but the live fields differ from state."
              active={statusFilter === "drifted"}
              onClick={() => setStatusFilter((f) => (f === "drifted" ? "" : "drifted"))}
            />
            <SummaryTile
              label="Unmanaged"
              value={report.summary.unmanaged}
              hint="In your inventory, absent from state."
              active={statusFilter === "unmanaged"}
              onClick={() => setStatusFilter((f) => (f === "unmanaged" ? "" : "unmanaged"))}
            />
            <SummaryTile
              label="In state only"
              value={report.summary.stateOnly}
              hint="Terraform thinks it exists; nothing in inventory matches."
            />
          </div>

          {report.summary.undiffable > 0 && (
            <p className="text-[11px] text-on-surface-faint">
              {report.summary.undiffable} managed resource
              {report.summary.undiffable === 1 ? "" : "s"} could not be mapped to a Terraform block,
              so drift for {report.summary.undiffable === 1 ? "it" : "them"} is unknown rather than
              absent.
            </p>
          )}

          {unmanagedIds.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => setSelected(new Set(unmanagedIds))}
                className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
              >
                Select all {unmanagedIds.length} unmanaged
              </button>
              {selected.size > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="text-xs text-on-surface-faint hover:text-on-surface-secondary"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPlan(true)}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
                  >
                    Generate import blocks ({selected.size})
                  </button>
                </>
              )}
            </div>
          )}

          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-[11px] uppercase tracking-wide text-on-surface-faint">
                <tr>
                  <th className="w-8" />
                  <th className="text-left px-3 py-2 font-medium">Resource</th>
                  <th className="text-left px-3 py-2 font-medium">Terraform</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Owner</th>
                  <th className="text-left px-3 py-2 font-medium">First seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-xs text-on-surface-faint">
                      Nothing in this category.
                    </td>
                  </tr>
                )}
                {rows.map((entry) => {
                  const expanded = expandedId === entry.resourceId;
                  return (
                    <tr
                      key={entry.resourceId}
                      className="border-t border-border align-top hover:bg-surface-overlay/40"
                    >
                      <td className="px-2 py-2">
                        {entry.status === "unmanaged" && (
                          <input
                            type="checkbox"
                            checked={selected.has(entry.resourceId)}
                            onChange={() => toggle(entry.resourceId)}
                            aria-label={`Select ${entry.displayName}`}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {onOpenResource ? (
                          <button
                            type="button"
                            onClick={() => onOpenResource(entry)}
                            className="text-on-surface hover:underline text-left"
                          >
                            {entry.displayName}
                          </button>
                        ) : (
                          <span className="text-on-surface">{entry.displayName}</span>
                        )}
                        <div className="text-[11px] text-on-surface-faint">
                          {entry.pluginId} · {entry.resourceTypeId}
                        </div>
                        {entry.unmappableReason && (
                          <div className="text-[11px] text-amber-500/80 mt-0.5">
                            {entry.unmappableReason}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-[11px] text-on-surface-tertiary break-all">
                          {entry.terraformAddress ?? entry.terraformType ?? "—"}
                        </span>
                        {entry.matchedBy && (
                          <div className="text-[11px] text-on-surface-faint">
                            matched by {entry.matchedBy}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={entry.status} />
                        {entry.drift.length > 0 && (
                          <>
                            <button
                              type="button"
                              onClick={() => setExpandedId(expanded ? null : entry.resourceId)}
                              className="block text-[11px] text-on-surface-faint hover:text-on-surface-secondary mt-1"
                            >
                              {entry.drift.length} field{entry.drift.length === 1 ? "" : "s"} differ
                              {entry.drift.length === 1 ? "s" : ""}
                            </button>
                            {expanded && <ResourceFieldDiffList diff={entry.drift} />}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-on-surface-tertiary">
                        {entry.owner ? (
                          <>
                            {entry.owner.displayName}
                            {entry.owner.isLabel && (
                              <span className="text-on-surface-faint"> (label)</span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-on-surface-tertiary">
                        {entry.firstSeenAt ? new Date(entry.firstSeenAt).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {report.stateOnly.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-on-surface">In state, not in inventory</h2>
              <p className="text-xs text-on-surface-faint mt-0.5 max-w-[70ch]">
                Terraform believes these exist. Either the account holding them is not connected
                here, the resource type is not synced yet, or the object is gone upstream and the
                state is stale.
              </p>
              <ul className="mt-2 space-y-1">
                {report.stateOnly.map((entry) => (
                  <li key={entry.address} className="text-xs text-on-surface-tertiary">
                    <span className="font-mono">{entry.address}</span>
                    {entry.reason === "unknown-terraform-type" ? (
                      <span className="text-on-surface-faint">
                        {" "}
                        — no Infrawrench plugin maps <code>{entry.terraformType}</code>
                      </span>
                    ) : (
                      <span className="text-on-surface-faint">
                        {" "}
                        — expected{" "}
                        {entry.candidates
                          .map((c) => `${c.pluginId}/${c.resourceTypeId}`)
                          .join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.underivable.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-on-surface">Coverage gaps</h2>
              <p className="text-xs text-on-surface-faint mt-0.5 max-w-[70ch]">
                The Terraform type for these resource types could not be derived from the
                plugin&apos;s own export mapper, so a state entry of that type cannot be attributed
                back to a plugin. Resources of these types still match when Infrawrench holds the
                live resource — this only affects the &ldquo;in state only&rdquo; list above.
              </p>
              <ul className="mt-2 space-y-1">
                {report.underivable.map((u) => (
                  <li
                    key={`${u.pluginId}/${u.resourceTypeId}`}
                    className="text-xs text-on-surface-faint"
                  >
                    <span className="font-mono">
                      {u.pluginId}/{u.resourceTypeId}
                    </span>{" "}
                    — {u.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {showPlan && (
        <IacImportPlanModal
          requestedCount={selected.size}
          generate={() => client.buildImportPlan([...selected])}
          onClose={() => setShowPlan(false)}
          {...(onDownload ? { onDownload } : {})}
        />
      )}
    </div>
  );
}
