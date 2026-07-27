/**
 * Detail view for DigitalOcean Droplets — the largest renderer in the plugin,
 * covering the resize / rebuild / restore prompts, backup and snapshot pickers,
 * and the metrics + console tabs.
 */
import type {
  DetailViewSchema,
  ImageOption,
  ResourceInstance,
  SectionNode,
  SizeOption,
} from "@infrawrench/plugin-base";
import { parseJsonArray } from "./shared.js";

/**
 * Add power/lifecycle action buttons + custom tabs (Actions, Backups,
 * Snapshots, Attached Volumes) to a droplet's detail view. State-aware:
 * surfaces "Power On" when the droplet is off and "Power Off" / "Shutdown"
 * when it's running so users don't see no-op buttons.
 */
export function applyDropletDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  const isRunning = status === "active";
  const isOff = status === "off";
  const features = String(fields["features"] ?? "").split(",");
  // Backups: prefer `nextBackupStart` / `backupPolicyPlan` over the
  // `features` array — DO sets the policy and the next-window timestamps
  // synchronously with the enable_backups action, but flips the
  // `features` entry on a separate (sometimes-delayed) tick. Using only
  // `features` meant the Enable Backups button stuck around after a
  // successful enable until the lag resolved.
  const backupsEnabled =
    features.includes("backups") ||
    !!String(fields["nextBackupStart"] ?? "") ||
    !!String(fields["backupPolicyPlan"] ?? "");
  // IPv6 is a one-way flip on DO — once enabled, the only signal is the
  // feature flag (and a public-v6 entry in `networks.v6`, which we surface
  // as the `ipv6` resolved output). We hide the Enable IPv6 button once
  // either is set so it doesn't look like the previous click was ignored.
  const ipv6Enabled = features.includes("ipv6") || !!String(resource.resolvedOutputs["ipv6"] ?? "");

  // Catalog data populated by enrichDetail. Falls back to empty arrays so
  // the modal still renders if enrichment failed (the picker will show no
  // options rather than the whole detail page crashing).
  const enrichedSizes = parseJsonArray<SizeOption>(resource.resolvedOutputs["__sizes__"]);
  const enrichedImages = parseJsonArray<ImageOption>(resource.resolvedOutputs["__images__"]);
  const currentSizeSlug = String(fields["size"] ?? "");
  const sizeOptions = enrichedSizes.filter((s) => s.id !== currentSizeSlug);

  // Backup/snapshot picker options: prefer the rich, human-readable list
  // populated by enrichDetail (one /v2/droplets/{id}/backups +
  // /v2/droplets/{id}/snapshots round-trip each). Falls back to the raw
  // id strings already in fields when enrichment failed or hasn't run
  // yet, so the picker still works on a slow/offline first paint.
  type RestoreOption = { id: string; label: string; category?: string };
  const enrichedRestore = parseJsonArray<RestoreOption>(
    resource.resolvedOutputs["__restoreOptions__"],
  );
  const backupIds = String(fields["backupIds"] ?? "")
    .split(",")
    .filter(Boolean);
  const snapshotIds = String(fields["snapshotIds"] ?? "")
    .split(",")
    .filter(Boolean);
  const restoreOptions: RestoreOption[] =
    enrichedRestore.length > 0
      ? enrichedRestore
      : [
          ...backupIds.map((id) => ({ id, label: `Backup ${id}`, category: "Backups" })),
          ...snapshotIds.map((id) => ({ id, label: `Snapshot ${id}`, category: "Snapshots" })),
        ];

  // Header lifecycle controls \u2014 keep this list short so the bar doesn't wrap.
  const headerActions: DetailViewSchema["headerActions"] = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
  ];
  if (isOff) {
    headerActions.push({
      kind: "action",
      label: "Power On",
      action: { type: "plugin-action", actionId: "power_on", successMessage: "Power-on queued." },
    });
  }
  if (isRunning) {
    headerActions.push(
      {
        kind: "action",
        label: "Reboot",
        variant: "ghost",
        action: {
          type: "plugin-action",
          actionId: "reboot",
          confirmMessage: "Reboot this droplet? The OS will be sent a soft reboot signal.",
          successMessage: "Reboot queued.",
        },
      },
      {
        kind: "action",
        label: "Shutdown",
        variant: "ghost",
        action: {
          type: "plugin-action",
          actionId: "shutdown",
          confirmMessage: "Cleanly shut down this droplet?",
          successMessage: "Shutdown queued.",
        },
      },
    );
  }
  headerActions.push({
    kind: "action",
    label: "Take Snapshot",
    variant: "ghost",
    action: {
      type: "plugin-action",
      actionId: "snapshot",
      confirmMessage:
        "Take a snapshot of this droplet now? Snapshots are auto-named with a timestamp and billed at the snapshot storage rate.",
      successMessage: "Snapshot queued.",
    },
  });
  detail.headerActions = headerActions;

  const lifecycleSections: SectionNode[] = [
    {
      kind: "section",
      title: "Power",
      children: [
        {
          kind: "grid",
          columns: 2,
          items: [
            {
              kind: "action",
              label: "Power Cycle (hard restart)",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "power_cycle",
                confirmMessage:
                  "Power-cycle this droplet? Equivalent to pulling the plug \u2014 running processes will not flush state.",
                successMessage: "Power-cycle queued.",
              },
            },
            {
              kind: "action",
              label: "Power Off (hard)",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "power_off",
                confirmMessage: "Force this droplet off without a clean OS shutdown?",
                successMessage: "Power-off queued.",
              },
            },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Snapshot & Image",
      children: [
        {
          kind: "grid",
          columns: 2,
          items: [
            {
              kind: "action",
              label: "Take Named Snapshot\u2026",
              action: {
                type: "prompt-nosql-command",
                command: "snapshot-named",
                title: "Take a snapshot",
                description:
                  "Snapshots are billed at the snapshot storage rate while they exist. DigitalOcean recommends powering the droplet off first for a consistent snapshot.",
                fields: [
                  {
                    key: "name",
                    label: "Snapshot Name",
                    kind: "text",
                    required: true,
                    defaultValue: `${String(fields["name"] ?? "droplet")}-${new Date().toISOString().slice(0, 10)}`,
                  },
                ],
                submitLabel: "Take Snapshot",
              },
            },
            {
              kind: "action",
              label: "Rebuild from Image\u2026",
              variant: "danger",
              action: {
                type: "prompt-nosql-command",
                command: "rebuild",
                title: "Rebuild droplet",
                description:
                  "DESTRUCTIVE \u2014 rebuilds the droplet from an image. All data on the boot disk will be erased. The IP address is preserved.",
                fields: [
                  {
                    key: "image",
                    label: "Image",
                    kind: "image-picker",
                    required: true,
                    images: enrichedImages,
                  },
                ],
                submitLabel: "Rebuild",
                danger: true,
              },
            },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Configuration",
      children: [
        {
          kind: "grid",
          columns: 2,
          items: [
            {
              kind: "action",
              label: "Rename\u2026",
              action: {
                type: "prompt-nosql-command",
                command: "rename",
                title: "Rename droplet",
                fields: [
                  {
                    key: "name",
                    label: "New Name",
                    kind: "text",
                    required: true,
                    defaultValue: String(fields["name"] ?? ""),
                  },
                ],
                submitLabel: "Rename",
              },
            },
            {
              kind: "action",
              label: "Resize\u2026",
              variant: "danger",
              action: {
                type: "prompt-nosql-command",
                command: "resize",
                title: "Resize droplet",
                description: `Current size: ${currentSizeSlug || "unknown"}. DigitalOcean powers the droplet down before resizing. Disk resizes are permanent (cannot scale down) \u2014 CPU/RAM-only resizes are reversible.`,
                fields: [
                  {
                    key: "size",
                    label: "New Size",
                    kind: "size-picker",
                    required: true,
                    sizes: sizeOptions,
                  },
                  {
                    key: "disk",
                    label: "Resize Disk Too?",
                    kind: "select",
                    required: true,
                    defaultValue: "false",
                    options: [
                      { id: "false", label: "No (CPU/RAM only \u2014 reversible)" },
                      { id: "true", label: "Yes (permanent \u2014 cannot scale down later)" },
                    ],
                  },
                ],
                submitLabel: "Resize",
                danger: true,
              },
            },
            ...(ipv6Enabled
              ? []
              : [
                  {
                    kind: "action" as const,
                    label: "Enable IPv6",
                    action: {
                      type: "plugin-action" as const,
                      actionId: "enable_ipv6",
                      confirmMessage: "Enable IPv6 networking on this droplet?",
                      successMessage: "IPv6 enabled.",
                    },
                  },
                ]),
            {
              kind: "action",
              label: "Reset Root Password",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "password_reset",
                confirmMessage:
                  "Reset the root password? DigitalOcean will email the new password to the account owner.",
                successMessage: "Password reset queued \u2014 check your DO account email.",
              },
            },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Backups",
      children: [
        {
          kind: "grid",
          columns: 2,
          items: [
            backupsEnabled
              ? {
                  kind: "action",
                  label: "Disable Backups",
                  variant: "danger",
                  action: {
                    type: "plugin-action",
                    actionId: "disable_backups",
                    confirmMessage:
                      "Disable automatic backups? Existing backup images will be retained for the standard retention period.",
                    successMessage: "Backups disabled.",
                  },
                }
              : {
                  kind: "action",
                  label: "Enable Backups",
                  action: {
                    type: "plugin-action",
                    actionId: "enable_backups",
                    confirmMessage:
                      "Enable automatic backups? Adds ~20% to the droplet's hourly cost. Default schedule is weekly.",
                    successMessage: "Backups enabled.",
                  },
                },
            {
              kind: "action",
              label: "Change Backup Policy\u2026",
              action: {
                type: "prompt-nosql-command",
                command: "change-backup-policy",
                title: "Change backup policy",
                description:
                  "Daily backups have a 4-hour window; weekly backups also pick a weekday.",
                fields: [
                  {
                    key: "plan",
                    label: "Plan",
                    kind: "select",
                    required: true,
                    defaultValue: "weekly",
                    options: [
                      { id: "daily", label: "Daily" },
                      { id: "weekly", label: "Weekly" },
                    ],
                  },
                  {
                    key: "hour",
                    label: "Hour (UTC)",
                    kind: "select",
                    required: true,
                    defaultValue: "4",
                    options: [
                      { id: "0", label: "00:00" },
                      { id: "4", label: "04:00" },
                      { id: "8", label: "08:00" },
                      { id: "12", label: "12:00" },
                      { id: "16", label: "16:00" },
                      { id: "20", label: "20:00" },
                    ],
                  },
                  {
                    key: "weekday",
                    label: "Weekday",
                    kind: "select",
                    required: false,
                    defaultValue: "SUN",
                    options: [
                      { id: "SUN", label: "Sunday" },
                      { id: "MON", label: "Monday" },
                      { id: "TUE", label: "Tuesday" },
                      { id: "WED", label: "Wednesday" },
                      { id: "THU", label: "Thursday" },
                      { id: "FRI", label: "Friday" },
                      { id: "SAT", label: "Saturday" },
                    ],
                    showWhen: { fieldKey: "plan", fieldValue: "weekly" },
                  },
                ],
                submitLabel: "Save Policy",
              },
            },
            ...(restoreOptions.length > 0
              ? [
                  {
                    kind: "action" as const,
                    label: "Restore from Backup\u2026",
                    variant: "danger" as const,
                    action: {
                      type: "prompt-nosql-command" as const,
                      command: "restore",
                      title: "Restore from backup or snapshot",
                      description:
                        "DESTRUCTIVE \u2014 replaces the boot disk with the chosen image. The droplet is powered down during the restore.",
                      fields: [
                        {
                          key: "image",
                          label: "Backup or Snapshot",
                          kind: "select" as const,
                          required: true,
                          options: restoreOptions.map((r) => ({ id: r.id, label: r.label })),
                          description: `${
                            restoreOptions.filter((r) => r.category === "Backups").length
                          } backup(s) and ${
                            restoreOptions.filter((r) => r.category === "Snapshots").length
                          } snapshot(s) available. Newest first.`,
                        },
                      ],
                      submitLabel: "Restore",
                      danger: true,
                    },
                  },
                ]
              : [
                  // No restore points exist yet \u2014 surface the why and the
                  // next step inline rather than a dead-end modal.
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content: backupsEnabled
                      ? "No restore points yet \u2014 backups are enabled but the first one runs within ~24 hours of enabling. Use Take Named Snapshot above for an immediate restore point."
                      : "No restore points yet \u2014 enable backups below, or use Take Named Snapshot above to create one now.",
                  },
                ]),
          ],
        },
      ],
    },
  ];

  // Backups/Snapshots/Volumes render as key-value rows with restore/detach
  // actions inline. backupIds/snapshotIds were collected above for the
  // restore picker.
  const volumeIds = String(fields["volumeIds"] ?? "")
    .split(",")
    .filter(Boolean);

  const customTabs: DetailViewSchema["customTabs"] = [
    { id: "actions", label: "Actions", sections: lifecycleSections },
  ];

  // The restore-picker option labels are already formatted as
  // "[Backup] {name} \u2014 {date} \u2014 {size GB}" / "[Snapshot] {name} \u2014 \u2026".
  // Strip the leading "[Kind] " prefix for the pill label since the kind
  // is implied by the containing tab.
  const stripKindPrefix = (label: string): string => label.replace(/^\[[^\]]+\]\s*/, "");
  const backupPillOptions = restoreOptions.filter((r) => r.category === "Backups");
  const snapshotPillOptions = restoreOptions.filter((r) => r.category === "Snapshots");

  if (backupIds.length > 0) {
    const accountId = resource.accountId;
    // Backups aren't first-class resources (no detail page), so the pill
    // can't navigate. Pre-fill the Restore prompt with this backup id so
    // a click is one decision step instead of "open Restore \u2192 find this
    // id in the dropdown".
    const pills =
      backupPillOptions.length > 0
        ? backupPillOptions.map((b) => ({
            kind: "action" as const,
            label: stripKindPrefix(b.label),
            action: {
              type: "prompt-nosql-command" as const,
              command: "restore",
              title: "Restore from this backup",
              description:
                "DESTRUCTIVE \u2014 replaces the boot disk with this backup image. The droplet is powered down during the restore.",
              fields: [
                {
                  key: "image",
                  label: "Backup",
                  kind: "select" as const,
                  required: true,
                  options: [{ id: b.id, label: b.label }],
                  defaultValue: b.id,
                },
              ],
              submitLabel: "Restore",
              danger: true,
            },
          }))
        : // Enrichment hasn't loaded \u2014 fall back to raw-id pills with no
          // metadata so the user at least sees the count match.
          backupIds.map((id) => ({
            kind: "action" as const,
            label: `Backup ${id}`,
            action: {
              type: "prompt-nosql-command" as const,
              command: "restore",
              title: "Restore from this backup",
              description: "DESTRUCTIVE \u2014 replaces the boot disk with this backup image.",
              fields: [
                {
                  key: "image",
                  label: "Backup ID",
                  kind: "select" as const,
                  required: true,
                  options: [{ id, label: `Backup ${id}` }],
                  defaultValue: id,
                },
              ],
              submitLabel: "Restore",
              danger: true,
            },
          }));
    void accountId;
    customTabs.push({
      id: "backups",
      label: `Backups (${backupIds.length})`,
      sections: [
        {
          kind: "section",
          title: "Backup images",
          children: [
            { kind: "grid", columns: 2, items: pills },
            {
              kind: "text",
              variant: "muted",
              content:
                "Backups are kept for the retention window configured on the droplet. Click a backup above to restore from it.",
            },
          ],
        },
      ],
    });
  }

  if (snapshotIds.length > 0) {
    const accountId = resource.accountId;
    // Snapshots ARE resources \u2014 pills navigate to each snapshot's detail
    // page where rename / delete / create-droplet-from live.
    const pills =
      snapshotPillOptions.length > 0
        ? snapshotPillOptions.map((s) => ({
            kind: "action" as const,
            label: stripKindPrefix(s.label),
            action: {
              type: "navigate-to-resource" as const,
              pluginId: "digitalocean",
              resourceTypeId: "snapshot",
              resourceId: `${accountId}:snapshot:${s.id}`,
            },
          }))
        : snapshotIds.map((id) => ({
            kind: "action" as const,
            label: `Snapshot ${id}`,
            action: {
              type: "navigate-to-resource" as const,
              pluginId: "digitalocean",
              resourceTypeId: "snapshot",
              resourceId: `${accountId}:snapshot:${id}`,
            },
          }));
    customTabs.push({
      id: "snapshots",
      label: `Snapshots (${snapshotIds.length})`,
      sections: [
        {
          kind: "section",
          title: "Snapshots taken from this droplet",
          children: [
            { kind: "grid", columns: 2, items: pills },
            {
              kind: "text",
              variant: "muted",
              content:
                "Click a snapshot to open it \u2014 rename, delete, or create a new droplet from there.",
            },
          ],
        },
      ],
    });
  }

  if (volumeIds.length > 0) {
    const accountId = resource.accountId;
    customTabs.push({
      id: "volumes",
      label: `Volumes (${volumeIds.length})`,
      sections: [
        {
          kind: "section",
          title: "Attached block storage",
          children: [
            {
              kind: "table",
              columns: [
                { key: "id", label: "Volume ID", mono: true },
                { key: "open", label: "" },
              ],
              rows: volumeIds.map((id) => ({
                cells: {
                  id,
                  open: {
                    kind: "action",
                    label: "Open",
                    action: {
                      type: "navigate-to-resource",
                      pluginId: "digitalocean",
                      resourceTypeId: "volume",
                      resourceId: `${accountId}:volume:${id}`,
                    },
                  },
                },
              })),
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Detach from the volume's detail page. Volumes can only be attached to one droplet at a time and must be in the same region.",
            },
          ],
        },
      ],
    });
  }

  detail.customTabs = customTabs;
  detail.metricsCapability = { defaultTimeRangeMs: 60 * 60 * 1000 };
}
