import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  OFFBOARDING_ACTIONS_NEEDING_TARGET,
  normalizeAliases,
  offboardingItemActionable,
  type Offboarding,
  type OffboardingActionId,
  type OffboardingActionInput,
  type OffboardingActionResult,
  type OffboardingItem,
  type OffboardingItemKind,
  type OffboardingItemUpdate,
  type OffboardingListResponse,
  type OffboardingMember,
  type OffboardingStartInput,
  type OffboardingStartResponse,
  type OffboardingSummary,
} from "@infrawrench/client-core";
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../settings/styles.js";

/**
 * Transport for the offboarding tab. Web backs it with fetch, desktop with the
 * contract's `offboarding` domain over the cloud transport.
 */
export interface OffboardingClient {
  list(): Promise<OffboardingListResponse>;
  get(id: string): Promise<Offboarding>;
  start(input: OffboardingStartInput): Promise<OffboardingStartResponse>;
  update(
    id: string,
    patch: { aliases?: string[]; note?: string | null; status?: Offboarding["status"] },
  ): Promise<Offboarding>;
  rescan(id: string): Promise<Offboarding>;
  updateItem(id: string, itemId: string, patch: OffboardingItemUpdate): Promise<OffboardingItem>;
  act(id: string, itemId: string, input: OffboardingActionInput): Promise<OffboardingActionResult>;
  members(): Promise<{ members: OffboardingMember[] }>;
  /** Save the checklist as CSV (a navigation on web, a generated download on desktop). */
  exportCsv(offboarding: Offboarding): void | Promise<void>;
}

export interface OffboardingPanelProps {
  client: OffboardingClient;
  /** The offboarding open in the tab; omitted for the list. */
  offboardingId?: string | undefined;
  /** Open one offboarding, or go back to the list with `undefined`. */
  onSelect: (offboardingId: string | undefined) => void;
  /** Open a synced resource the checklist names. */
  onOpenResource?: ((item: OffboardingItem) => void) | undefined;
}

type Group = "infrawrench" | "access" | "seats" | "resources" | "on-call" | "grants";

const GROUP_OF: Record<OffboardingItemKind, Group> = {
  member: "infrawrench",
  "api-key": "infrawrench",
  "ssh-key": "infrawrench",
  principal: "access",
  seat: "seats",
  resource: "resources",
  "on-call": "on-call",
  "on-call-cover": "on-call",
  lease: "grants",
  "jit-grant": "grants",
};

const GROUP_ORDER: readonly Group[] = [
  "infrawrench",
  "access",
  "seats",
  "resources",
  "on-call",
  "grants",
];

/** Actions that cannot be taken back, so they ask first. */
const ASKS_FIRST: ReadonlySet<OffboardingActionId> = new Set([
  "revoke",
  "remove",
  "remove-seat",
  "remove-member",
  "revoke-api-key",
  "delete-ssh-key",
  "remove-from-rotation",
  "cancel-cover",
  "cancel-lease",
  "revoke-jit",
]);

function useLabels() {
  const gt = useGT();
  return useMemo(
    () => ({
      group(group: Group): string {
        switch (group) {
          case "infrawrench":
            return gt("Infrawrench");
          case "access":
            return gt("Cloud access");
          case "seats":
            return gt("Paid seats");
          case "resources":
            return gt("Resources");
          case "on-call":
            return gt("On-call");
          case "grants":
            return gt("Leases and grants");
        }
      },
      kind(kind: OffboardingItemKind): string {
        switch (kind) {
          case "member":
            return gt("Organization membership");
          case "api-key":
            return gt("API key");
          case "ssh-key":
            return gt("SSH key");
          case "principal":
            return gt("Principal");
          case "seat":
            return gt("Seat");
          case "resource":
            return gt("Resource");
          case "on-call":
            return gt("Rotation");
          case "on-call-cover":
            return gt("Cover");
          case "lease":
            return gt("Lease");
          case "jit-grant":
            return gt("Just-in-time grant");
        }
      },
      action(action: OffboardingActionId): string {
        switch (action) {
          case "revoke":
            return gt("Revoke");
          case "remove":
            return gt("Remove");
          case "remove-seat":
            return gt("Remove seat");
          case "remove-member":
            return gt("Remove from organization");
          case "revoke-api-key":
            return gt("Revoke key");
          case "delete-ssh-key":
            return gt("Delete key");
          case "transfer-ownership":
            return gt("Transfer ownership");
          case "reassign-on-call":
            return gt("Reassign");
          case "remove-from-rotation":
            return gt("Remove from rotation");
          case "cancel-cover":
            return gt("Cancel cover");
          case "cancel-lease":
            return gt("Cancel lease");
          case "revoke-jit":
            return gt("Revoke grant");
        }
      },
      confidence(item: OffboardingItem): string {
        switch (item.confidence) {
          case "exact":
            return gt("Exact");
          case "alias":
            return gt("Alias");
          case "possible":
            return item.matchState === "confirmed" ? gt("Confirmed") : gt("Possible");
        }
      },
      status(item: OffboardingItem): string {
        switch (item.status) {
          case "open":
            return gt("Open");
          case "done":
            return gt("Done");
          case "skipped":
            return gt("Skipped");
          case "failed":
            return gt("Failed");
          case "gone":
            return gt("No longer found");
        }
      },
      offboardingStatus(status: OffboardingSummary["status"]): string {
        switch (status) {
          case "open":
            return gt("In progress");
          case "completed":
            return gt("Completed");
          case "canceled":
            return gt("Canceled");
        }
      },
    }),
    [gt],
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ProgressBar({ resolved, total }: { resolved: number; total: number }) {
  const gt = useGT();
  const pct = total === 0 ? 100 : Math.round((resolved / total) * 100);
  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <div
        className="h-1.5 flex-1 rounded-full bg-surface-overlay overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={resolved}
        aria-label={gt("Progress")}
      >
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-on-surface-tertiary tabular-nums whitespace-nowrap">
        {gt("{resolved} of {total}", { resolved, total })}
      </span>
    </div>
  );
}

/** The list of offboardings, with the start form above it. */
function OffboardingList({
  client,
  onSelect,
}: {
  client: OffboardingClient;
  onSelect: (id: string) => void;
}) {
  const gt = useGT();
  const labels = useLabels();
  const [list, setList] = useState<OffboardingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [aliases, setAliases] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .list()
      .then((r) => {
        if (!cancelled) {
          setList(r.offboardings);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const result = await client.start({
        email: email.trim(),
        aliases: normalizeAliases(aliases.split(/[\s,]+/), email),
      });
      onSelect(result.offboarding.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-4">{gt("Offboarding")}</h1>

      <form
        className="flex flex-wrap items-end gap-2 mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label className="flex flex-col gap-1 min-w-[240px] flex-1 max-w-sm">
          <span className="text-xs text-on-surface-tertiary">{gt("Email")}</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // i18n-ignore: example email address
            placeholder="jane@example.com"
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 min-w-[240px] flex-1 max-w-sm">
          <span className="text-xs text-on-surface-tertiary">{gt("Aliases")}</span>
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder={gt("GitHub login, other addresses")}
            className={INPUT}
          />
        </label>
        <button type="submit" disabled={starting || !email.trim()} className={PRIMARY_BUTTON}>
          {starting ? gt("Sweeping…") : gt("Start offboarding")}
        </button>
      </form>

      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {list === null && !error && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading…")}
        </p>
      )}
      {list !== null && list.length === 0 && (
        <p className="text-sm text-on-surface-faint">{gt("No offboardings yet.")}</p>
      )}
      {list !== null && list.length > 0 && (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-on-surface-faint">
                <th className="px-4 py-2 font-medium">{gt("Person")}</th>
                <th className="px-3 py-2 font-medium">{gt("Status")}</th>
                <th className="px-3 py-2 font-medium">{gt("Progress")}</th>
                <th className="px-3 py-2 font-medium">{gt("Started")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr
                  key={o.id}
                  tabIndex={0}
                  onClick={() => onSelect(o.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(o.id);
                    }
                  }}
                  className="border-b border-border last:border-b-0 cursor-pointer hover:bg-surface-raised"
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-on-surface-secondary">
                      {o.name ?? o.email}
                    </span>
                    {o.name && (
                      <span className="block text-xs text-on-surface-faint">{o.email}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-on-surface-tertiary whitespace-nowrap">
                    {labels.offboardingStatus(o.status)}
                    {o.source === "directory" && (
                      <span className="block text-on-surface-faint">
                        {gt("From the directory")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <ProgressBar resolved={o.progress.resolved} total={o.progress.total} />
                  </td>
                  <td className="px-3 py-2.5 text-xs text-on-surface-tertiary whitespace-nowrap">
                    {formatDate(o.createdAt)}
                    {o.startedByName && (
                      <span className="block text-on-surface-faint">{o.startedByName}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  item: OffboardingItem;
  closed: boolean;
  busy: boolean;
  members: OffboardingMember[] | null;
  onAct: (item: OffboardingItem, action: OffboardingActionId, targetUserId?: string) => void;
  onUpdate: (item: OffboardingItem, patch: OffboardingItemUpdate) => void;
  onNeedMembers: () => void;
  onOpenResource?: ((item: OffboardingItem) => void) | undefined;
}

function ItemRow({
  item,
  closed,
  busy,
  members,
  onAct,
  onUpdate,
  onNeedMembers,
  onOpenResource,
}: RowProps) {
  const gt = useGT();
  const labels = useLabels();
  const [handing, setHanding] = useState<OffboardingActionId | null>(null);
  const [target, setTarget] = useState("");
  const actionable = !closed && offboardingItemActionable(item);
  const unconfirmed = !closed && item.matchState === "unconfirmed" && item.status === "open";
  const resolved = item.status === "done" || item.status === "skipped" || item.status === "gone";
  const open = onOpenResource && item.resourceId ? () => onOpenResource(item) : undefined;

  return (
    <li className="px-4 py-3 border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[220px]">
          <div className="flex flex-wrap items-center gap-2">
            {open ? (
              <button
                type="button"
                onClick={open}
                className="font-medium text-on-surface-secondary hover:underline text-left"
              >
                {item.title}
              </button>
            ) : (
              <span className="font-medium text-on-surface-secondary">{item.title}</span>
            )}
            <span className="text-xs text-on-surface-faint">{labels.kind(item.kind)}</span>
          </div>
          <p className="text-xs text-on-surface-tertiary">
            {[item.providerName, item.accountName, item.detail].filter(Boolean).join(" · ")}
          </p>
          <p className="text-xs text-on-surface-faint">
            <span
              className={`mr-1 inline-flex items-center rounded border px-1.5 text-[11px] ${
                item.confidence === "possible" && item.matchState !== "confirmed"
                  ? "border-amber-500/50 text-amber-600"
                  : "border-border text-on-surface-tertiary"
              }`}
            >
              {labels.confidence(item)}
            </span>
            {item.matchReason}
          </p>
          {item.lastError && item.status === "failed" && (
            <p role="alert" className="text-xs text-danger break-words">
              {item.lastError}
            </p>
          )}
          {resolved && (
            <p className="text-xs text-on-surface-faint">
              {labels.status(item)}
              {item.resolvedByName ? ` · ${item.resolvedByName}` : ""}
              {item.resolvedAt ? ` · ${formatDate(item.resolvedAt)}` : ""}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {unconfirmed && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onUpdate(item, { matchState: "confirmed" })}
                className={SECONDARY_BUTTON}
              >
                {gt("It's them")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onUpdate(item, { matchState: "rejected" })}
                className={SECONDARY_BUTTON}
              >
                {gt("Not them")}
              </button>
            </>
          )}
          {actionable &&
            handing === null &&
            item.actions.map((action) => (
              <button
                key={action}
                type="button"
                disabled={busy}
                onClick={() => {
                  if (OFFBOARDING_ACTIONS_NEEDING_TARGET.has(action)) {
                    onNeedMembers();
                    setHanding(action);
                    return;
                  }
                  onAct(item, action);
                }}
                className={
                  ASKS_FIRST.has(action)
                    ? "px-3 py-1.5 text-sm font-medium rounded-lg border border-red-500/40 text-danger hover:bg-red-500/10 disabled:opacity-50"
                    : SECONDARY_BUTTON
                }
              >
                {labels.action(action)}
              </button>
            ))}
          {actionable && handing !== null && (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!target) return;
                onAct(item, handing, target);
                setHanding(null);
                setTarget("");
              }}
            >
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label={gt("Who takes it over")}
                className="bg-surface-overlay border border-border-strong rounded-lg px-2 py-1.5 text-sm"
              >
                <option value="">
                  {members === null ? gt("Loading…") : gt("Choose a member")}
                </option>
                {(members ?? []).map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name ? `${m.name} (${m.email})` : m.email}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={busy || !target} className={PRIMARY_BUTTON}>
                {labels.action(handing)}
              </button>
              <button type="button" onClick={() => setHanding(null)} className={SECONDARY_BUTTON}>
                {gt("Cancel")}
              </button>
            </form>
          )}
          {actionable && handing === null && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onUpdate(item, { status: "done" })}
                className="text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
              >
                {gt("Mark done")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onUpdate(item, { status: "skipped" })}
                className="text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
              >
                {gt("Skip")}
              </button>
            </>
          )}
          {!closed && (item.status === "done" || item.status === "skipped") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onUpdate(item, { status: "open" })}
              className="text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-50"
            >
              {gt("Reopen")}
            </button>
          )}
          {busy && <span className="text-on-surface-faint">{gt("Working…")}</span>}
        </div>
      </div>
    </li>
  );
}

/** One person's checklist. */
function OffboardingDetail({
  client,
  offboardingId,
  onBack,
  onOpenResource,
}: {
  client: OffboardingClient;
  offboardingId: string;
  onBack: () => void;
  onOpenResource?: ((item: OffboardingItem) => void) | undefined;
}) {
  const gt = useGT();
  const labels = useLabels();
  const [data, setData] = useState<Offboarding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [members, setMembers] = useState<OffboardingMember[] | null>(null);
  const [newAlias, setNewAlias] = useState("");
  const [showRejected, setShowRejected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    client
      .get(offboardingId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, offboardingId]);

  const needMembers = useCallback(() => {
    if (members !== null) return;
    client
      .members()
      .then((r) => setMembers(r.members))
      .catch((e: unknown) => setError(errorText(e)));
  }, [client, members]);

  async function run(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const replaceItem = (item: OffboardingItem) =>
    setData((d) => (d ? { ...d, items: d.items.map((i) => (i.id === item.id ? item : i)) } : d));

  async function reload() {
    setData(await client.get(offboardingId));
  }

  function act(item: OffboardingItem, action: OffboardingActionId, targetUserId?: string) {
    if (ASKS_FIRST.has(action)) {
      const ok = window.confirm(
        gt("{action}: {title}? This can't be undone from here.", {
          action: labels.action(action),
          title: item.title,
        }),
      );
      if (!ok) return;
    }
    void run(item.id, async () => {
      const result = await client.act(offboardingId, item.id, {
        action,
        ...(targetUserId ? { targetUserId } : {}),
      });
      replaceItem(result.item);
      if (result.message) setNotice(result.message);
      // Removing the membership revokes their keys too; the rest of the
      // checklist catches up from the server.
      if (action === "remove-member") await reload();
    });
  }

  function updateItem(item: OffboardingItem, patch: OffboardingItemUpdate) {
    void run(item.id, async () => {
      replaceItem(await client.updateItem(offboardingId, item.id, patch));
    });
  }

  if (error && !data) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <button type="button" onClick={onBack} className="text-xs text-on-surface-tertiary mb-4">
          {gt("All offboardings")}
        </button>
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading…")}
        </p>
      </div>
    );
  }

  const closed = data.status !== "open";
  const visible = data.items.filter((i) => i.matchState !== "rejected");
  const rejected = data.items.filter((i) => i.matchState === "rejected");
  const progress = {
    resolved: visible.filter(
      (i) => i.status === "done" || i.status === "skipped" || i.status === "gone",
    ).length,
    total: visible.length,
  };
  const unconfirmed = visible.filter(
    (i) => i.matchState === "unconfirmed" && i.status === "open",
  ).length;

  return (
    <div className="flex-1 overflow-auto p-6">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary mb-3"
      >
        {gt("All offboardings")}
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl font-semibold">{data.name ?? data.email}</h1>
          <p className="text-sm text-on-surface-tertiary">
            {data.name ? `${data.email} · ` : ""}
            {labels.offboardingStatus(data.status)}
            {data.source === "directory"
              ? ` · ${gt("Started by {directory}", { directory: data.sourceDetail ?? gt("the directory") })}`
              : data.startedByName
                ? ` · ${gt("Started by {name}", { name: data.startedByName })}`
                : ""}
            {` · ${formatDate(data.createdAt)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProgressBar resolved={progress.resolved} total={progress.total} />
          {!closed && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run("rescan", async () => setData(await client.rescan(offboardingId)))
              }
              className={SECONDARY_BUTTON}
            >
              {busy === "rescan" ? gt("Rescanning…") : gt("Rescan")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void run("export", async () => client.exportCsv(data))}
            className={SECONDARY_BUTTON}
          >
            {gt("Export CSV")}
          </button>
          {!closed ? (
            <>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run("status", async () =>
                    setData(await client.update(offboardingId, { status: "completed" })),
                  )
                }
                className={PRIMARY_BUTTON}
              >
                {gt("Complete")}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  if (!window.confirm(gt("Cancel this offboarding?"))) return;
                  void run("status", async () =>
                    setData(await client.update(offboardingId, { status: "canceled" })),
                  );
                }}
                className={SECONDARY_BUTTON}
              >
                {gt("Cancel offboarding")}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run("status", async () =>
                  setData(await client.update(offboardingId, { status: "open" })),
                )
              }
              className={SECONDARY_BUTTON}
            >
              {gt("Reopen")}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
        <span className="text-on-surface-faint">{gt("Aliases")}</span>
        {data.aliases.length === 0 && <span className="text-on-surface-faint">{gt("None")}</span>}
        {data.aliases.map((alias) => (
          <span
            key={alias}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-on-surface-secondary"
          >
            {alias}
            {!closed && (
              <button
                type="button"
                aria-label={gt("Remove alias {alias}", { alias })}
                disabled={busy !== null}
                onClick={() =>
                  void run("aliases", async () =>
                    setData(
                      await client.update(offboardingId, {
                        aliases: data.aliases.filter((a) => a !== alias),
                      }),
                    ),
                  )
                }
                className="text-on-surface-faint hover:text-on-surface-secondary"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            )}
          </span>
        ))}
        {!closed && (
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const added = normalizeAliases(
                [...data.aliases, ...newAlias.split(/[\s,]+/)],
                data.email,
              );
              if (added.length === data.aliases.length) return;
              void run("aliases", async () => {
                setData(await client.update(offboardingId, { aliases: added }));
                setNewAlias("");
              });
            }}
          >
            <input
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              placeholder={gt("Add an alias")}
              aria-label={gt("Add an alias")}
              className="bg-surface-overlay border border-border-strong rounded-md px-2 py-0.5 text-xs w-40"
            />
          </form>
        )}
      </div>

      {data.scanTruncated && (
        <p role="status" className="mb-3 text-xs text-amber-600">
          {gt(
            "The last scan matched more resources than it reads at once, so some may be missing. Add a more specific alias, or remove a broad one.",
          )}
        </p>
      )}
      {unconfirmed > 0 && !closed && (
        <p className="mb-3 text-xs text-on-surface-tertiary">
          {gt("Possible matches to confirm before anything can be done to them: {count}", {
            count: unconfirmed,
          })}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 text-xs text-on-surface-secondary">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-xs text-danger">
          {error}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-on-surface-faint">
          {gt("Nothing found for this person. Add the names providers know them by as aliases.")}
        </p>
      ) : (
        GROUP_ORDER.map((group) => {
          const items = visible.filter((i) => GROUP_OF[i.kind] === group);
          if (items.length === 0) return null;
          return (
            <section key={group} className="mb-5">
              <h2 className="text-sm font-semibold mb-2">
                {labels.group(group)}{" "}
                <span className="text-xs font-normal text-on-surface-faint">{items.length}</span>
              </h2>
              <ul className="border border-border rounded-xl overflow-hidden">
                {items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    closed={closed}
                    busy={busy === item.id}
                    members={members}
                    onAct={act}
                    onUpdate={updateItem}
                    onNeedMembers={needMembers}
                    onOpenResource={onOpenResource}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}

      {rejected.length > 0 && (
        <section className="mb-5">
          <button
            type="button"
            onClick={() => setShowRejected((v) => !v)}
            aria-expanded={showRejected}
            className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
          >
            {gt("Not them ({count})", { count: rejected.length })}
          </button>
          {showRejected && (
            <ul className="mt-2 border border-border rounded-xl overflow-hidden">
              {rejected.map((item) => (
                <li
                  key={item.id}
                  className="px-4 py-2 border-b border-border last:border-b-0 flex items-center justify-between gap-3 text-sm"
                >
                  <span className="text-on-surface-tertiary">
                    {item.title}
                    <span className="text-xs text-on-surface-faint">
                      {" · "}
                      {[item.providerName, item.accountName].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {!closed && (
                    <button
                      type="button"
                      disabled={busy === item.id}
                      onClick={() => updateItem(item, { matchState: "unconfirmed" })}
                      className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
                    >
                      {gt("Restore")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The offboarding tab: the list of people being offboarded with a start form,
 * or one person's checklist. Everything tied to them across the connected
 * providers and Infrawrench, each row with the action its provider allows.
 */
export function OffboardingPanel({
  client,
  offboardingId,
  onSelect,
  onOpenResource,
}: OffboardingPanelProps) {
  if (offboardingId) {
    return (
      <OffboardingDetail
        client={client}
        offboardingId={offboardingId}
        onBack={() => onSelect(undefined)}
        onOpenResource={onOpenResource}
      />
    );
  }
  return <OffboardingList client={client} onSelect={(id) => onSelect(id)} />;
}
