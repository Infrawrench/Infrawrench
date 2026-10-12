import { useEffect, useId, useMemo, useState } from "react";
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
  type ServiceMembershipRule,
  type ServiceNameMatch,
  type ServiceRuleKind,
  type ServiceTier,
  type Slo,
  type VirtualTag,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { MultiSelect, type MultiSelectStatus } from "../components/MultiSelect.js";
import { TagKeySelect } from "../cost/TagKeyPicker.js";
import { useDataString } from "../i18n/data-strings.js";
import {
  errorMessage,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  smallButtonClass,
  useTierLabel,
} from "./shared.js";
import type { ServiceAccountOption, ServicesClient } from "./types.js";

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

function emptyRule(kind: ServiceRuleKind = "tag"): ServiceMembershipRule {
  return normalizeServiceRule({ kind });
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

function RuleEditor({
  rule,
  index,
  pickers,
  onChange,
  onRemove,
}: {
  rule: ServiceMembershipRule;
  index: number;
  pickers: PickerData;
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
      className="rounded-lg border border-border bg-surface-raised p-2.5 space-y-2"
    >
      <div className="flex items-center gap-2">
        <span id={groupId} className="text-xs font-medium text-on-surface-secondary">
          {gt("Rule {n}", { n })}
        </span>
        <select
          aria-label={gt("Rule {n} kind", { n })}
          className={`${inputClass} w-auto`}
          value={rule.kind}
          onChange={(e) => onChange(emptyRule(e.target.value as ServiceRuleKind))}
        >
          {SERVICE_RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {dataString(SERVICE_RULE_KIND_LABELS[k])}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          className={`${smallButtonClass} ml-auto text-danger`}
          aria-label={gt("Remove rule {n}", { n })}
        >
          {gt("Remove")}
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
 * The service editor. Everything is a picker: owners from the org's members,
 * the on-call schedule, SLOs and runbooks from their own lists, tag keys from
 * what the org's data carries, virtual tags from their definitions, and the
 * provider and account narrowing from the connected accounts.
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
    rules: useId(),
  };

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const slugTrimmed = slug.trim();
  const budgetTrimmed = budget.trim();
  const budgetNumber = budgetTrimmed === "" ? null : Number(budgetTrimmed);
  const input: ServiceInput = {
    name: name.trim(),
    ...(slugTrimmed && slugTrimmed !== existing?.slug ? { slug: slugTrimmed } : {}),
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

  const save = async () => {
    const problem = validateServiceInput(input);
    if (problem) {
      setError(problem);
      return;
    }
    if (existing ? !client.updateService : !client.createService) {
      setError(gt("Editing services isn't available here."));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await client.updateService!(existing.id, input)
        : await client.createService!(input);
      onSaved(saved);
      onClose();
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

  return (
    <Modal onClose={dismiss} ariaLabel={existing ? gt("Edit service") : gt("New service")}>
      <div className="w-[40rem] max-w-[94vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {existing ? gt("Edit service") : gt("New service")}
        </h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          {gt(
            "A service groups resources across providers and accounts, says who owns it and links its SLOs, runbooks and on-call schedule.",
          )}
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
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
                className={inputClass}
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder={slugifyServiceName(name) || gt("Derived from the name")}
              />
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor={ids.description}>
              {gt("Description (optional)")}
            </label>
            <textarea
              id={ids.description}
              rows={2}
              maxLength={SERVICE_LIMITS.descriptionMaxLength}
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor={ids.tier}>
                {gt("Tier")}
              </label>
              <select
                id={ids.tier}
                className={inputClass}
                value={tier === null ? "" : String(tier)}
                onChange={(e) =>
                  setTier(e.target.value ? (Number(e.target.value) as ServiceTier) : null)
                }
              >
                <option value="">{gt("Untiered")}</option>
                {SERVICE_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {tierLabel(t)}
                  </option>
                ))}
              </select>
              {tier !== null && (
                <p className="mt-1 text-xs text-on-surface-faint">
                  {dataString(SERVICE_TIER_DESCRIPTIONS[tier])}
                </p>
              )}
            </div>
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

          <div className="grid grid-cols-2 gap-3">
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
          </div>

          <div role="group" aria-labelledby={ids.links}>
            <div className="flex items-center justify-between mb-1">
              <span id={ids.links} className="text-xs font-medium text-on-surface-secondary">
                {gt("Links")}
              </span>
              <button
                type="button"
                className={smallButtonClass}
                disabled={links.length >= SERVICE_LIMITS.maxLinks}
                onClick={() => setLinks([...links, { label: "", url: "" }])}
              >
                {gt("Add link")}
              </button>
            </div>
            {links.length === 0 && (
              <p className="text-xs text-on-surface-faint">
                {gt("Dashboards, repositories, docs: anything somebody on call should find fast.")}
              </p>
            )}
            <div className="space-y-1.5">
              {links.map((link, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    aria-label={gt("Link {n} label", { n: i + 1 })}
                    className={`${inputClass} w-40 shrink-0`}
                    maxLength={SERVICE_LIMITS.linkLabelMaxLength}
                    placeholder={gt("Label")}
                    value={link.label}
                    onChange={(e) =>
                      setLinks(links.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))
                    }
                  />
                  <input
                    type="url"
                    aria-label={gt("Link {n} URL", { n: i + 1 })}
                    className={inputClass}
                    maxLength={SERVICE_LIMITS.linkUrlMaxLength}
                    // i18n-ignore: example URL
                    placeholder="https://"
                    value={link.url}
                    onChange={(e) =>
                      setLinks(links.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))
                    }
                  />
                  <button
                    type="button"
                    className={`${smallButtonClass} text-danger shrink-0`}
                    aria-label={gt("Remove link {n}", { n: i + 1 })}
                    onClick={() => setLinks(links.filter((_, j) => j !== i))}
                  >
                    {gt("Remove")}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div role="group" aria-labelledby={ids.rules}>
            <div className="flex items-center justify-between mb-1">
              <span id={ids.rules} className="text-xs font-medium text-on-surface-secondary">
                {gt("Membership rules")}
              </span>
              <button
                type="button"
                className={smallButtonClass}
                disabled={rules.length >= SERVICE_LIMITS.maxRules}
                onClick={() => setRules([...rules, emptyRule()])}
              >
                {gt("Add rule")}
              </button>
            </div>
            <p className="text-xs text-on-surface-faint mb-1.5">
              {gt(
                "Resources a rule matches join the service on their own, alongside the ones you add by hand. A virtual tag rule only matches resources with per-resource cost rows.",
              )}
            </p>
            <div className="space-y-2">
              {rules.map((rule, i) => (
                <RuleEditor
                  key={i}
                  rule={rule}
                  index={i}
                  pickers={pickers}
                  onChange={(next) => setRules(rules.map((r, j) => (j === i ? next : r)))}
                  onRemove={() => setRules(rules.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor={ids.budget}>
                {gt("Monthly budget (optional)")}
              </label>
              <input
                id={ids.budget}
                type="number"
                min={0}
                step="any"
                className={inputClass}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={ids.currency}>
                {gt("Currency")}
              </label>
              <input
                id={ids.currency}
                type="text"
                maxLength={3}
                className={inputClass}
                list={ids.currencies}
                disabled={budgetTrimmed === ""}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
              <datalist id={ids.currencies}>
                {COMMON_CURRENCIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          </div>
          <p className="text-xs text-on-surface-faint -mt-1">
            {gt("The cost scorecard check compares the last 30 days of member spend with this.")}
          </p>

          {error !== null && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
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
              {saving ? gt("Saving…") : existing ? gt("Save") : gt("Create service")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
