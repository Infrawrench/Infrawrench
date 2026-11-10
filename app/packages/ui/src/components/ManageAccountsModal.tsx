import { useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import { Modal } from "./Modal.js";

export interface ManagedAccountGroup {
  pluginId: string;
  /** The provider's name, from its plugin manifest. */
  displayName: string;
  logoSvg: string;
  accounts: ReadonlyArray<{ id: string; displayName: string }>;
}

export interface ManageAccountsModalProps {
  groups: readonly ManagedAccountGroup[];
  /** Opens an account's page; the modal closes itself first. */
  onOpenAccount: (accountId: string, displayName: string) => void;
  /** Starts the connect flow; the modal closes itself first. */
  onAddAccount: () => void;
  onClose: () => void;
}

/**
 * Every connected account, by provider, with the way to connect another.
 * The sidebar's accounts tree only shows in Infrastructure's context, so this
 * is the place that reaches an account from anywhere.
 */
export function ManageAccountsModal({
  groups,
  onOpenAccount,
  onAddAccount,
  onClose,
}: ManageAccountsModalProps) {
  const gt = useGT();
  const gtData = useDataString();
  const withAccounts = groups.filter((group) => group.accounts.length > 0);

  return (
    <Modal onClose={onClose} ariaLabel={gt("Manage accounts")} className="w-[480px] max-w-[92vw]">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">{gt("Manage accounts")}</h2>
        <button
          type="button"
          onClick={() => {
            onClose();
            onAddAccount();
          }}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover transition-colors"
        >
          {gt("Add account")}
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-2 py-3">
        {withAccounts.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-on-surface-muted">
            {gt("No accounts connected yet.")}
          </p>
        )}
        {withAccounts.map((group) => (
          <div key={group.pluginId} className="mb-3 last:mb-0">
            <div className="flex items-center gap-2 px-3 py-1">
              <div
                className="size-4 flex-shrink-0"
                dangerouslySetInnerHTML={{ __html: group.logoSvg }}
                aria-hidden="true"
              />
              <span className="text-xs font-medium uppercase tracking-wide text-on-surface-muted">
                {gtData(group.displayName)}
              </span>
            </div>
            {group.accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => {
                  onClose();
                  onOpenAccount(account.id, account.displayName);
                }}
                className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-on-surface-secondary hover:bg-surface-overlay hover:text-on-surface transition-colors"
              >
                <span className="truncate">{account.displayName}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
