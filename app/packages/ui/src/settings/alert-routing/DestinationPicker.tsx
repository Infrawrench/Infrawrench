import { useGT } from "gt-react";
import { type AlertDestination, type AlertRulesResponse } from "@infrawrench/client-core";

/* -------------------------------------------------------------------------- */
/* Destinations                                                               */
/* -------------------------------------------------------------------------- */

export interface DestinationCatalog {
  slackChannels: AlertRulesResponse["slackChannels"];
  msTeamsWebhooks: AlertRulesResponse["msTeamsWebhooks"];
  /** On-call rotations, so an `on-call` destination renders by name. */
  onCallSchedules: Array<{ id: string; name: string }>;
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
  }
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
  const has = (d: AlertDestination): boolean => value.some((v) => sameDestination(v, d));

  function toggle(d: AlertDestination, on: boolean): void {
    onChange(on ? [...value, d] : value.filter((v) => !sameDestination(v, d)));
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

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-on-surface-tertiary">
        {options.map((d) => (
          <label key={destKey(d)} className="flex items-center gap-1.5 whitespace-nowrap">
            <input type="checkbox" checked={has(d)} onChange={(e) => toggle(d, e.target.checked)} />
            <span>{destinationLabel(d, catalog, gt)}</span>
          </label>
        ))}
      </div>
      {noChannels ? <p className="text-xs text-on-surface-faint">{emptyLabel}</p> : null}
    </div>
  );
}

function destKey(d: AlertDestination): string {
  switch (d.kind) {
    case "push":
      return "push";
    case "slack":
      return `slack:${d.channelId}`;
    case "msteams":
      return `teams:${d.webhookId}`;
    case "on-call":
      return `on-call:${d.scheduleId}`;
    case "github-issues":
      return "github-issues";
  }
}

function sameDestination(a: AlertDestination, b: AlertDestination): boolean {
  return destKey(a) === destKey(b);
}
