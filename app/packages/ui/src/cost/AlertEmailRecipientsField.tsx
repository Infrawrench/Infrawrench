import { useEffect, useId, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  ALERT_EMAIL_LIMITS,
  isAlertEmailAddressAllowed,
  normalizeAlertEmailAddress,
  type AlertEmailOptions,
  type AlertEmailRecipients,
} from "@infrawrench/client-core";
import { CloseIcon } from "../components/icons/ChromeIcons.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";

/**
 * Load the picker's options once per mount. Null while loading, and stays
 * null when the host has not wired a loader (the field then renders nothing:
 * offering a picker with no member list would only let somebody type an
 * address the server is about to reject).
 */
export function useAlertEmailOptions(load: (() => Promise<AlertEmailOptions>) | undefined): {
  options: AlertEmailOptions | null;
  error: string | null;
} {
  const [options, setOptions] = useState<AlertEmailOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    load()
      .then((o) => {
        if (!cancelled) setOptions(o);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // `load` is a host method; re-running on identity change would refetch on
    // every parent render for hosts that build it inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { options, error };
}

export interface AlertEmailRecipientsFieldProps {
  value: AlertEmailRecipients;
  onChange: (next: AlertEmailRecipients) => void;
  options: AlertEmailOptions | null;
  /** Error from loading the options, shown in place of the picker. */
  loadError?: string | null;
  disabled?: boolean;
  /** One line under the label saying when these people are emailed. */
  description?: string;
}

/**
 * Who an alert emails: org members picked from a list, plus extra addresses
 * checked against the org's external-address policy before the form is saved.
 *
 * Shared by every editor that carries `emailRecipients` (budgets, change
 * alerts, anomaly and efficiency tuning). The server repeats every check;
 * this exists so a typo or a blocked domain fails in the form, not on save.
 */
export function AlertEmailRecipientsField({
  value,
  onChange,
  options,
  loadError,
  disabled,
  description,
}: AlertEmailRecipientsFieldProps) {
  const gt = useGT();
  const uid = useId();
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  if (loadError) {
    return (
      <p className="text-xs text-danger">
        {gt("Couldn't load email recipients: {error}", { error: loadError })}
      </p>
    );
  }
  if (!options) {
    return <p className="text-xs text-on-surface-faint">{gt("Loading email recipients…")}</p>;
  }

  const memberById = new Map(options.members.map((m) => [m.userId, m]));
  const available = options.members.filter((m) => !value.userIds.includes(m.userId));
  const atMemberLimit = value.userIds.length >= ALERT_EMAIL_LIMITS.maxMembers;
  const atAddressLimit = value.addresses.length >= ALERT_EMAIL_LIMITS.maxAddresses;
  const allowedDomains = [
    ...new Set([...options.memberDomains, ...options.settings.allowedDomains]),
  ];

  const addAddress = () => {
    const address = normalizeAlertEmailAddress(draft);
    if (!address) {
      setDraftError(gt("That doesn't look like an email address."));
      return;
    }
    if (!isAlertEmailAddressAllowed(address, options.settings, options.memberDomains)) {
      setDraftError(
        gt(
          "This organization only allows alert email to its own domains. An admin can allow another domain in Settings → Notifications → Email.",
        ),
      );
      return;
    }
    const member = options.members.find((m) => m.email === address);
    if (member) {
      // A member's own address is better stored as the member: it then
      // follows them through an email change and stops when they leave.
      if (!value.userIds.includes(member.userId)) {
        onChange({ ...value, userIds: [...value.userIds, member.userId] });
      }
    } else if (!value.addresses.includes(address)) {
      onChange({ ...value, addresses: [...value.addresses, address] });
    }
    setDraft("");
    setDraftError(null);
  };

  const chipClass =
    "inline-flex items-center gap-1 rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs text-on-surface";

  return (
    <div className="space-y-2">
      <div>
        <span className="block text-xs font-medium text-on-surface-secondary">
          {gt("Email recipients")}
        </span>
        {description ? <p className="text-xs text-on-surface-faint mt-0.5">{description}</p> : null}
        {!options.emailAvailable ? (
          <p className="text-xs text-warning mt-1">
            {gt(
              "Email isn't configured on this deployment, so recipients are saved but nothing is sent yet.",
            )}
          </p>
        ) : null}
      </div>

      {value.userIds.length + value.addresses.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={gt("Email recipients")}>
          {value.userIds.map((id) => {
            const member = memberById.get(id);
            return (
              <li key={`m:${id}`} className={chipClass}>
                {member ? (
                  <span title={member.email}>{member.name || member.email}</span>
                ) : (
                  <span className="text-danger">{gt("Former member")}</span>
                )}
                {!disabled ? (
                  <button
                    type="button"
                    aria-label={gt("Remove {name}", {
                      name: member ? member.name || member.email : gt("former member"),
                    })}
                    className="text-on-surface-faint hover:text-on-surface"
                    onClick={() =>
                      onChange({ ...value, userIds: value.userIds.filter((u) => u !== id) })
                    }
                  >
                    <CloseIcon size={12} />
                  </button>
                ) : null}
              </li>
            );
          })}
          {value.addresses.map((address) => {
            const blocked = !isAlertEmailAddressAllowed(
              address,
              options.settings,
              options.memberDomains,
            );
            return (
              <li key={`a:${address}`} className={chipClass}>
                <span
                  className={blocked ? "text-danger line-through" : undefined}
                  title={
                    blocked
                      ? gt("Outside the domains this organization allows; nothing is sent here.")
                      : undefined
                  }
                >
                  {address}
                </span>
                {!disabled ? (
                  <button
                    type="button"
                    aria-label={gt("Remove {name}", { name: address })}
                    className="text-on-surface-faint hover:text-on-surface"
                    onClick={() =>
                      onChange({
                        ...value,
                        addresses: value.addresses.filter((a) => a !== address),
                      })
                    }
                  >
                    <CloseIcon size={12} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-on-surface-faint">{gt("Nobody is emailed.")}</p>
      )}

      {!disabled ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            aria-label={gt("Add a member")}
            className={inputClass}
            value=""
            disabled={available.length === 0 || atMemberLimit}
            onChange={(e) => {
              if (!e.target.value) return;
              onChange({ ...value, userIds: [...value.userIds, e.target.value] });
            }}
          >
            <option value="">
              {available.length === 0 ? gt("Every member is added") : gt("Add a member…")}
            </option>
            {available.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name ? `${m.name} (${m.email})` : m.email}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <input
              id={`${uid}-address`}
              type="email"
              className={inputClass}
              placeholder={gt("Another address")}
              aria-label={gt("Add an email address")}
              value={draft}
              disabled={atAddressLimit}
              onChange={(e) => {
                setDraft(e.target.value);
                setDraftError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addAddress();
                }
              }}
            />
            <button
              type="button"
              className="shrink-0 rounded-lg border border-border px-2.5 text-xs text-on-surface-secondary hover:bg-surface-hover disabled:opacity-50"
              disabled={!draft.trim() || atAddressLimit}
              onClick={addAddress}
            >
              {gt("Add")}
            </button>
          </div>
        </div>
      ) : null}
      {draftError ? <p className="text-xs text-danger">{draftError}</p> : null}
      {options.settings.externalPolicy === "member-domains" &&
      !disabled &&
      allowedDomains.length > 0 ? (
        <T>
          <p className="text-xs text-on-surface-faint">
            Extra addresses must be on <Var>{allowedDomains.join(", ")}</Var>.
          </p>
        </T>
      ) : null}
    </div>
  );
}

/**
 * {@link AlertEmailRecipientsField} with its own options load, for editors
 * that have a host method rather than already-loaded options.
 */
export function LoadedAlertEmailRecipientsField({
  load,
  ...rest
}: Omit<AlertEmailRecipientsFieldProps, "options" | "loadError"> & {
  load: () => Promise<AlertEmailOptions>;
}) {
  const { options, error } = useAlertEmailOptions(load);
  return <AlertEmailRecipientsField {...rest} options={options} loadError={error} />;
}
