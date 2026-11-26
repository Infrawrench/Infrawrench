import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { buttonClass } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Picker } from "../../components/Picker";
import type { TerraformAccount } from "@infrawrench/git-contract";
import { useRepoRef } from "../../layout/RepoLayout";
import { useSession } from "../../lib/session";

export const accountLabel = (account: TerraformAccount): string =>
  `${account.name} (${account.pluginName})`;

/**
 * What the picker offers: the organisation's connected accounts as the API
 * lists them, then any the workspace already links that the list left out
 * (it is empty for someone without `accounts:read`), by name.
 */
export function offeredAccounts(
  listed: ReadonlyArray<TerraformAccount>,
  linked: ReadonlyArray<TerraformAccount>,
): TerraformAccount[] {
  const byId = new Map<string, TerraformAccount>();
  for (const account of [...listed, ...linked]) {
    if (!byId.has(account.accountId)) byId.set(account.accountId, account);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Infrawrench accounts a workspace's runs get credentials for, picked by
 * name from the organisation's connected accounts (`terraform.listAccounts`).
 * Connecting one happens in the app.
 */
export function AccountsPicker({
  linked = [],
  selected,
  onChange,
  disabled = false,
}: {
  /** The accounts the workspace links now, which stay on offer whatever the list answers. */
  linked?: ReadonlyArray<TerraformAccount>;
  selected: ReadonlyArray<string>;
  onChange: (accountIds: string[]) => void;
  disabled?: boolean;
}) {
  const repo = useRepoRef();
  const session = useSession();
  const appUrl = session.data?.appUrl;
  const listed = useQuery(queries.terraform.listAccounts({ params: repo }));
  const available = offeredAccounts(listed.data?.accounts ?? [], linked);
  const chosen = available.filter((account) => selected.includes(account.accountId));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Picker
        label="Accounts"
        multiple
        options={available.map((account) => ({
          value: account.accountId,
          label: account.name,
          detail: account.pluginName,
        }))}
        selected={selected}
        onChange={onChange}
        emptyText={listed.isLoading ? "Loading" : "No accounts to choose from"}
        footer={
          appUrl !== undefined ? (
            <a
              href={appUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-on-surface-secondary hover:underline"
            >
              Connect an account in Infrawrench
              <Icon name="externalLink" size={11} />
            </a>
          ) : undefined
        }
        trigger={({ props }) => (
          <button
            {...props}
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            className={buttonClass("secondary", "md")}
          >
            {chosen.length === 0
              ? "Choose accounts"
              : chosen.length === 1
                ? accountLabel(chosen[0]!)
                : `${chosen.length} accounts`}
            <Icon name="chevronDown" size={12} />
          </button>
        )}
      />
      {chosen.length > 1 ? (
        <span className="text-xs text-on-surface-muted">
          {chosen.map((account) => account.name).join(", ")}
        </span>
      ) : null}
    </div>
  );
}
