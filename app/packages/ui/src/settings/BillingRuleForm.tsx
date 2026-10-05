import { useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import {
  BILLING_RULE_FIXED_PERIODS,
  BILLING_RULE_KIND_DESCRIPTIONS,
  BILLING_RULE_KIND_LABELS,
  BILLING_RULE_KINDS,
  BILLING_RULE_TIER_MODE_LABELS,
  BILLING_RULE_TIER_MODES,
  BILLING_RULE_TIER_SCOPE_LABELS,
  BILLING_RULE_TIER_SCOPES,
  COST_CHARGE_TYPE_LABELS,
  COST_CHARGE_TYPES,
  PRICING_EXPRESSION_FIELDS,
  PRICING_EXPRESSION_FUNCTIONS,
  billingRuleInputError,
  isInvoiceOnlyBillingRuleKind,
  normalizeBillingRuleInput,
  pricingExpressionError,
} from "@infrawrench/client-core";
import type {
  BillingRule,
  BillingRuleInput,
  BillingRuleKind,
  BillingRuleTier,
  BillingRuleTierMode,
  BillingRuleTierScope,
  CostCentrePathRow,
  CostChargeType,
  CostDimensionOption,
  ManagedAccount,
  PricingPreviewResult,
} from "@infrawrench/client-core";
import type { SettingsApi } from "./host.js";
import { PricingPreviewView } from "../cost/PricingPreview.js";

const selectClass =
  "px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong";

const DEFAULT_TIERS: BillingRuleTier[] = [
  { upTo: 10_000, percent: 8 },
  { upTo: 50_000, percent: 5 },
  { upTo: null, percent: 3 },
];

/** `YYYY-MM` of last calendar month, the preview's default. */
function previousMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}

/** A string literal in the expression language. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The tier table: one row per tier, the last open-ended. Adding a tier splits
 * the open-ended one; removing keeps the last row open-ended, so the list is
 * always a shape the validator accepts apart from the numbers themselves.
 */
function TierEditor({
  tiers,
  onChange,
}: {
  tiers: BillingRuleTier[];
  onChange: (tiers: BillingRuleTier[]) => void;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-col gap-1">
      {tiers.map((tier, i) => {
        const last = i === tiers.length - 1;
        const from = i === 0 ? 0 : (tiers[i - 1]!.upTo ?? 0);
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-28 text-on-surface-secondary">
              {last ? gt("above {from}", { from }) : gt("from {from} to", { from })}
            </span>
            {!last && (
              <input
                type="number"
                value={tier.upTo ?? ""}
                aria-label={gt("Tier {n} upper bound", { n: i + 1 })}
                onChange={(e) =>
                  onChange(
                    tiers.map((t, j) => (j === i ? { ...t, upTo: Number(e.target.value) } : t)),
                  )
                }
                className={`${selectClass} w-28`}
              />
            )}
            <input
              type="number"
              value={tier.percent}
              aria-label={gt("Tier {n} percent", { n: i + 1 })}
              onChange={(e) =>
                onChange(
                  tiers.map((t, j) => (j === i ? { ...t, percent: Number(e.target.value) } : t)),
                )
              }
              className={`${selectClass} w-20`}
            />
            <span className="text-on-surface-muted">%</span>
            {tiers.length > 1 && (
              <button
                type="button"
                className="text-danger"
                onClick={() => {
                  const next = tiers.filter((_, j) => j !== i);
                  next[next.length - 1] = { ...next[next.length - 1]!, upTo: null };
                  onChange(next);
                }}
              >
                {gt("Remove")}
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="self-start text-xs text-on-surface-secondary underline"
        onClick={() => {
          const lastBound = tiers.length > 1 ? (tiers[tiers.length - 2]!.upTo ?? 0) : 0;
          const head = tiers.slice(0, -1);
          const open = tiers[tiers.length - 1] ?? { upTo: null, percent: 0 };
          onChange([
            ...head,
            { upTo: lastBound > 0 ? lastBound * 2 : 10_000, percent: open.percent },
            { upTo: null, percent: open.percent },
          ]);
        }}
      >
        {gt("Add a tier")}
      </button>
    </div>
  );
}

/**
 * The expression box: live parse and type errors with the character they were
 * found at, a reference of every field and function, and pickers that insert
 * real service, provider, account and tag names so nobody has to know what a
 * provider calls its services.
 */
function ExpressionEditor({
  value,
  onChange,
  providers,
  services,
  accounts,
  tagKeys,
}: {
  value: string;
  onChange: (value: string) => void;
  providers: CostDimensionOption[];
  services: CostDimensionOption[];
  accounts: CostDimensionOption[];
  tagKeys: string[];
}) {
  const gt = useGT();
  const gtData = useDataString();
  const error = value.trim() ? pricingExpressionError(value) : null;
  const insert = (snippet: string) =>
    onChange(value.trim() ? `${value.trimEnd()} ${snippet}` : snippet);

  return (
    <div className="flex w-full flex-col gap-1">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        aria-label={gt("Pricing expression")}
        // i18n-ignore: syntax example of the pricing expression language
        placeholder='if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1'
        className={`${selectClass} w-full font-mono text-xs`}
      />
      {error ? (
        <div role="alert" className="flex flex-col text-xs text-warning">
          <span className="font-mono whitespace-pre">
            {value.split("\n").join(" ")}
            {"\n"}
            {" ".repeat(Math.min(error.position, value.length))}^
          </span>
          <span>
            {gt("Character {n}: {message}", { n: error.position + 1, message: error.message })}
          </span>
        </div>
      ) : value.trim() ? (
        <span className="text-xs text-success">{gt("The expression is valid.")}</span>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-on-surface-muted">{gt("Insert:")}</span>
        <select
          value=""
          aria-label={gt("Insert a service condition")}
          onChange={(e) => e.target.value && insert(`service == ${quote(e.target.value)}`)}
          className={selectClass}
        >
          <option value="">{gt("service…")}</option>
          {services.map((s) => (
            <option key={s.value} value={s.value}>
              {gtData(s.label)}
            </option>
          ))}
        </select>
        <select
          value=""
          aria-label={gt("Insert a provider condition")}
          onChange={(e) => e.target.value && insert(`provider == ${quote(e.target.value)}`)}
          className={selectClass}
        >
          <option value="">{gt("provider…")}</option>
          {providers.map((p) => (
            <option key={p.value} value={p.value}>
              {gtData(p.label)}
            </option>
          ))}
        </select>
        <select
          value=""
          aria-label={gt("Insert an account condition")}
          onChange={(e) => e.target.value && insert(`account == ${quote(e.target.value)}`)}
          className={selectClass}
        >
          <option value="">{gt("account…")}</option>
          {accounts.map((a) => (
            <option key={a.value} value={a.value}>
              {gtData(a.label)}
            </option>
          ))}
        </select>
        <select
          value=""
          aria-label={gt("Insert a tag")}
          onChange={(e) =>
            e.target.value &&
            insert(
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.target.value)
                ? `tag.${e.target.value} == ""`
                : `tag[${quote(e.target.value)}] == ""`,
            )
          }
          className={selectClass}
        >
          <option value="">{gt("tag…")}</option>
          {tagKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <details className="text-xs text-on-surface-muted">
        <summary className="cursor-pointer">{gt("Expression reference")}</summary>
        <T>
          <p className="mt-1">
            The expression gives the line&rsquo;s new cost. Write <code>if</code> condition{" "}
            <code>then</code> cost to change only matching lines; without an <code>else</code>,
            other lines keep their cost. Conditions use <code>==</code>, <code>!=</code>,{" "}
            <code>&lt;</code>, <code>&gt;</code>, <code>and</code>, <code>or</code>,{" "}
            <code>not</code> and <code>in [&hellip;]</code>. Text is compared exactly.
          </p>
        </T>
        <ul className="mt-1 grid grid-cols-1 gap-0.5 sm:grid-cols-2">
          {PRICING_EXPRESSION_FIELDS.map((f) => (
            <li key={f.name}>
              <code>{f.name}</code> {gtData(f.description)}
            </li>
          ))}
          <li>
            {/* i18n-ignore: expression-language syntax */}
            <code>tag.key</code> {gt("A tag's value, or empty when the line does not carry it.")}
          </li>
          {Object.entries(PRICING_EXPRESSION_FUNCTIONS).map(([name, spec]) => (
            <li key={name}>
              <code>{name}()</code> {gtData(spec.description)}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * Create or edit a rule. Editing loads the rule into the same form and PUTs
 * the whole thing back, so there is one place where a rule's wording is
 * written, and every save is one audited act.
 */
export function BillingRuleForm({
  api,
  orgId,
  editing,
  centres,
  accounts,
  providers,
  services,
  tagKeys,
  customers,
  canPreviewCustomers,
  nextPriority,
  onSaved,
  onCancel,
  onError,
  onManageCentres,
}: {
  api: SettingsApi;
  orgId: string;
  /** The rule being edited, or null for a new one. */
  editing: BillingRule | null;
  centres: CostCentrePathRow[];
  accounts: CostDimensionOption[];
  providers: CostDimensionOption[];
  services: CostDimensionOption[];
  tagKeys: string[];
  /** Managed accounts, when the caller can read them; null otherwise. */
  customers: ManagedAccount[] | null;
  canPreviewCustomers: boolean;
  nextPriority: number;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
  onManageCentres: () => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const a = editing?.adjustment;
  const m = editing?.match;
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [kind, setKind] = useState<BillingRuleKind>(a?.kind ?? "percentage");
  const [percent, setPercent] = useState(String(a?.percent ?? 10));
  const [amount, setAmount] = useState(String(a?.amount ?? 1000));
  const [currency, setCurrency] = useState(a?.currency ?? "USD");
  const [period, setPeriod] = useState<"daily" | "monthly">(a?.period ?? "monthly");
  const [targetKind, setTargetKind] = useState<"cost_centre" | "account">(
    a?.targetKind ?? "cost_centre",
  );
  const [targetId, setTargetId] = useState(a?.targetId ?? "");
  const [tiers, setTiers] = useState<BillingRuleTier[]>(a?.tiers ?? DEFAULT_TIERS);
  const [tierMode, setTierMode] = useState<BillingRuleTierMode>(a?.tierMode ?? "marginal");
  const [tierScope, setTierScope] = useState<BillingRuleTierScope>(a?.tierScope ?? "overall");
  const [expression, setExpression] = useState(a?.expression ?? "");
  const [customerIds, setCustomerIds] = useState<string[]>(editing?.managedAccountIds ?? []);
  const [tagKey, setTagKey] = useState(m?.tagKey ?? "");
  const [tagValue, setTagValue] = useState(m?.tagValue ?? "");
  const [accountId, setAccountId] = useState(m?.accountId ?? "");
  const [pluginId, setPluginId] = useState(m?.pluginId ?? "");
  const [service, setService] = useState(m?.service ?? "");
  const [chargeType, setChargeType] = useState<CostChargeType | "">(m?.chargeType ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [previewCustomer, setPreviewCustomer] = useState("");
  const [previewMonth, setPreviewMonth] = useState(previousMonth);
  const [preview, setPreview] = useState<PricingPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const invoiceOnly = isInvoiceOnlyBillingRuleKind(kind);

  const input: BillingRuleInput = useMemo(
    () =>
      normalizeBillingRuleInput({
        name,
        description: description || null,
        enabled: editing?.enabled ?? true,
        priority: editing?.priority ?? nextPriority,
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
          ...((kind === "fixed" || kind === "reallocation") && targetId
            ? { targetKind, targetId }
            : {}),
          ...(kind === "tiered" ? { tiers, tierMode, tierScope, currency } : {}),
          ...(kind === "expression" ? { expression } : {}),
        },
        managedAccountIds: invoiceOnly ? customerIds : [],
      }),
    [
      name,
      description,
      editing,
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
      tiers,
      tierMode,
      tierScope,
      expression,
      invoiceOnly,
      customerIds,
    ],
  );

  // The same validator the API refuses with, so the button explains itself
  // rather than the server doing it a round-trip later in identical words.
  const blocker = billingRuleInputError(input);

  async function submit() {
    if (blocker) return;
    setSubmitting(true);
    try {
      if (editing) await api.put(`/api/org/${orgId}/billing-rules/${editing.id}`, input);
      else await api.post(`/api/org/${orgId}/billing-rules`, input);
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : gt("Failed to save rule"));
    } finally {
      setSubmitting(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPreview(
        await api.post<PricingPreviewResult>(`/api/org/${orgId}/billing-rules/preview`, {
          rule: input,
          ...(editing ? { ruleId: editing.id } : {}),
          ...(previewCustomer ? { managedAccountId: previewCustomer } : {}),
          month: previewMonth,
        }),
      );
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : gt("Preview failed"));
    } finally {
      setPreviewing(false);
    }
  }

  const targetOptions =
    targetKind === "account"
      ? accounts
      : centres.map((c) => ({ value: c.id, label: c.path }) as CostDimensionOption);

  return (
    <div className="flex flex-col gap-2 pt-3 border-t border-border">
      <h3 className="text-sm font-medium text-on-surface">
        {editing ? gt("Edit “{name}”", { name: editing.name }) : gt("Add a rule")}
      </h3>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={gt("Rule name")}
          aria-label={gt("Rule name")}
          className={selectClass}
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as BillingRuleKind)}
          aria-label={gt("Adjustment")}
          className={selectClass}
        >
          {BILLING_RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {gtData(BILLING_RULE_KIND_LABELS[k])}
            </option>
          ))}
        </select>

        {kind === "percentage" && (
          <input
            type="number"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            aria-label={gt("Percent")}
            className={`${selectClass} w-24`}
          />
        )}
        {kind === "fixed" && (
          <>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label={gt("Amount")}
              className={`${selectClass} w-28`}
            />
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              aria-label={gt("Currency")}
              className={`${selectClass} w-20`}
            />
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as "daily" | "monthly")}
              aria-label={gt("Period")}
              className={selectClass}
            >
              {BILLING_RULE_FIXED_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {p === "daily" ? gt("per day") : gt("per month")}
                </option>
              ))}
            </select>
          </>
        )}

        {(kind === "fixed" || kind === "reallocation") && (
          <>
            <select
              value={targetKind}
              onChange={(e) => setTargetKind(e.target.value as "cost_centre" | "account")}
              aria-label={gt("Target kind")}
              className={selectClass}
            >
              <option value="cost_centre">{gt("to cost centre")}</option>
              <option value="account">{gt("to account")}</option>
            </select>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              aria-label={gt("Target")}
              className={selectClass}
            >
              <option value="">
                {kind === "fixed" ? gt("unallocated (org-level)") : gt("pick a target…")}
              </option>
              {targetOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {gtData(o.label)}
                </option>
              ))}
            </select>
          </>
        )}

        {kind === "tiered" && (
          <>
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              aria-label={gt("Currency the tiers are stated in")}
              className={`${selectClass} w-20`}
            />
            <select
              value={tierMode}
              onChange={(e) => setTierMode(e.target.value as BillingRuleTierMode)}
              aria-label={gt("Tier mode")}
              className={selectClass}
            >
              {BILLING_RULE_TIER_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {gtData(BILLING_RULE_TIER_MODE_LABELS[mode])}
                </option>
              ))}
            </select>
            <select
              value={tierScope}
              onChange={(e) => setTierScope(e.target.value as BillingRuleTierScope)}
              aria-label={gt("Tier volume")}
              className={selectClass}
            >
              {BILLING_RULE_TIER_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {gtData(BILLING_RULE_TIER_SCOPE_LABELS[scope])}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <p className="text-xs text-on-surface-muted">
        {gtData(BILLING_RULE_KIND_DESCRIPTIONS[kind])}
      </p>

      {kind === "tiered" && <TierEditor tiers={tiers} onChange={setTiers} />}
      {kind === "expression" && (
        <ExpressionEditor
          value={expression}
          onChange={setExpression}
          providers={providers}
          services={services}
          accounts={accounts}
          tagKeys={tagKeys}
        />
      )}

      {invoiceOnly && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-secondary">
            {gt("Customers whose invoices this prices (none ticked means every customer)")}
          </span>
          {customers === null ? (
            <T>
              <p className="text-xs text-on-surface-muted">
                Limiting a rule to particular customers needs the <code>invoices:read</code>{" "}
                permission to list them.
              </p>
            </T>
          ) : customers.length === 0 ? (
            <p className="text-xs text-on-surface-muted">
              {gt("No managed accounts yet; add customers under Invoices.")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {customers.map((c) => (
                <label key={c.id} className="flex items-center gap-1 text-xs text-on-surface">
                  <input
                    type="checkbox"
                    checked={customerIds.includes(c.id)}
                    onChange={() =>
                      setCustomerIds((ids) =>
                        ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id],
                      )
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-on-surface-secondary">{gt("applies to")}</span>
        <select
          value={tagKey}
          onChange={(e) => setTagKey(e.target.value)}
          aria-label={gt("Tag key")}
          className={selectClass}
        >
          <option value="">{gt("Any tag")}</option>
          {tagKeys.map((key) => (
            <option key={key} value={key}>
              {gt("tag: {key}", { key })}
            </option>
          ))}
        </select>
        {tagKey && (
          <input
            type="text"
            value={tagValue}
            onChange={(e) => setTagValue(e.target.value)}
            placeholder={gt("value (blank = any)")}
            aria-label={gt("Tag value")}
            className={selectClass}
          />
        )}
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          aria-label={gt("Account")}
          className={selectClass}
        >
          <option value="">{gt("Any account")}</option>
          {accounts.map((acc) => (
            <option key={acc.value} value={acc.value}>
              {gtData(acc.label)}
            </option>
          ))}
        </select>
        <select
          value={pluginId}
          onChange={(e) => setPluginId(e.target.value)}
          aria-label={gt("Provider")}
          className={selectClass}
        >
          <option value="">{gt("Any provider")}</option>
          {providers.map((p) => (
            <option key={p.value} value={p.value}>
              {gtData(p.label)}
            </option>
          ))}
        </select>
        <select
          value={service}
          onChange={(e) => setService(e.target.value)}
          aria-label={gt("Service")}
          className={selectClass}
        >
          <option value="">{gt("Any service")}</option>
          {services.map((s) => (
            <option key={s.value} value={s.value}>
              {gtData(s.label)}
            </option>
          ))}
        </select>
        <select
          value={chargeType}
          onChange={(e) => setChargeType(e.target.value as CostChargeType | "")}
          aria-label={gt("Charge type")}
          className={selectClass}
        >
          <option value="">{gt("Any charge type")}</option>
          {COST_CHARGE_TYPES.map((t) => (
            <option key={t} value={t}>
              {gtData(COST_CHARGE_TYPE_LABELS[t])}
            </option>
          ))}
        </select>
      </div>

      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={gt("Description (optional)")}
        aria-label={gt("Description")}
        className={selectClass}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || blocker !== null}
          className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
        >
          {editing ? gt("Save rule") : gt("Add rule")}
        </button>
        {editing && (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-on-surface-secondary hover:text-on-surface underline"
          >
            {gt("Cancel")}
          </button>
        )}
        {blocker !== null && name.length > 0 && (
          <span className="text-xs text-warning">{blocker}</span>
        )}
        <button
          type="button"
          onClick={onManageCentres}
          className="text-xs text-on-surface-secondary hover:text-on-surface underline"
        >
          {gt("Manage cost centres →")}
        </button>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <span className="text-xs font-medium text-on-surface">
          {gt("Preview against real spend")}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={previewMonth}
            onChange={(e) => setPreviewMonth(e.target.value)}
            aria-label={gt("Preview month")}
            className={selectClass}
          />
          {canPreviewCustomers && customers && customers.length > 0 && (
            <select
              value={previewCustomer}
              onChange={(e) => setPreviewCustomer(e.target.value)}
              aria-label={gt("Preview customer")}
              className={selectClass}
            >
              <option value="">{gt("Whole organisation")}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={previewing || blocker !== null || !previewMonth}
            className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
          >
            {previewing ? gt("Pricing…") : gt("Preview")}
          </button>
        </div>
        {kind === "reallocation" || kind === "fixed" ? (
          <p className="text-xs text-on-surface-muted">
            {gt(
              "Reallocation and fixed-amount rules do not change line prices, so the preview shows the other rules only.",
            )}
          </p>
        ) : null}
        {previewError !== null && (
          <p role="alert" className="text-xs text-danger">
            {previewError}
          </p>
        )}
        {preview && <PricingPreviewView result={preview} />}
      </div>
    </div>
  );
}
