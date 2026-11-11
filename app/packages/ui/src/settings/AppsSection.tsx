import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  ALWAYS_ON_PRODUCTS,
  accountsLackingProduct,
  normalizeDisabledProducts,
  productsOfferedBy,
  type ProductId,
} from "@infrawrench/client-core";
import type { PreflightDeclaration } from "@infrawrench/plugin-base";
import { ProductIcon } from "../products/ProductIcon.js";
import { useProductCopy } from "../products/copy.js";
import { notifyProductPolicyChanged } from "../products/policy.js";
import { PRODUCTS } from "../products/registry.js";
import { useSettingsHost } from "./host.js";

interface ProductPolicy {
  disabled: string[];
}

/** What the warning under an app needs of an account and of a plugin. */
interface ConnectionRow {
  id: string;
  pluginId: string;
  products?: readonly string[] | null;
}
interface PluginRow {
  id: string;
  preflight?: PreflightDeclaration | null;
}

/**
 * Apps: which apps the organization uses. Turning one off removes it from
 * Home, the sidebar and spotlight for everyone, and takes its tools
 * away from chat and MCP. Each switch saves on its own; there is nothing to
 * lose by leaving the page.
 *
 * Every member can see the page (the navigation they get depends on it);
 * the switches need `org:apps:write`, which owners and admins hold.
 * Infrastructure cannot be turned off, so it is not listed: a switch that
 * never moves is noise.
 */
export function AppsSection() {
  const gt = useGT();
  const copy = useProductCopy();
  const { orgId, api, has } = useSettingsHost();
  const canEdit = has("org:apps:write");

  const [disabled, setDisabled] = useState<ProductId[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<ProductId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const policy = await api.get<ProductPolicy>(`/api/org/${orgId}/products`);
      setDisabled(normalizeDisabledProducts(policy.disabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load the app settings"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  // The connections and what each plugin can serve, for the warning under an
  // app that is on but that some connections were made without. Best effort:
  // someone who cannot read accounts simply sees no warning.
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [offeredByPlugin, setOfferedByPlugin] = useState<Record<string, ProductId[]>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.get<ConnectionRow[]>(`/api/org/${orgId}/accounts`),
      api.get<PluginRow[]>(`/api/org/${orgId}/accounts/plugins`),
    ])
      .then(([accounts, plugins]) => {
        if (cancelled) return;
        setConnections(accounts);
        setOfferedByPlugin(
          Object.fromEntries(plugins.map((p) => [p.id, productsOfferedBy(p.preflight)])),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  async function setEnabled(product: ProductId, enabled: boolean) {
    const next = enabled ? disabled.filter((id) => id !== product) : [...disabled, product];
    setSaving(product);
    setError(null);
    try {
      const saved = await api.put<ProductPolicy>(`/api/org/${orgId}/products`, {
        disabled: next,
      });
      const stored = normalizeDisabledProducts(saved.disabled);
      setDisabled(stored);
      // The sidebar and Home in this window follow without a reload.
      notifyProductPolicyChanged(stored);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the app settings"));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Apps")}</h1>
        <p className="mt-1 text-sm text-on-surface-muted">
          {gt(
            "An app that is off is hidden for everyone, and chat and MCP cannot use its tools. Its data is kept.",
          )}
        </p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <>
          {!canEdit && (
            <p className="mb-4 text-xs text-on-surface-muted">
              {gt("Only owners and admins can change which apps are on.")}
            </p>
          )}
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface-raised/50">
            {PRODUCTS.filter((product) => !ALWAYS_ON_PRODUCTS.includes(product.id)).map(
              (product) => {
                const text = copy[product.id];
                const on = !disabled.includes(product.id);
                // Connections made before the app was on (or scoped away from
                // it) cannot feed it until they are given its permissions.
                const lacking = on
                  ? accountsLackingProduct(connections, offeredByPlugin, product.id).length
                  : 0;
                return (
                  <li key={product.id} className="flex items-center gap-3 px-4 py-3">
                    <ProductIcon product={product.id} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-on-surface">{text.name}</span>
                      <span className="mt-0.5 block text-xs text-on-surface-muted">
                        {text.tagline}
                      </span>
                      {lacking > 0 && (
                        <span className="mt-1 block text-xs text-warning">
                          {lacking === 1
                            ? gt(
                                "1 connection lacks permissions for this app. Open it and choose Change apps.",
                              )
                            : gt(
                                "{count} connections lack permissions for this app. Open each and choose Change apps.",
                                { count: lacking },
                              )}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={text.name}
                      disabled={!canEdit || saving !== null}
                      onClick={() => void setEnabled(product.id, !on)}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        on ? "bg-accent" : "bg-surface-sunken border border-border-strong"
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
                          on ? "translate-x-4 bg-on-accent" : "translate-x-1 bg-on-surface-muted"
                        }`}
                      />
                    </button>
                  </li>
                );
              },
            )}
          </ul>
        </>
      )}
    </div>
  );
}
