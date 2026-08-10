import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BILLING_RULE_FIXED_PERIODS,
  BILLING_RULE_KIND_DESCRIPTIONS,
  BILLING_RULE_KIND_LABELS,
  BILLING_RULE_KINDS,
  COST_CHARGE_TYPE_LABELS,
  COST_CHARGE_TYPES,
  billingRuleInputError,
  costCentrePaths,
  describeBillingRuleAdjustment,
  describeBillingRuleMatch,
  normalizeBillingRuleInput,
} from "@infrawrench/client-core";
import type {
  BillingRule,
  BillingRuleInput,
  BillingRuleKind,
  CostCentre,
  CostCentrePathRow,
  CostChargeType,
  CostDimensionOption,
} from "@infrawrench/client-core";
import { useSettingsHost, type SettingsApi } from "./host.js";

const selectClass =
  "px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong";

/**
 * Settings → Billing Rules.
 *
 * ## Why this is in Settings and not on the Costs panel
 *
 * The repo's own placement rule is that a *cost object* — a saved filter, a
 * scenario model — belongs on the Costs panel, because it describes the org's
 * own spend, while Settings is where you configure Infrawrench. A billing rule
 * looks like the former and behaves like the latter: it is not another view of
 * spend, it silently changes what every other view says. A markup written here
 * moves the Costs panel, an opted-in budget's thresholds, and the chargeback
 * statement finance sends another department.
 *
 * So it sits beside Cost Centres, Currency and Tag Policy — the three other
 * pages where one person's edit restates numbers everybody else reads — and
 * behind the same permission stating an exchange rate needs.
 *
 * Reading is `costs:read`, because a rule is part of the explanation for a
 * number and hiding it from the people who read the number would make every
 * adjusted figure unauditable. Writing is `org:settings:write`.
 */
export function BillingRulesSection() {
  const { orgId, api, has, openSection } = useSettingsHost();
  const canRead = has("costs:read");
  const canEdit = has("org:settings:write");

  const [rules, setRules] = useState<BillingRule[] | null>(null);
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [accounts, setAccounts] = useState<CostDimensionOption[]>([]);
  const [providers, setProviders] = useState<CostDimensionOption[]>([]);
  const [services, setServices] = useState<CostDimensionOption[]>([]);
  const [tagKeys, setTagKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ruleRows, centreRows] = await Promise.all([
        api.get<BillingRule[]>(`/api/org/${orgId}/billing-rules`),
        api.get<CostCentre[]>(`/api/org/${orgId}/cost-centres`),
      ]);
      setRules(ruleRows);
      setCentres(centreRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing rules");
    }
  }, [api, orgId]);

  useEffect(() => {
    if (!canRead) return;
    void load();
    // Pickers, so nobody has to paste an account id or guess a service name.
    const dimension = (name: string) =>
      api
        .get<{
          values: Array<string | CostDimensionOption>;
        }>(`/api/org/${orgId}/costs/dimensions?dimension=${name}`)
        .then((res) => res.values.map((v) => (typeof v === "string" ? { value: v, label: v } : v)));
    dimension("account").then(setAccounts, () => {});
    dimension("provider").then(setProviders, () => {});
    dimension("service").then(setServices, () => {});
    dimension("tag-keys").then(
      (options) => setTagKeys(options.map((o) => o.value)),
      () => {},
    );
  }, [api, orgId, canRead, load]);

  const centrePaths = useMemo(() => costCentrePaths(centres), [centres]);
  const labelFor = (options: CostDimensionOption[], value: string) =>
    options.find((o) => o.value === value)?.label ?? value;

  /** The rule's target as a name rather than a uuid. */
  function targetLabel(rule: BillingRule): string | null {
    const { targetKind, targetId } = rule.adjustment;
    if (!targetKind || !targetId) return null;
    if (targetKind === "account") return labelFor(accounts, targetId);
    return centrePaths.find((c) => c.id === targetId)?.path ?? targetId;
  }

  async function toggle(rule: BillingRule) {
    try {
      await api.put(`/api/org/${orgId}/billing-rules/${rule.id}`, {
        name: rule.name,
        description: rule.description,
        enabled: !rule.enabled,
        priority: rule.priority,
        match: rule.match,
        adjustment: rule.adjustment,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update rule");
    }
  }

  async function remove(rule: BillingRule) {
    if (
      !window.confirm(
        `Delete the billing rule "${rule.name}"?\n\nNothing is restated — collected spend was ` +
          "never changed — but every adjusted figure will recompute without it.",
      )
    ) {
      return;
    }
    try {
      await api.delete(`/api/org/${orgId}/billing-rules/${rule.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete rule");
    }
  }

  if (!canRead) {
    return (
      <div className="text-sm text-on-surface-secondary">
        You need the <code>costs:read</code> permission to see the organisation&rsquo;s billing
        rules.
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-on-surface">Billing rules</h2>
        <p className="text-sm text-on-surface-secondary">
          Adjustments the organisation applies to collected spend when it reports internally: a
          markup that recovers shared overhead, a discount negotiated outside the provider&rsquo;s
          pricing, a fixed charge per period, or a reallocation that moves a shared cluster&rsquo;s
          cost onto the teams that use it.
        </p>
        <p className="text-sm text-on-surface-muted">
          Rules are applied when a report is run and are <strong>never</strong> written into
          collected spend, so what the providers charged stays exactly as collected and can still be
          reconciled against an invoice. Every adjusted figure is shown beside the collected one and
          names the rules that moved it.
        </p>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-red-500">
          {error}{" "}
          <button type="button" onClick={() => void load()} className="underline">
            Retry
          </button>
        </div>
      )}

      {rules === null && <div className="text-sm text-on-surface-muted">Loading&hellip;</div>}

      {rules !== null && rules.length === 0 && (
        <p className="text-sm text-on-surface-muted">
          No billing rules. Every figure the organisation reports is exactly what the providers
          charged.
        </p>
      )}

      {rules !== null && rules.length > 0 && (
        <ul className="space-y-2">
          {rules.map((rule) => {
            const target = targetLabel(rule);
            return (
              <li
                key={rule.id}
                className="flex items-start gap-3 text-sm border-b border-border/50 pb-2"
              >
                <span className="text-xs text-on-surface-muted w-10 pt-0.5">#{rule.priority}</span>
                <span className="flex-1 min-w-0">
                  <span
                    className={
                      rule.enabled ? "text-on-surface" : "text-on-surface-muted line-through"
                    }
                  >
                    {rule.name}
                  </span>
                  <span className="text-on-surface-muted">
                    {" "}
                    — {describeBillingRuleAdjustment(rule.adjustment)}
                    {target ? ` → ${target}` : ""} on {describeBillingRuleMatch(rule.match)}
                  </span>
                  {rule.description && (
                    <span className="block text-xs text-on-surface-muted">{rule.description}</span>
                  )}
                  {!rule.enabled && (
                    <span className="block text-xs text-on-surface-muted">
                      Disabled — affects nothing.
                    </span>
                  )}
                </span>
                {canEdit && (
                  <span className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void toggle(rule)}
                      className="text-xs text-on-surface-secondary hover:text-on-surface underline"
                    >
                      {rule.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(rule)}
                      className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
                    >
                      Remove
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {rules !== null && rules.length > 0 && (
        <p className="text-xs text-on-surface-muted">
          Lower numbers evaluate first. Every matching markup or discount applies, so two 10%
          markups compound to 21% rather than 20%. Reallocation is first-match-wins, so a row moves
          exactly once and the organisation&rsquo;s total is unchanged by it.
        </p>
      )}

      {canEdit && (
        <NewRuleForm
          api={api}
          orgId={orgId}
          centres={centrePaths}
          accounts={accounts}
          providers={providers}
          services={services}
          tagKeys={tagKeys}
          nextPriority={(rules ?? []).reduce((max, r) => Math.max(max, r.priority), -1) + 1}
          onCreated={load}
          onError={setError}
          onManageCentres={() => openSection("cost-centres")}
        />
      )}

      {!canEdit && rules !== null && (
        <p className="text-xs text-on-surface-muted">
          Changing these needs the <code>org:settings:write</code> permission — a markup changes
          every number the organisation reports about itself.
        </p>
      )}
    </section>
  );
}

/**
 * Create form. Inline rather than a modal, matching the allocation-rule editor
 * next door; existing rules are enable/disable + delete, so a rule's wording
 * cannot drift out from under a figure somebody already reconciled.
 */
function NewRuleForm({
  api,
  orgId,
  centres,
  accounts,
  providers,
  services,
  tagKeys,
  nextPriority,
  onCreated,
  onError,
  onManageCentres,
}: {
  api: SettingsApi;
  orgId: string;
  centres: CostCentrePathRow[];
  accounts: CostDimensionOption[];
  providers: CostDimensionOption[];
  services: CostDimensionOption[];
  tagKeys: string[];
  nextPriority: number;
  onCreated: () => Promise<void>;
  onError: (message: string) => void;
  onManageCentres: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BillingRuleKind>("percentage");
  const [percent, setPercent] = useState("10");
  const [amount, setAmount] = useState("1000");
  const [currency, setCurrency] = useState("USD");
  const [period, setPeriod] = useState<"daily" | "monthly">("monthly");
  const [targetKind, setTargetKind] = useState<"cost_centre" | "account">("cost_centre");
  const [targetId, setTargetId] = useState("");
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");
  const [accountId, setAccountId] = useState("");
  const [pluginId, setPluginId] = useState("");
  const [service, setService] = useState("");
  const [chargeType, setChargeType] = useState<CostChargeType | "">("");
  const [submitting, setSubmitting] = useState(false);

  const input: BillingRuleInput = useMemo(
    () =>
      normalizeBillingRuleInput({
        name,
        description: null,
        enabled: true,
        priority: nextPriority,
        match: {
          ...(tagKey ? { tagKey } : {}),
          ...(tagKey && tagValue ? { tagValue } : {}),
          ...(accountId ? { accountId } : {}),
          ...(pluginId ? { pluginId } : {}),
          ...(service ? { service } : {}),
          ...(chargeType ? { chargeType } : {}),
        },
        adjustment: {
          kind,
          ...(kind === "percentage" ? { percent: Number(percent) } : {}),
          ...(kind === "fixed" ? { amount: Number(amount), currency, period } : {}),
          ...(kind !== "percentage" && targetId ? { targetKind, targetId } : {}),
        },
      }),
    [
      name,
      nextPriority,
      tagKey,
      tagValue,
      accountId,
      pluginId,
      service,
      chargeType,
      kind,
      percent,
      amount,
      currency,
      period,
      targetKind,
      targetId,
    ],
  );

  // The same validator the API refuses with, so the button explains itself
  // rather than the server doing it a round-trip later in identical words.
  const blocker = billingRuleInputError(input);

  async function submit() {
    if (blocker) return;
    setSubmitting(true);
    try {
      await api.post(`/api/org/${orgId}/billing-rules`, input);
      setName("");
      setTagKey("");
      setTagValue("");
      setAccountId("");
      setPluginId("");
      setService("");
      setChargeType("");
      setTargetId("");
      await onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create rule");
    } finally {
      setSubmitting(false);
    }
  }

  const targetOptions =
    targetKind === "account"
      ? accounts
      : centres.map((c) => ({ value: c.id, label: c.path }) as CostDimensionOption);

  return (
    <div className="flex flex-col gap-2 pt-3 border-t border-border">
      <h3 className="text-sm font-medium text-on-surface">Add a rule</h3>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rule name"
          aria-label="Rule name"
          className={selectClass}
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as BillingRuleKind)}
          aria-label="Adjustment"
          className={selectClass}
        >
          {BILLING_RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {BILLING_RULE_KIND_LABELS[k]}
            </option>
          ))}
        </select>

        {kind === "percentage" && (
          <input
            type="number"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            aria-label="Percent"
            className={`${selectClass} w-24`}
          />
        )}
        {kind === "fixed" && (
          <>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount"
              className={`${selectClass} w-28`}
            />
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              aria-label="Currency"
              className={`${selectClass} w-20`}
            />
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as "daily" | "monthly")}
              aria-label="Period"
              className={selectClass}
            >
              {BILLING_RULE_FIXED_PERIODS.map((p) => (
                <option key={p} value={p}>
                  per {p === "daily" ? "day" : "month"}
                </option>
              ))}
            </select>
          </>
        )}

        {kind !== "percentage" && (
          <>
            <select
              value={targetKind}
              onChange={(e) => setTargetKind(e.target.value as "cost_centre" | "account")}
              aria-label="Target kind"
              className={selectClass}
            >
              <option value="cost_centre">to cost centre</option>
              <option value="account">to account</option>
            </select>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              aria-label="Target"
              className={selectClass}
            >
              <option value="">
                {kind === "fixed" ? "unallocated (org-level)" : "pick a target…"}
              </option>
              {targetOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <p className="text-xs text-on-surface-muted">{BILLING_RULE_KIND_DESCRIPTIONS[kind]}</p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-on-surface-secondary">applies to</span>
        <select
          value={tagKey}
          onChange={(e) => setTagKey(e.target.value)}
          aria-label="Tag key"
          className={selectClass}
        >
          <option value="">Any tag</option>
          {tagKeys.map((key) => (
            <option key={key} value={key}>
              tag: {key}
            </option>
          ))}
        </select>
        {tagKey && (
          <input
            type="text"
            value={tagValue}
            onChange={(e) => setTagValue(e.target.value)}
            placeholder="value (blank = any)"
            aria-label="Tag value"
            className={selectClass}
          />
        )}
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          aria-label="Account"
          className={selectClass}
        >
          <option value="">Any account</option>
          {accounts.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <select
          value={pluginId}
          onChange={(e) => setPluginId(e.target.value)}
          aria-label="Provider"
          className={selectClass}
        >
          <option value="">Any provider</option>
          {providers.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={service}
          onChange={(e) => setService(e.target.value)}
          aria-label="Service"
          className={selectClass}
        >
          <option value="">Any service</option>
          {services.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={chargeType}
          onChange={(e) => setChargeType(e.target.value as CostChargeType | "")}
          aria-label="Charge type"
          className={selectClass}
        >
          <option value="">Any charge type</option>
          {COST_CHARGE_TYPES.map((t) => (
            <option key={t} value={t}>
              {COST_CHARGE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || blocker !== null}
          className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
        >
          Add rule
        </button>
        {blocker !== null && name.length > 0 && (
          <span className="text-xs text-amber-500">{blocker}</span>
        )}
        <button
          type="button"
          onClick={onManageCentres}
          className="text-xs text-on-surface-secondary hover:text-on-surface underline"
        >
          Manage cost centres →
        </button>
      </div>
    </div>
  );
}
