import { useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  ALERT_EMAIL_LIMITS,
  normalizeAlertEmailDomain,
  type AlertEmailExternalPolicy,
  type AlertEmailSettingsView,
} from "@infrawrench/client-core";
import { useSettingsHost } from "../host.js";
import { CloseIcon } from "../../components/icons/ChromeIcons.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";

/**
 * The email "connection": not something to connect (the deployment's mail
 * provider is configured once, server-side) but the two org decisions email
 * needs. Which extra addresses alert recipients may name, and which addresses
 * unsubscribed. Where those addresses come from is per object: email
 * destinations on the routing rules below, and the recipient lists on budgets,
 * change alerts and the anomaly and efficiency settings.
 */
export function EmailSection({ orgId }: { orgId: string }) {
  const gt = useGT();
  const { api } = useSettingsHost();
  const [view, setView] = useState<AlertEmailSettingsView | null>(null);
  const [policy, setPolicy] = useState<AlertEmailExternalPolicy>("member-domains");
  const [domains, setDomains] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  function apply(v: AlertEmailSettingsView): void {
    setView(v);
    setPolicy(v.externalPolicy);
    setDomains(v.allowedDomains);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .get<AlertEmailSettingsView>(`/api/org/${orgId}/alert-email/settings`)
      .then((v) => {
        if (!cancelled) apply(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  if (!view) {
    return error ? (
      <p className="text-sm text-danger">{error}</p>
    ) : (
      <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
    );
  }

  const dirty =
    policy !== view.externalPolicy || domains.join(",") !== view.allowedDomains.join(",");

  function addDomain(): void {
    const domain = normalizeAlertEmailDomain(draft);
    if (!domain) {
      setError(gt("That doesn't look like a domain name."));
      return;
    }
    if (!domains.includes(domain)) setDomains([...domains, domain].sort());
    setDraft("");
    setError(null);
    setJustSaved(false);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      apply(
        await api.put<AlertEmailSettingsView>(`/api/org/${orgId}/alert-email/settings`, {
          externalPolicy: policy,
          allowedDomains: domains,
        }),
      );
      setJustSaved(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resume(id: string): Promise<void> {
    setError(null);
    try {
      await api.delete(`/api/org/${orgId}/alert-email/suppressions/${id}`);
      setView((v) => (v ? { ...v, suppressions: v.suppressions.filter((s) => s.id !== id) } : v));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-on-surface-secondary">{gt("Alert email")}</h3>
        <T>
          <p className="text-xs text-on-surface-muted mt-1 max-w-2xl">
            Email members or other addresses from the routing rules below, or directly from budgets
            and cost alerts. Every message includes a one-click unsubscribe link.
          </p>
        </T>
        {!view.emailAvailable ? (
          <p className="text-xs text-warning mt-2">
            {gt(
              "This deployment has no mail provider configured, so alert email is saved but never sent.",
            )}
          </p>
        ) : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-on-surface-secondary">
          {gt("Extra addresses")}
        </legend>
        <label className="flex items-start gap-2 text-sm text-on-surface-secondary">
          <input
            type="radio"
            name={`${orgId}-alert-email-policy`}
            checked={policy === "member-domains"}
            onChange={() => {
              setPolicy("member-domains");
              setJustSaved(false);
            }}
          />
          <span>
            {gt("Only our own domains")}
            <span className="block text-xs text-on-surface-faint">
              {view.memberDomains.length > 0
                ? gt("Domains your members sign in with ({domains}), plus any you allow below.", {
                    domains: view.memberDomains.join(", "),
                  })
                : gt("Domains your members sign in with, plus any you allow below.")}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-on-surface-secondary">
          <input
            type="radio"
            name={`${orgId}-alert-email-policy`}
            checked={policy === "any"}
            onChange={() => {
              setPolicy("any");
              setJustSaved(false);
            }}
          />
          <span>
            {gt("Any address")}
            <span className="block text-xs text-on-surface-faint">
              {gt(
                "Anyone who can edit a budget or cost alert can then send its alerts, and the spend figures in them, to any inbox.",
              )}
            </span>
          </span>
        </label>
      </fieldset>

      {policy === "member-domains" ? (
        <div className="space-y-2">
          <span className="block text-xs font-medium text-on-surface-secondary">
            {gt("Also allow these domains")}
          </span>
          {domains.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {domains.map((d) => (
                <li
                  key={d}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs text-on-surface"
                >
                  {d}
                  <button
                    type="button"
                    aria-label={gt("Remove {name}", { name: d })}
                    className="text-on-surface-faint hover:text-on-surface"
                    onClick={() => {
                      setDomains(domains.filter((x) => x !== d));
                      setJustSaved(false);
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex max-w-md gap-1.5">
            <input
              className={inputClass}
              // i18n-ignore: example domain name
              placeholder="partner-agency.com"
              aria-label={gt("Domain to allow")}
              value={draft}
              disabled={domains.length >= ALERT_EMAIL_LIMITS.maxAllowedDomains}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDomain();
                }
              }}
            />
            <button
              type="button"
              className="shrink-0 rounded-lg border border-border px-2.5 text-xs text-on-surface-secondary hover:bg-surface-sunken disabled:opacity-50"
              disabled={!draft.trim()}
              onClick={addDomain}
            >
              {gt("Add")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void save()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? gt("Saving…") : gt("Save")}
        </button>
        {justSaved && !dirty ? (
          <span role="status" className="text-xs text-on-surface-faint">
            {gt("Saved.")}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-on-surface-faint max-w-2xl">
        {gt(
          "Tightening this never edits a recipient list: an address that no longer qualifies just stops receiving until it does again.",
        )}
      </p>

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-on-surface-secondary">{gt("Unsubscribed")}</h4>
        {view.suppressions.length === 0 ? (
          <p className="text-xs text-on-surface-faint">
            {gt("Nobody has unsubscribed from this organization's alert email.")}
          </p>
        ) : (
          <ul className="divide-y divide-border/50 rounded-lg border border-border">
            {view.suppressions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate text-sm text-on-surface">{s.email}</span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-on-surface-faint">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-info hover:text-info-strong"
                    onClick={() => void resume(s.id)}
                  >
                    {gt("Resume email")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-on-surface-faint max-w-2xl">
          {gt(
            "Only resume delivery to someone who asked for it: they unsubscribed with the link in one of your alerts.",
          )}
        </p>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
