import { buttonClass } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Picker } from "../../components/Picker";
import type { TerraformAccount } from "../../lib/models";
import { useSession } from "../../lib/session";

export const accountLabel = (account: TerraformAccount): string =>
  `${account.name} (${account.pluginName})`;

/**
 * The Infrawrench accounts a workspace's runs get credentials for, picked by
 * name. The API has no list of the organisation's accounts yet, so the picker
 * offers the ones the repository's workspaces already use; any other is
 * connected in the app.
 */
export function AccountsPicker({
  available,
  selected,
  onChange,
  disabled = false,
}: {
  available: ReadonlyArray<TerraformAccount>;
  selected: ReadonlyArray<string>;
  onChange: (accountIds: string[]) => void;
  disabled?: boolean;
}) {
  const session = useSession();
  const appUrl = session.data?.appUrl;
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
        emptyText="No accounts to choose from"
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
