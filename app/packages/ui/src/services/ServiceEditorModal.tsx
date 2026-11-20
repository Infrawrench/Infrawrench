import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useGT } from "gt-react";
import {
  SERVICE_LIMITS,
  SERVICE_NAME_MATCHES,
  SERVICE_NAME_MATCH_LABELS,
  SERVICE_RULE_KINDS,
  SERVICE_RULE_KIND_LABELS,
  SERVICE_TIERS,
  SERVICE_TIER_DESCRIPTIONS,
  normalizeServiceRule,
  slugifyServiceName,
  validateServiceInput,
  type CostDimensionOption,
  type OnCallSchedule,
  type OwnerCandidate,
  type Runbook,
  type Service,
  type ServiceInput,
  type ServiceLink,
  type ServiceMember,
  type ServiceMembershipRule,
  type ServiceNameMatch,
  type ServiceRuleKind,
  type ServiceTier,
  type Slo,
  type VirtualTag,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { MultiSelect, type MultiSelectStatus } from "../components/MultiSelect.js";
import { CloseIcon, PlusIcon, SearchIcon } from "../components/icons/ChromeIcons.js";
import { TagKeySelect } from "../cost/TagKeyPicker.js";
import { useDataString } from "../i18n/data-strings.js";
import {
  ResourcePicker,
  ResourceRow,
  memberAsOption,
  type PickerRowState,
} from "./ResourcePicker.js";
import {
  errorMessage,
  fieldClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  smallButtonClass,
  useTierLabel,
} from "./shared.js";
import type { ServiceAccountOption, ServiceResourceOption, ServicesClient } from "./types.js";

/** Common ISO 4217 codes offered beside the free field; any three letters work. */
const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "INR", "SEK", "NZD"];

export interface ServiceEditorModalProps {
  client: ServicesClient;
  /** Existing service to edit, or null to create one. */
  existing: Service | null;
  onSaved: (service: Service | null) => void;
  onClose: () => void;
}

/** What the pickers offer; each list is null while loading and [] when its load failed. */
interface PickerData {
  owners: OwnerCandidate[] | null;
  schedules: OnCallSchedule[] | null;
  slos: Slo[] | null;
  runbooks: Runbook[] | null;
  tagKeys: CostDimensionOption[] | null;
  virtualTags: VirtualTag[] | null;
  accounts: ServiceAccountOption[] | null;
}

const EMPTY_PICKERS: PickerData = {
  owners: null,
  schedules: null,
  slos: null,
  runbooks: null,
  tagKeys: null,
  virtualTags: null,
  accounts: null,
};

/** The service's membership as the server last reported it. */
interface Membership {
  status: "loading" | "ready" | "error";
  error: string | null;
  members: Map<string, ServiceMember>;
  excluded: Map<string, ServiceMember>;
}

/** What Save will do to the membership, on top of {@link Membership}. */
interface PendingMembership {
  /** Resources to add by hand. */
  added: Map<string, ServiceResourceOption>;
  /** Current members to take out: removed if added by hand, excluded if a rule matched them. */
  dropped: Set<string>;
  /** Excluded resources to let back in. */
  restored: Set<string>;
}

const NO_PENDING: PendingMembership = { added: new Map(), dropped: new Set(), restored: new Set() };

type RightTab = "add" | "members" | "rules";

function membershipOf(members: ServiceMember[], excluded: ServiceMember[]): Membership {
  return {
    status: "ready",
    error: null,
    members: new Map(members.map((m) => [m.resourceId, m])),
    excluded: new Map(excluded.map((m) => [m.resourceId, m])),
  };
}

function emptyRule(kind: ServiceRuleKind = "tag"): ServiceMembershipRule {
  return normalizeServiceRule({ kind });
}

function sameRule(a: ServiceMembershipRule | undefined, b: ServiceMembershipRule): boolean {
  return (
    a !== undefined &&
    JSON.stringify(normalizeServiceRule(a)) === JSON.stringify(normalizeServiceRule(b))
  );
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every value a virtual tag can produce that the definition or its last run names. */
function virtualTagValues(tag: VirtualTag | undefined): string[] {
  if (!tag) return [];
  const values = new Set<string>();
  if (tag.defaultValue) values.add(tag.defaultValue);
  for (const rule of tag.rules) {
    if (rule.kind === "value" && rule.value) values.add(rule.value);
    for (const a of rule.allocations) if (a.value) values.add(a.value);
  }
  for (const c of tag.status.stats?.currencies ?? []) {
    for (const v of c.topValues) values.add(v.value);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

function statusFor(
  list: readonly unknown[] | null,
  emptyMessage: string,
): MultiSelectStatus | undefined {
  if (list === null) return { kind: "loading" };
  if (list.length === 0) return { kind: "empty", message: emptyMessage };
  return undefined;
}

/** Keep ids the lists no longer return selectable, so editing never silently drops a link. */
function withMissing(
  options: Array<{ value: string; label: string }>,
  selected: readonly string[],
  missingLabel: string,
): Array<{ value: string; label: string }> {
  const known = new Set(options.map((o) => o.value));
  return [
    ...options,
    ...selected.filter((id) => !known.has(id)).map((id) => ({ value: id, label: missingLabel })),
  ];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3
        id={id}
        className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-faint"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function RuleEditor({
  rule,
  index,
  pickers,
  matchCount,
  onChange,
  onRemove,
}: {
  rule: ServiceMembershipRule;
  index: number;
  pickers: PickerData;
  /** How many resources the saved rule matches now; null when unknown or edited. */
  matchCount: number | null;
  onChange: (rule: ServiceMembershipRule) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const dataString = useDataString();
  const groupId = useId();
  const valueListId = useId();
  const n = index + 1;
  const set = (patch: Partial<ServiceMembershipRule>) => onChange({ ...rule, ...patch });

  const plugins = useMemo(
    () => [...new Set((pickers.accounts ?? []).map((a) => a.pluginId))].sort(),
    [pickers.accounts],
  );
  const accounts = (pickers.accounts ?? []).filter(
    (a) => !rule.pluginId || a.pluginId === rule.pluginId,
  );
  const vtag = (pickers.virtualTags ?? []).find((t) => t.key === rule.key);
  const vtagValues = virtualTagValues(vtag);

  return (
    <div
      role="group"
      aria-labelledby={groupId}
      className="space-y-2 rounded-xl border border-border bg-surface-raised p-3"
    >
      <div className="flex items-center gap-2">
        <span
          id={groupId}
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-xs font-semibold text-on-surface-secondary tabular-nums"
        >
          <span className="sr-only">{gt("Rule {n}", { n })}</span>
          <span aria-hidden="true">{n}</span>
        </span>
        <select
          aria-label={gt("Rule {n} kind", { n })}
          className={`${fieldClass} w-auto`}
          value={rule.kind}
          onChange={(e) => onChange(emptyRule(e.target.value as ServiceRuleKind))}
        >
          {SERVICE_RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {dataString(SERVICE_RULE_KIND_LABELS[k])}
            </option>
          ))}
        </select>
        {matchCount !== null && (
          <span className="text-xs text-on-surface-faint">
            {gt("Matches {count} resources", { count: matchCount })}
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto rounded-md p-1 text-on-surface-faint hover:bg-surface-sunken hover:text-danger"
          aria-label={gt("Remove rule {n}", { n })}
          title={gt("Remove")}
        >
          <CloseIcon size={14} />
        </button>
      </div>

      {rule.kind === "tag" && (
        <div className="grid grid-cols-2 gap-2">
          {pickers.tagKeys && pickers.tagKeys.length > 0 ? (
            <TagKeySelect
              aria-label={gt("Rule {n} tag key", { n })}
              className={inputClass}
              options={pickers.tagKeys}
              value={rule.key ?? ""}
              onChange={(key) => set({ key: key || null })}
              emptyLabel={gt("Choose a tag key…")}
            />
          ) : (
            <input
              type="text"
              aria-label={gt("Rule {n} tag key", { n })}
              className={inputClass}
              placeholder={pickers.tagKeys === null ? gt("Loading tag keys…") : gt("Tag key")}
              maxLength={SERVICE_LIMITS.ruleValueMaxLength}
              value={rule.key ?? ""}
              onChange={(e) => set({ key: e.target.value || null })}
            />
          )}
          <input
            type="text"
            aria-label={gt("Rule {n} tag value", { n })}
            className={inputClass}
            placeholder={gt("Any value")}
            maxLength={SERVICE_LIMITS.ruleValueMaxLength}
            value={rule.value ?? ""}
            onChange={(e) => set({ value: e.target.value || null })}
          />
        </div>
      )}

      {rule.kind === "virtual_tag" && (
        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label={gt("Rule {n} virtual tag", { n })}
            className={inputClass}
            value={rule.key ?? ""}
            onChange={(e) => set({ key: e.target.value || null, value: null })}
          >
            <option value="" disabled>
              {pickers.virtualTags === null
                ? gt("Loading virtual tags…")
                : pickers.virtualTags.length > 0
                  ? gt("Choose a virtual tag…")
                  : gt("No virtual tags yet: create one in Settings")}
            </option>
            {rule.key && !vtag && <option value={rule.key}>{rule.key}</option>}
            {(pickers.virtualTags ?? []).map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label={gt("Rule {n} virtual tag value", { n })}
            className={inputClass}
            placeholder={gt("Value")}
            list={valueListId}
            disabled={!rule.key}
            maxLength={SERVICE_LIMITS.ruleValueMaxLength}
            value={rule.value ?? ""}
            onChange={(e) => set({ value: e.target.value || null })}
          />
          <datalist id={valueListId}>
            {vtagValues.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
      )}

      {rule.kind === "name" && (
        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label={gt("Rule {n} name match", { n })}
            className={inputClass}
            value={rule.nameMatch ?? "contains"}
            onChange={(e) => set({ nameMatch: e.target.value as ServiceNameMatch })}
          >
            {SERVICE_NAME_MATCHES.map((m) => (
              <option key={m} value={m}>
                {dataString(SERVICE_NAME_MATCH_LABELS[m])}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label={gt("Rule {n} name pattern", { n })}
            className={inputClass}
            placeholder={gt("checkout")}
            maxLength={SERVICE_LIMITS.ruleValueMaxLength}
            value={rule.value ?? ""}
            onChange={(e) => set({ value: e.target.value || null })}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={gt("Rule {n} provider", { n })}
          className={inputClass}
          value={rule.pluginId ?? ""}
          onChange={(e) => set({ pluginId: e.target.value || null, accountId: null })}
        >
          <option value="">{gt("Any provider")}</option>
          {rule.pluginId && !plugins.includes(rule.pluginId) && (
            <option value={rule.pluginId}>{rule.pluginId}</option>
          )}
          {plugins.map((p) => (
            <option key={p} value={p}>
              {dataString(p)}
            </option>
          ))}
        </select>
        <select
          aria-label={gt("Rule {n} account", { n })}
          className={inputClass}
          value={rule.accountId ?? ""}
          onChange={(e) => {
            const account = accounts.find((a) => a.id === e.target.value);
            set({
              accountId: e.target.value || null,
              ...(account ? { pluginId: account.pluginId } : {}),
            });
          }}
        >
          <option value="">{gt("Any account")}</option>
          {rule.accountId && !accounts.some((a) => a.id === rule.accountId) && (
            <option value={rule.accountId}>{gt("Unknown account")}</option>
          )}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * The service editor: details on the left, what is in the service on the
 * right. Resources are ticked straight from a search of every account, the
 * current members can be unticked in place, and rules sit beside both, so a
 * service is built in one dialog and one Save. Everything else is a picker:
 * owners from the org's members, the on-call schedule, SLOs and runbooks from
 * their own lists, tag keys from the org's data, virtual tags from their
 * definitions, and the provider and account narrowing from the connected
 * accounts.
 */
export function ServiceEditorModal({
  client,
  existing,
  onSaved,
  onClose,
}: ServiceEditorModalProps) {
  const gt = useGT();
  const dataString = useDataString();
  const tierLabel = useTierLabel();
  const ids = {
    title: useId(),
    name: useId(),
    slug: useId(),
    description: useId(),
    tier: useId(),
    team: useId(),
    onCall: useId(),
    budget: useId(),
    currency: useId(),
    currencies: useId(),
    links: useId(),
    memberFilter: useId(),
    tabs: useId(),
  };

  const canPick = Boolean(client.addMembers);
  const [name, setName] = useState(existing?.name ?? "");
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [tier, setTier] = useState<ServiceTier | null>(existing?.tier ?? null);
  const [ownerTeam, setOwnerTeam] = useState(existing?.ownerTeam ?? "");
  const [ownerUserIds, setOwnerUserIds] = useState<string[]>(existing?.ownerUserIds ?? []);
  const [links, setLinks] = useState<ServiceLink[]>(existing?.links ?? []);
  const [onCallScheduleId, setOnCallScheduleId] = useState(existing?.onCallScheduleId ?? "");
  const [sloIds, setSloIds] = useState<string[]>(existing?.sloIds ?? []);
  const [runbookIds, setRunbookIds] = useState<string[]>(existing?.runbookIds ?? []);
  const [rules, setRules] = useState<ServiceMembershipRule[]>(existing?.rules ?? []);
  const [budget, setBudget] = useState(
    existing?.monthlyBudget === null || existing?.monthlyBudget === undefined
      ? ""
      : String(existing.monthlyBudget),
  );
  const [currency, setCurrency] = useState(existing?.budgetCurrency ?? "USD");
  const [pickers, setPickers] = useState<PickerData>(EMPTY_PICKERS);
  const [tab, setTab] = useState<RightTab>(canPick ? "add" : "rules");
  const [membership, setMembership] = useState<Membership>(() =>
    existing
      ? { status: "loading", error: null, members: new Map(), excluded: new Map() }
      : membershipOf([], []),
  );
  const [pending, setPending] = useState<PendingMembership>(NO_PENDING);
  // Provider names, logos and type labels the search has shown, to dress member rows with.
  const [known, setKnown] = useState<ReadonlyMap<string, Partial<ServiceResourceOption>>>(
    new Map(),
  );
  const [memberFilter, setMemberFilter] = useState("");
  // A service this dialog created whose members did not all save: Save again updates it.
  const [created, setCreated] = useState<Service | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = existing ?? created;

  useEffect(() => {
    let cancelled = false;
    const load = <K extends keyof PickerData>(key: K, p: Promise<NonNullable<PickerData[K]>>) => {
      p.then(
        (value) => {
          if (!cancelled) setPickers((prev) => ({ ...prev, [key]: value }));
        },
        () => {
          if (!cancelled) setPickers((prev) => ({ ...prev, [key]: [] }));
        },
      );
    };
    load("owners", client.listOwnerCandidates());
    load("schedules", client.listOnCallSchedules());
    load("slos", client.listSlos());
    load("runbooks", client.listRunbooks());
    load(
      "tagKeys",
      client
        .listTagKeys()
        .then((res) =>
          res.keys
            .filter((k) => !k.hidden)
            .map((k) => ({ value: k.key, label: k.key, preferred: k.preferred })),
        ),
    );
    load("virtualTags", client.listVirtualTags());
    load("accounts", client.listAccounts());
    return () => {
      cancelled = true;
    };
  }, [client]);

  const existingId = existing?.id;
  useEffect(() => {
    if (!existingId) return;
    let cancelled = false;
    client.getService(existingId).then(
      (detail) => {
        if (!cancelled) setMembership(membershipOf(detail.members, detail.excluded));
      },
      (e) => {
        if (!cancelled)
          setMembership({
            status: "error",
            error: errorMessage(e, gt("The members could not be loaded")),
            members: new Map(),
            excluded: new Map(),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, existingId, gt]);

  const learn = (rows: ServiceResourceOption[]) => {
    const fresh = rows.filter(
      (r) => !known.has(r.pluginId) || !known.has(`${r.pluginId}:${r.resourceTypeId}`),
    );
    if (fresh.length === 0) return;
    setKnown((prev) => {
      const next = new Map(prev);
      for (const r of fresh) {
        next.set(r.pluginId, {
          pluginDisplayName: r.pluginDisplayName,
          pluginLogoSvg: r.pluginLogoSvg || undefined,
        });
        if (r.resourceTypeLabel) {
          next.set(`${r.pluginId}:${r.resourceTypeId}`, { resourceTypeLabel: r.resourceTypeLabel });
        }
      }
      return next;
    });
  };

  const stateOf = (row: ServiceResourceOption): PickerRowState => {
    if (membership.status === "loading") {
      return { checked: false, lockedReason: gt("Loading members…") };
    }
    const member = membership.members.get(row.id);
    if (member) {
      if (pending.dropped.has(row.id)) {
        return {
          checked: false,
          badge: {
            text: member.source === "rule" ? gt("Will be excluded") : gt("Will be removed"),
            tone: "danger",
          },
        };
      }
      return member.source === "rule"
        ? {
            checked: true,
            badge: { text: gt("Rule {n}", { n: (member.ruleIndex ?? 0) + 1 }), tone: "neutral" },
          }
        : { checked: true };
    }
    if (membership.excluded.has(row.id)) {
      return pending.restored.has(row.id)
        ? { checked: true, badge: { text: gt("Will be restored"), tone: "accent" } }
        : { checked: false, badge: { text: gt("Excluded"), tone: "neutral" } };
    }
    return pending.added.has(row.id)
      ? { checked: true, badge: { text: gt("New"), tone: "accent" } }
      : { checked: false };
  };

  const toggle = (row: ServiceResourceOption) => {
    if (membership.status === "loading") return;
    setPending((prev) => {
      if (membership.members.has(row.id)) {
        const dropped = new Set(prev.dropped);
        if (!dropped.delete(row.id)) dropped.add(row.id);
        return { ...prev, dropped };
      }
      if (membership.excluded.has(row.id)) {
        const restored = new Set(prev.restored);
        if (!restored.delete(row.id)) restored.add(row.id);
        return { ...prev, restored };
      }
      const added = new Map(prev.added);
      if (!added.delete(row.id)) added.set(row.id, row);
      return { ...prev, added };
    });
  };

  const selectMany = (rows: ServiceResourceOption[]) => {
    setPending((prev) => {
      const added = new Map(prev.added);
      const restored = new Set(prev.restored);
      const dropped = new Set(prev.dropped);
      for (const row of rows) {
        if (membership.members.has(row.id)) dropped.delete(row.id);
        else if (membership.excluded.has(row.id)) restored.add(row.id);
        else added.set(row.id, row);
      }
      return { added, dropped, restored };
    });
  };

  const memberCount =
    membership.members.size - pending.dropped.size + pending.added.size + pending.restored.size;
  const toAdd = pending.added.size + pending.restored.size;
  const toRemove = pending.dropped.size;

  // The "In this service" list: changes first, then members, then the excluded.
  const memberRows = useMemo(() => {
    const byName = (a: ServiceResourceOption, b: ServiceResourceOption) =>
      a.displayName.localeCompare(b.displayName);
    const fromMembers = (map: Map<string, ServiceMember>) =>
      [...map.values()]
        .map((m): ServiceResourceOption => ({
          ...known.get(m.pluginId),
          ...known.get(`${m.pluginId}:${m.resourceTypeId}`),
          ...memberAsOption(m),
        }))
        .sort(byName);
    const excluded = fromMembers(membership.excluded);
    return [
      ...[...pending.added.values()].sort(byName),
      ...excluded.filter((r) => pending.restored.has(r.id)),
      ...fromMembers(membership.members),
      ...excluded.filter((r) => !pending.restored.has(r.id)),
    ];
  }, [membership, pending.added, pending.restored, known]);
  const filterText = memberFilter.trim().toLowerCase();
  const shownMemberRows = filterText
    ? memberRows.filter((r) =>
        `${r.displayName} ${r.accountName ?? ""} ${r.pluginDisplayName ?? dataString(r.pluginId)} ${r.resourceTypeLabel ?? ""}`
          .toLowerCase()
          .includes(filterText),
      )
    : memberRows;

  const slugTrimmed = slug.trim();
  const budgetTrimmed = budget.trim();
  const budgetNumber = budgetTrimmed === "" ? null : Number(budgetTrimmed);
  const input: ServiceInput = {
    name: name.trim(),
    ...(slugTrimmed && slugTrimmed !== target?.slug ? { slug: slugTrimmed } : {}),
    description: description.trim() ? description.trim() : null,
    tier,
    ownerTeam: ownerTeam.trim() ? ownerTeam.trim() : null,
    ownerUserIds,
    links: links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
    onCallScheduleId: onCallScheduleId || null,
    sloIds,
    runbookIds,
    rules: rules.map(normalizeServiceRule),
    monthlyBudget: budgetNumber === null ? null : budgetNumber,
    budgetCurrency: budgetNumber === null ? null : currency.trim().toUpperCase() || null,
  };

  /**
   * Apply the pending membership to a saved service. What fails stays
   * pending, and the membership is re-read so the lists show what the
   * server now has; the returned message names the first failure.
   */
  const applyMembership = async (serviceId: string): Promise<string | null> => {
    const failed: PendingMembership = { added: new Map(), dropped: new Set(), restored: new Set() };
    let firstError: string | null = null;
    const note = (e: unknown, fallback: string) => {
      firstError ??= errorMessage(e, fallback);
    };
    if (client.addMembers) {
      for (const batch of chunks(
        [...pending.added.values()],
        SERVICE_LIMITS.maxMembersPerRequest,
      )) {
        try {
          await client.addMembers(
            serviceId,
            batch.map((r) => r.id),
          );
        } catch (e) {
          for (const r of batch) failed.added.set(r.id, r);
          note(e, gt("Failed to add the resources"));
        }
      }
    }
    for (const id of pending.dropped) {
      try {
        await client.removeMember?.(serviceId, id);
      } catch (e) {
        failed.dropped.add(id);
        note(e, gt("Failed to remove the resource"));
      }
    }
    for (const id of pending.restored) {
      try {
        await client.restoreMember?.(serviceId, id);
      } catch (e) {
        failed.restored.add(id);
        note(e, gt("Failed to restore the resource"));
      }
    }
    if (firstError !== null) {
      setPending(failed);
      try {
        const detail = await client.getService(serviceId);
        setMembership(membershipOf(detail.members, detail.excluded));
      } catch {
        // The lists keep what they showed; the error below already says something failed.
      }
    }
    return firstError;
  };

  const save = async () => {
    const problem = validateServiceInput(input);
    if (problem) {
      setError(problem);
      return;
    }
    if (target ? !client.updateService : !client.createService) {
      setError(gt("Editing services isn't available here."));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = target
        ? await client.updateService!(target.id, input)
        : await client.createService!(input);
      if (!target && saved) setCreated(saved);
      const serviceId = saved?.id ?? target?.id;
      const membershipError =
        serviceId && (toAdd > 0 || toRemove > 0) ? await applyMembership(serviceId) : null;
      onSaved(saved);
      if (membershipError === null) {
        onClose();
        return;
      }
      setError(
        gt("The service was saved, but some resources were not updated: {error}", {
          error: membershipError,
        }),
      );
    } catch (e) {
      setError(errorMessage(e, gt("Failed to save the service")));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    if (!saving) onClose();
  };

  const missing = gt("Deleted or not visible");
  const ownerOptions = withMissing(
    (pickers.owners ?? []).map((o) => ({
      value: o.userId,
      label: o.name && o.name !== o.email ? `${o.name} (${o.email})` : o.email,
    })),
    ownerUserIds,
    missing,
  );
  const sloOptions = withMissing(
    (pickers.slos ?? []).map((s) => ({ value: s.id, label: s.name })),
    sloIds,
    missing,
  );
  const runbookOptions = withMissing(
    (pickers.runbooks ?? []).map((r) => ({ value: r.id, label: r.name })),
    runbookIds,
    missing,
  );

  const ruleMatches = (i: number): number | null => {
    if (membership.status !== "ready" || !sameRule(existing?.rules[i], rules[i]!)) return null;
    let count = 0;
    for (const m of membership.members.values()) {
      if (m.source === "rule" && m.ruleIndex === i) count += 1;
    }
    return count;
  };

  const tabs: Array<{ key: RightTab; label: string; count: number | null }> = [
    ...(canPick
      ? [
          { key: "add" as const, label: gt("Add resources"), count: null },
          {
            key: "members" as const,
            label: gt("In this service"),
            count: membership.status === "loading" ? null : memberCount,
          },
        ]
      : []),
    { key: "rules", label: gt("Membership rules"), count: rules.length || null },
  ];
  const tabId = (key: RightTab) => `${ids.tabs}-${key}`;

  const pendingSummary = [
    toAdd > 0 ? gt("{count} to add", { count: toAdd }) : null,
    toRemove > 0 ? gt("{count} to remove", { count: toRemove }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const title = target ? gt("Edit service") : gt("New service");

  return (
    <Modal onClose={dismiss} ariaLabel={title}>
      <div className="flex h-[min(50rem,92vh)] w-[74rem] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
        <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 id={ids.title} className="text-sm font-semibold text-on-surface">
              {title}
            </h2>
            {name.trim() && (
              <p className="truncate text-xs text-on-surface-faint">
                {name.trim()}
                <span className="font-mono">
                  {" · "}
                  {slugTrimmed || slugifyServiceName(name)}
                </span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={saving}
            className="rounded-lg p-1.5 text-on-surface-faint hover:bg-surface-sunken hover:text-on-surface"
            aria-label={gt("Close")}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] md:overflow-hidden">
          {/* Details */}
          <div className="space-y-6 border-border p-5 md:overflow-y-auto md:border-r">
            <Section title={gt("Details")}>
              <div>
                <label className={labelClass} htmlFor={ids.name}>
                  {gt("Name")}
                </label>
                <input
                  id={ids.name}
                  type="text"
                  maxLength={SERVICE_LIMITS.nameMaxLength}
                  className={inputClass}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={gt("Checkout API")}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={ids.slug}>
                  {gt("Slug (optional)")}
                </label>
                <input
                  id={ids.slug}
                  type="text"
                  maxLength={SERVICE_LIMITS.slugMaxLength}
                  className={`${inputClass} font-mono`}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  placeholder={slugifyServiceName(name) || gt("Derived from the name")}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={ids.description}>
                  {gt("Description (optional)")}
                </label>
                <textarea
                  id={ids.description}
                  rows={2}
                  maxLength={SERVICE_LIMITS.descriptionMaxLength}
                  className={`${inputClass} resize-y`}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div>
                <span id={ids.tier} className={labelClass}>
                  {gt("Tier")}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby={ids.tier}
                  className="flex gap-1 rounded-lg border border-border bg-surface-sunken p-1"
                >
                  {[null, ...SERVICE_TIERS].map((t) => {
                    const active = tier === t;
                    return (
                      <button
                        key={t ?? "none"}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setTier(t)}
                        className={`flex-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs transition-colors ${
                          active
                            ? "bg-surface-raised font-medium text-on-surface shadow-sm"
                            : "text-on-surface-secondary hover:text-on-surface"
                        }`}
                      >
                        {tierLabel(t)}
                      </button>
                    );
                  })}
                </div>
                {tier !== null && (
                  <p className="mt-1.5 text-xs text-on-surface-faint">
                    {dataString(SERVICE_TIER_DESCRIPTIONS[tier])}
                  </p>
                )}
              </div>
            </Section>

            <Section title={gt("Ownership")}>
              <div>
                <label className={labelClass} htmlFor={ids.team}>
                  {gt("Owning team (optional)")}
                </label>
                <input
                  id={ids.team}
                  type="text"
                  maxLength={SERVICE_LIMITS.ownerTeamMaxLength}
                  className={inputClass}
                  value={ownerTeam}
                  onChange={(e) => setOwnerTeam(e.target.value)}
                  placeholder={gt("Payments")}
                />
              </div>
              <div>
                <span className={labelClass}>{gt("Owners")}</span>
                <MultiSelect
                  label={gt("Owners")}
                  placeholder={gt("Choose members…")}
                  options={ownerOptions}
                  value={ownerUserIds}
                  onChange={setOwnerUserIds}
                  status={statusFor(pickers.owners, gt("No members to choose from"))}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={ids.onCall}>
                  {gt("On-call schedule")}
                </label>
                <select
                  id={ids.onCall}
                  className={inputClass}
                  value={onCallScheduleId}
                  onChange={(e) => setOnCallScheduleId(e.target.value)}
                >
                  <option value="">
                    {pickers.schedules === null ? gt("Loading schedules…") : gt("None")}
                  </option>
                  {onCallScheduleId &&
                    !(pickers.schedules ?? []).some((s) => s.id === onCallScheduleId) && (
                      <option value={onCallScheduleId}>
                        {existing?.onCallScheduleName ?? missing}
                      </option>
                    )}
                  {(pickers.schedules ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.enabled ? s.name : gt("{name} (disabled)", { name: s.name })}
                    </option>
                  ))}
                </select>
              </div>
            </Section>

            <Section title={gt("Reliability")}>
              <div>
                <span className={labelClass}>{gt("SLOs")}</span>
                <MultiSelect
                  label={gt("SLOs")}
                  placeholder={gt("Link SLOs…")}
                  options={sloOptions}
                  value={sloIds}
                  onChange={setSloIds}
                  status={statusFor(pickers.slos, gt("No SLOs yet"))}
                />
              </div>
              <div>
                <span className={labelClass}>{gt("Runbooks")}</span>
                <MultiSelect
                  label={gt("Runbooks")}
                  placeholder={gt("Link runbooks…")}
                  options={runbookOptions}
                  value={runbookIds}
                  onChange={setRunbookIds}
                  status={statusFor(pickers.runbooks, gt("No runbooks yet"))}
                />
              </div>
              <div role="group" aria-labelledby={ids.links}>
                <span id={ids.links} className={labelClass}>
                  {gt("Links")}
                </span>
                <div className="space-y-1.5">
                  {links.map((link, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        type="text"
                        aria-label={gt("Link {n} label", { n: i + 1 })}
                        className={`${fieldClass} w-28 shrink-0`}
                        maxLength={SERVICE_LIMITS.linkLabelMaxLength}
                        placeholder={gt("Label")}
                        value={link.label}
                        onChange={(e) =>
                          setLinks(
                            links.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)),
                          )
                        }
                      />
                      <input
                        type="url"
                        aria-label={gt("Link {n} URL", { n: i + 1 })}
                        className={`${fieldClass} min-w-0 flex-1`}
                        maxLength={SERVICE_LIMITS.linkUrlMaxLength}
                        placeholder="https://"
                        value={link.url}
                        onChange={(e) =>
                          setLinks(
                            links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="shrink-0 rounded-md p-1 text-on-surface-faint hover:bg-surface-sunken hover:text-danger"
                        aria-label={gt("Remove link {n}", { n: i + 1 })}
                        title={gt("Remove")}
                        onClick={() => setLinks(links.filter((_, j) => j !== i))}
                      >
                        <CloseIcon size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={`${smallButtonClass} inline-flex items-center gap-1`}
                    disabled={links.length >= SERVICE_LIMITS.maxLinks}
                    onClick={() => setLinks([...links, { label: "", url: "" }])}
                  >
                    <PlusIcon size={12} />
                    {gt("Add link")}
                  </button>
                </div>
              </div>
            </Section>

            <Section title={gt("Budget")}>
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
                <div>
                  <label className={labelClass} htmlFor={ids.currency}>
                    {gt("Currency")}
                  </label>
                  <input
                    id={ids.currency}
                    type="text"
                    maxLength={3}
                    className={`${inputClass} font-mono uppercase`}
                    list={ids.currencies}
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  />
                  <datalist id={ids.currencies}>
                    {COMMON_CURRENCIES.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className={labelClass} htmlFor={ids.budget}>
                    {gt("Monthly budget (optional)")}
                  </label>
                  <input
                    id={ids.budget}
                    type="number"
                    min={0}
                    step="any"
                    className={`${inputClass} tabular-nums`}
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-on-surface-faint">
                {gt(
                  "The cost scorecard check compares the last 30 days of member spend with this.",
                )}
              </p>
            </Section>
          </div>

          {/* Resources */}
          <div className="flex min-h-[32rem] flex-col p-5 md:min-h-0">
            <div
              role="tablist"
              aria-label={gt("Resources")}
              className="-mx-1 mb-3 flex gap-1 border-b border-border"
            >
              {tabs.map((t) => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    id={tabId(t.key)}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`${tabId(t.key)}-panel`}
                    onClick={() => setTab(t.key)}
                    className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 pb-2 pt-1 text-sm transition-colors ${
                      active
                        ? "border-accent font-medium text-on-surface"
                        : "border-transparent text-on-surface-secondary hover:text-on-surface"
                    }`}
                  >
                    {t.label}
                    {t.count !== null && (
                      <span
                        className={`rounded-full px-1.5 text-[11px] tabular-nums ${
                          active
                            ? "bg-accent/15 text-accent"
                            : "bg-surface-sunken text-on-surface-faint"
                        }`}
                      >
                        {t.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div
              id={`${tabId(tab)}-panel`}
              role="tabpanel"
              aria-labelledby={tabId(tab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              {tab === "add" && (
                <ResourcePicker
                  client={client}
                  stateOf={stateOf}
                  onToggle={toggle}
                  onSelectMany={selectMany}
                  onResults={learn}
                />
              )}

              {tab === "members" && (
                <div className="flex min-h-0 flex-1 flex-col gap-2">
                  {memberRows.length > 8 && (
                    <div className="relative">
                      <label htmlFor={ids.memberFilter} className="sr-only">
                        {gt("Filter members")}
                      </label>
                      <SearchIcon
                        size={14}
                        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-faint"
                      />
                      <input
                        id={ids.memberFilter}
                        type="search"
                        className="w-full rounded-lg border border-border bg-surface-sunken py-2 pl-8 pr-2.5 text-sm text-on-surface focus:border-accent-subtle focus:outline-none"
                        value={memberFilter}
                        onChange={(e) => setMemberFilter(e.target.value)}
                        placeholder={gt("Filter members")}
                      />
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface-raised">
                    {membership.status === "loading" ? (
                      <p role="status" className="p-4 text-sm text-on-surface-faint">
                        {gt("Loading members…")}
                      </p>
                    ) : membership.status === "error" ? (
                      <p role="alert" className="p-4 text-sm text-danger">
                        {membership.error}
                      </p>
                    ) : shownMemberRows.length === 0 ? (
                      <div className="flex flex-col items-center gap-3 p-8 text-center">
                        <p className="text-sm text-on-surface-faint">
                          {memberRows.length === 0
                            ? gt("No members yet. Add resources by hand or with a membership rule.")
                            : gt("No resources match.")}
                        </p>
                        {memberRows.length === 0 && (
                          <button
                            type="button"
                            className={secondaryButtonClass}
                            onClick={() => setTab("add")}
                          >
                            {gt("Add resources")}
                          </button>
                        )}
                      </div>
                    ) : (
                      <ul className="divide-y divide-border">
                        {shownMemberRows.map((row) => (
                          <ResourceRow
                            key={row.id}
                            row={row}
                            state={stateOf(row)}
                            onToggle={toggle}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              {tab === "rules" && (
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
                  <p className="text-xs text-on-surface-faint">
                    {gt(
                      "Resources a rule matches join the service on their own, alongside the ones you add by hand. A virtual tag rule only matches resources with per-resource cost rows.",
                    )}
                  </p>
                  {rules.map((rule, i) => (
                    <RuleEditor
                      key={i}
                      rule={rule}
                      index={i}
                      pickers={pickers}
                      matchCount={ruleMatches(i)}
                      onChange={(next) => setRules(rules.map((r, j) => (j === i ? next : r)))}
                      onRemove={() => setRules(rules.filter((_, j) => j !== i))}
                    />
                  ))}
                  <button
                    type="button"
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-3 text-sm text-on-surface-secondary hover:border-border-strong hover:text-on-surface disabled:opacity-50"
                    disabled={rules.length >= SERVICE_LIMITS.maxRules}
                    onClick={() => setRules([...rules, emptyRule()])}
                  >
                    <PlusIcon size={14} />
                    {gt("Add rule")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <footer className="flex items-center gap-3 border-t border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            {error !== null ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : pendingSummary ? (
              <p className="text-xs text-on-surface-secondary">{pendingSummary}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={saving}
            className={secondaryButtonClass}
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className={primaryButtonClass}
          >
            {saving ? gt("Saving…") : target ? gt("Save") : gt("Create service")}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
