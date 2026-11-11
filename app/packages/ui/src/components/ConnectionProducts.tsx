import { useState } from "react";
import { useGT } from "gt-react";
import {
  accountSyncsResources,
  normalizeProductIds,
  productsOfferedBy,
  productsOfferedForOrg,
  productsToSubmit,
  type PolicyTemplate,
  type PreflightDeclaration,
  type PreflightReport,
  type ProductId,
} from "@infrawrench/client-core";
import { formatErrorMessage } from "../utils.js";
import { useProductCopy } from "../products/copy.js";
import { ProductIcon } from "../products/ProductIcon.js";
import { CredentialPreflightPanel } from "./CredentialPreflightPanel.js";
import { Modal } from "./Modal.js";

/**
 * The apps a stored choice stands for, as the picker's checked set: `null`
 * (every app) is everything the plugin offers, and anything the plugin no
 * longer offers is dropped.
 */
export function selectedConnectionProducts(
  declaration: Pick<PreflightDeclaration, "capabilities"> | null | undefined,
  products: readonly string[] | null | undefined,
): ProductId[] {
  const offered = productsOfferedBy(declaration);
  if (!products) return offered;
  const chosen = normalizeProductIds(products);
  return offered.filter((id) => chosen.includes(id));
}

export interface ConnectionProductsPickerProps {
  /** The plugin's preflight declaration; the offer is read from it. */
  declaration: Pick<PreflightDeclaration, "capabilities">;
  /** The checked apps. */
  value: readonly ProductId[];
  onChange: (next: ProductId[]) => void;
  disabled?: boolean | undefined;
  /** Apps the organization turned off: they are not offered. */
  disabledProducts?: readonly ProductId[] | undefined;
}

/**
 * "Use this connection for": one checkbox per app the plugin's capabilities
 * power. The last checked app cannot be unchecked, since a connection for
 * nothing is not a connection. Renders nothing when the plugin offers no
 * choice (callers check `offersProductChoice` to decide whether to keep a
 * selection at all).
 */
export function ConnectionProductsPicker({
  declaration,
  value,
  onChange,
  disabled,
  disabledProducts,
}: ConnectionProductsPickerProps) {
  const gt = useGT();
  const copy = useProductCopy();
  const offered = productsOfferedForOrg(declaration, disabledProducts);
  if (offered.length <= 1) return null;
  const checked = new Set(value);
  return (
    <fieldset>
      <legend className="block text-xs text-on-surface-tertiary mb-1">
        {gt("Use this connection for")}
      </legend>
      <p className="text-xs text-on-surface-faint mb-2">
        {gt(
          "Only the apps you pick collect data from this account, and the credential only needs their permissions.",
        )}
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {offered.map((id) => {
          const isChecked = checked.has(id);
          const isLast = isChecked && checked.size === 1;
          return (
            <label
              key={id}
              className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm transition-colors ${
                isChecked
                  ? "border-border-strong bg-surface-overlay text-on-surface-secondary"
                  : "border-border text-on-surface-tertiary"
              }`}
            >
              <input
                type="checkbox"
                checked={isChecked}
                disabled={disabled || isLast}
                onChange={(e) =>
                  onChange(
                    // Rebuilt from the offer so the order is always canonical.
                    offered.filter((other) =>
                      other === id ? e.target.checked : checked.has(other),
                    ),
                  )
                }
              />
              <ProductIcon product={id} size={20} />
              <span className="min-w-0 truncate">{copy[id].name}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface ConnectionProductsNoticeProps {
  /** The account's stored choice; `null` or absent is every app. */
  products: readonly string[] | null | undefined;
  /** Opens the editor. Omit where the choice cannot be changed. */
  onChange?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * What an account page shows in place of its resource list when the
 * connection is for Costs alone: nothing is synced by design, so an empty
 * list would read as a failed sync. Renders nothing for any other account.
 */
export function ConnectionProductsNotice({
  products,
  onChange,
  className,
}: ConnectionProductsNoticeProps) {
  const gt = useGT();
  if (accountSyncsResources(products)) return null;
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border border-border-strong bg-surface-overlay/50 p-4 ${className ?? ""}`}
    >
      <ProductIcon product="costs" size={28} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-on-surface-secondary">
          {gt("Connected for Costs only")}
        </p>
        <p className="mt-0.5 text-xs text-on-surface-faint">
          {gt(
            "This connection collects cost data and does not list resources, so there is no inventory here. Its spend shows in Costs.",
          )}
        </p>
      </div>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          className="shrink-0 px-3 py-1.5 text-xs font-medium border border-border-strong rounded-lg text-on-surface-secondary hover:bg-surface-overlay transition-colors"
        >
          {gt("Change apps")}
        </button>
      )}
    </div>
  );
}

export interface ConnectionProductsModalProps {
  accountName: string;
  declaration: PreflightDeclaration;
  /** The account's stored choice; `null` or absent is every app. */
  products: readonly string[] | null | undefined;
  /** Saves the choice: a list, or `null` for every app the plugin offers. */
  onSave: (products: ProductId[] | null) => Promise<void>;
  onClose: () => void;
  /** Probes the stored credentials, to see what the new choice still needs. */
  runPreflight?: (() => Promise<PreflightReport>) | undefined;
  fetchPolicyTemplate?: ((capabilityIds: string[]) => Promise<PolicyTemplate>) | undefined;
  onOpenExternal?: ((url: string) => void) | undefined;
}

/**
 * Change the apps an existing connection is for. The checklist and the
 * policy template below the picker follow the selection, so the user can see
 * (and copy) what the credential must allow before saving an app it was not
 * created for.
 */
export function ConnectionProductsModal({
  accountName,
  declaration,
  products,
  onSave,
  onClose,
  runPreflight,
  fetchPolicyTemplate,
  onOpenExternal,
}: ConnectionProductsModalProps) {
  const gt = useGT();
  const [selected, setSelected] = useState<ProductId[]>(() =>
    selectedConnectionProducts(declaration, products),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(productsToSubmit(declaration, selected));
      onClose();
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Apps for {name}", { name: accountName })}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl flex flex-col max-h-[calc(100dvh-4rem)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {gt("Apps for {name}", { name: accountName })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg leading-none"
            aria-label={gt("Close")}
          >
            &#215;
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto min-h-0">
          <ConnectionProductsPicker
            declaration={declaration}
            value={selected}
            onChange={setSelected}
            disabled={saving}
          />
          <p className="text-xs text-on-surface-faint">
            {gt(
              "Adding an app starts collecting for it right away. Check that the credential has its permissions first.",
            )}
          </p>
          <CredentialPreflightPanel
            declaration={declaration}
            products={selected}
            runPreflight={runPreflight}
            fetchPolicyTemplate={fetchPolicyTemplate}
            onOpenExternal={onOpenExternal}
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary border border-border-strong rounded-lg transition-colors"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || selected.length === 0}
              className="flex-1 px-3 py-2 text-sm font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-on-accent rounded-lg transition-colors"
            >
              {saving ? gt("Saving...") : gt("Save")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
