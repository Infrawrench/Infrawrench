import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  costCentrePaths,
  describeBillingRuleAdjustment,
  describeBillingRuleMatch,
  isInvoiceOnlyBillingRuleKind,
} from "@infrawrench/client-core";
import type {
  BillingRule,
  CostCentre,
  CostDimensionOption,
  ManagedAccount,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";
import { BillingRuleForm } from "./BillingRuleForm.js";

/** A dimension value as its picker label, falling back to the raw id. */
function labelFor(options: CostDimensionOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * Settings → Billing Rules.
 *
 * ## Why this is in Settings and not on the Costs panel
 *
 * The repo's own placement rule is that a *cost object*: a saved filter, a
 * scenario model; belongs on the Costs panel, because it describes the org's
 * own spend, while Settings is where you configure Infrawrench. A billing rule
 * looks like the former and behaves like the latter: it is not another view of
 * spend, it silently changes what every other view says. A markup written here
 * moves the Costs panel, an opted-in budget's thresholds, and the chargeback
 * statement finance sends another department.
 *
 * So it sits beside Cost Centres, Currency and Tag Policy (the three other
 * pages where one person's edit restates numbers everybody else reads) and
 * behind the same permission stating an exchange rate needs.
 *
 * Reading is `costs:read`, because a rule is part of the explanation for a
 * number and hiding it from the people who read the number would make every
 * adjusted figure unauditable. Writing is `org:settings:write`.
 */
export function BillingRulesSection() {
  const gt = useGT();
  const { orgId, api, has, openSection } = useSettingsHost();
  const canRead = has("costs:read");
  const canEdit = has("org:settings:write");
  const canReadCustomers = has("invoices:read");

  const [rules, setRules] = useState<BillingRule[] | null>(null);
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [accounts, setAccounts] = useState<CostDimensionOption[]>([]);
  const [providers, setProviders] = useState<CostDimensionOption[]>([]);
  const [services, setServices] = useState<CostDimensionOption[]>([]);
  const [tagKeys, setTagKeys] = useState<CostDimensionOption[]>([]);
  const [customers, setCustomers] = useState<ManagedAccount[] | null>(null);
  const [editing, setEditing] = useState<BillingRule | null>(null);
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
      setError(e instanceof Error ? e.message : gt("Failed to load billing rules"));
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
    // Preferred keys first, hidden ones left out: the server applies the org's
    // tag key settings.
    dimension("tag-keys").then(setTagKeys, () => {});
    // Customers, for scoping tiered and expression rules and for previewing
    // one customer's invoice. Optional: without `invoices:read` the picker
    // explains itself instead.
    if (canReadCustomers) {
      api
        .get<ManagedAccount[]>(`/api/org/${orgId}/managed-accounts`)
        .then(setCustomers, () => setCustomers(null));
    }
  }, [api, orgId, canRead, canReadCustomers, load]);

  const customerName = useMemo(
    () => new Map((customers ?? []).map((c) => [c.id, c.name])),
    [customers],
  );

  const centrePaths = useMemo(() => costCentrePaths(centres), [centres]);

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
        managedAccountIds: rule.managedAccountIds ?? [],
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to update rule"));
    }
  }

  /** Swap a rule with its neighbour and persist the whole order at once. */
  async function move(index: number, delta: -1 | 1) {
    if (!rules) return;
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const ids = rules.map((r) => r.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    try {
      setRules(await api.post<BillingRule[]>(`/api/org/${orgId}/billing-rules/reorder`, { ids }));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to reorder rules"));
    }
  }

  async function remove(rule: BillingRule) {
    if (
      !window.confirm(
        gt(
          'Delete the billing rule "{name}"?\n\nCollected spend is unaffected; adjusted figures will recompute without it.',
          { name: rule.name },
        ),
      )
    ) {
      return;
    }
    try {
      await api.delete(`/api/org/${orgId}/billing-rules/${rule.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete rule"));
    }
  }

  if (!canRead) {
    return (
      <T>
        <div className="text-sm text-on-surface-secondary">
          You need the <code>costs:read</code> permission to see the organisation&rsquo;s billing
          rules.
        </div>
      </T>
    );
  }

  return (
    <section className="flex flex-col gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-on-surface">{gt("Billing rules")}</h2>
        <T>
          <p className="text-sm text-on-surface-secondary">
            Markups, discounts, fixed charges and reallocations applied to spend in internal
            reports.
          </p>
        </T>
        <T>
          <p className="text-sm text-on-surface-muted">
            Rules apply at report time and <strong>never</strong> change collected spend, so it
            still reconciles against the invoice.
          </p>
        </T>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={() => void load()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}

      {rules === null && <div className="text-sm text-on-surface-muted">{gt("Loading…")}</div>}

      {rules !== null && rules.length === 0 && (
        <T>
          <p className="text-sm text-on-surface-muted">
            No billing rules. Every figure the organisation reports is exactly what the providers
            charged.
          </p>
        </T>
      )}

      {rules !== null && rules.length > 0 && (
        <ul className="space-y-2">
          {rules.map((rule, index) => {
            const target = targetLabel(rule);
            const invoiceOnly = isInvoiceOnlyBillingRuleKind(rule.adjustment.kind);
            const scoped = rule.managedAccountIds ?? [];
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
                  <T>
                    <span className="text-on-surface-muted">
                      {" "}
                      · <Var>{describeBillingRuleAdjustment(rule.adjustment)}</Var>
                      <Var>{target ? ` → ${target}` : ""}</Var> on{" "}
                      <Var>{describeBillingRuleMatch(rule.match)}</Var>
                    </span>
                  </T>
                  {invoiceOnly && (
                    <span className="block text-xs text-info">
                      {scoped.length === 0
                        ? gt("Invoices only · every customer")
                        : gt("Invoices only · {customers}", {
                            customers: scoped.map((id) => customerName.get(id) ?? id).join(", "),
                          })}
                    </span>
                  )}
                  {rule.description && (
                    <span className="block text-xs text-on-surface-muted">{rule.description}</span>
                  )}
                  {!rule.enabled && (
                    <T>
                      <span className="block text-xs text-on-surface-muted">
                        Disabled; affects nothing.
                      </span>
                    </T>
                  )}
                </span>
                {canEdit && (
                  <span className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void move(index, -1)}
                      disabled={index === 0}
                      aria-label={gt("Move up")}
                      className="text-xs text-on-surface-secondary hover:text-on-surface disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => void move(index, 1)}
                      disabled={index === rules.length - 1}
                      aria-label={gt("Move down")}
                      className="text-xs text-on-surface-secondary hover:text-on-surface disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(rule)}
                      className="text-xs text-on-surface-secondary hover:text-on-surface underline"
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggle(rule)}
                      className="text-xs text-on-surface-secondary hover:text-on-surface underline"
                    >
                      {rule.enabled ? gt("Disable") : gt("Enable")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(rule)}
                      className="text-xs text-danger hover:text-danger-strong"
                    >
                      {gt("Remove")}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {rules !== null && rules.length > 0 && (
        <T>
          <p className="text-xs text-on-surface-muted">
            Lower numbers evaluate first. Matching markups and discounts all apply and compound (two
            10% markups make 21%). Reallocation is first-match-wins. Tiered and expression rules
            price managed-account invoices only.
          </p>
        </T>
      )}

      {canEdit && (
        <BillingRuleForm
          // Remount per rule so the form's fields are the rule's, not the last one's.
          key={editing?.id ?? "new"}
          api={api}
          orgId={orgId}
          editing={editing}
          centres={centrePaths}
          accounts={accounts}
          providers={providers}
          services={services}
          tagKeys={tagKeys}
          customers={canReadCustomers ? customers : null}
          canPreviewCustomers={canReadCustomers}
          nextPriority={(rules ?? []).reduce((max, r) => Math.max(max, r.priority), -1) + 1}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onCancel={() => setEditing(null)}
          onError={setError}
          onManageCentres={() => openSection("cost-centres")}
        />
      )}

      {!canEdit && rules !== null && (
        <T>
          <p className="text-xs text-on-surface-muted">
            Changing these needs the <code>org:settings:write</code> permission.
          </p>
        </T>
      )}
    </section>
  );
}
