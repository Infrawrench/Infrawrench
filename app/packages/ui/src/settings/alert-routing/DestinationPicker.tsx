import { useGT } from "gt-react";
import {
  destinationKey,
  type AlertDestination,
  type AlertEmailOptions,
  type AlertEmailRecipients,
  type AlertRulesResponse,
} from "@infrawrench/client-core";
import { AlertEmailRecipientsField } from "../../cost/AlertEmailRecipientsField.js";

/* -------------------------------------------------------------------------- */
/* Destinations                                                               */
/* -------------------------------------------------------------------------- */

export interface DestinationCatalog {
  slackChannels: AlertRulesResponse["slackChannels"];
  msTeamsWebhooks: AlertRulesResponse["msTeamsWebhooks"];
  /** On-call rotations, so an `on-call` destination renders by name. */
  onCallSchedules: Array<{ id: string; name: string }>;
  /**
   * Members and the external-address policy, for the email destinations.
   * Optional so a host (or a test) that predates email still renders the
   * channel checkboxes; without them the email picker is simply absent.
   */
  members?: AlertRulesResponse["members"];
  emailAvailable?: boolean;
  emailSettings?: AlertRulesResponse["emailSettings"];
  memberDomains?: string[];
}

function destinationLabel(
  d: AlertDestination,
  catalog: DestinationCatalog,
  gt: ReturnType<typeof useGT>,
): string {
  switch (d.kind) {
    case "push":
      return gt("Mobile push");
    case "slack": {
      const ch = catalog.slackChannels.find((c) => c.id === d.channelId);
      return ch ? gt("#{name}", { name: ch.name }) : gt("#(removed channel)");
    }
    case "msteams": {
      const hook = catalog.msTeamsWebhooks.find((w) => w.id === d.webhookId);
      return hook ? hook.label : gt("(removed Teams channel)");
    }
    case "on-call": {
      const schedule = catalog.onCallSchedules.find((sched) => sched.id === d.scheduleId);
      // Named rather than "on call": an org with a primary and a secondary
      // rotation needs to see which one a rule points at.
      return schedule ? gt("On call: {name}", { name: schedule.name }) : gt("(removed rotation)");
    }
    case "github-issues":
      return gt("GitHub issues (one per finding)");
    case "email-member": {
      const member = catalog.members?.find((m) => m.userId === d.userId);
      return member ? member.name || member.email : gt("(former member)");
    }
    case "email-address":
      return d.address;
  }
}

/** A rule's email destinations as the recipient field's shape. */
function emailRecipientsOf(value: AlertDestination[]): AlertEmailRecipients {
  return {
    userIds: value.flatMap((d) => (d.kind === "email-member" ? [d.userId] : [])),
    addresses: value.flatMap((d) => (d.kind === "email-address" ? [d.address] : [])),
  };
}

function emailOptionsOf(catalog: DestinationCatalog): AlertEmailOptions | null {
  if (!catalog.members || !catalog.emailSettings) return null;
  return {
    members: catalog.members,
    emailAvailable: catalog.emailAvailable ?? false,
    settings: catalog.emailSettings,
    memberDomains: catalog.memberDomains ?? [],
  };
}

export function DestinationPicker({
  value,
  catalog,
  onChange,
  emptyLabel,
}: {
  value: AlertDestination[];
  catalog: DestinationCatalog;
  onChange: (next: AlertDestination[]) => void;
  emptyLabel: string;
}) {
  const gt = useGT();
  const selected = new Set(value.map(destinationKey));
  const has = (d: AlertDestination): boolean => selected.has(destinationKey(d));

  function toggle(d: AlertDestination, on: boolean): void {
    const key = destinationKey(d);
    onChange(on ? [...value, d] : value.filter((v) => destinationKey(v) !== key));
  }

  /** Replace the email half of the list, keeping every channel destination in place. */
  function setEmail(next: AlertEmailRecipients): void {
    onChange([
      ...value.filter((d) => d.kind !== "email-member" && d.kind !== "email-address"),
      ...next.userIds.map((userId): AlertDestination => ({ kind: "email-member", userId })),
      ...next.addresses.map((address): AlertDestination => ({ kind: "email-address", address })),
    ]);
  }

  const options: AlertDestination[] = [
    { kind: "push" },
    ...catalog.slackChannels.map((c): AlertDestination => ({ kind: "slack", channelId: c.id })),
    ...catalog.msTeamsWebhooks.map((w): AlertDestination => ({ kind: "msteams", webhookId: w.id })),
    // Rotations come last: an org that has one usually wants it, but the
    // channels above are what most rules are built from, and reordering the
    // list would move every existing checkbox.
    ...catalog.onCallSchedules.map((sched): AlertDestination => ({
      kind: "on-call",
      scheduleId: sched.id,
    })),
    // Files the alert's finding as a GitHub issue in the repository Settings →
    // GitHub Issues routes it to. Only alerts that carry a finding (savings
    // findings, anomalies, idle commitments) are filed; others skip it.
    { kind: "github-issues" },
  ];

  // `push` is always an option, so the list is never empty and the checkboxes
  // are always rendered. An earlier version treated "only push" as the empty
  // state and hid every checkbox, which left an org that uses push alone unable
  // to build a working rule, and made an existing push destination invisible
  // and so unremovable. The hint is additional, not a replacement.
  const noChannels = catalog.slackChannels.length === 0 && catalog.msTeamsWebhooks.length === 0;
  const emailOptions = emailOptionsOf(catalog);
  const email = emailRecipientsOf(value);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-on-surface-tertiary">
        {options.map((d) => (
          <label key={destinationKey(d)} className="flex items-center gap-1.5 whitespace-nowrap">
            <input type="checkbox" checked={has(d)} onChange={(e) => toggle(d, e.target.checked)} />
            <span>{destinationLabel(d, catalog, gt)}</span>
          </label>
        ))}
      </div>
      {noChannels ? <p className="text-xs text-on-surface-faint">{emptyLabel}</p> : null}
      {emailOptions ? (
        <AlertEmailRecipientsField
          value={email}
          onChange={setEmail}
          options={emailOptions}
          description={gt(
            "An HTML and plain-text email with a link back to Infrawrench and an unsubscribe link. Email has no acknowledge button.",
          )}
        />
      ) : null}
    </div>
  );
}
