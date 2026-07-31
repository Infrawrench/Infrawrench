/** Detail views for DigitalOcean networking resources (reserved IPs). */
import type { DetailViewSchema, ResourceInstance } from "@infrawrench/plugin-base";
import { parseJsonArray } from "./shared.js";

/** One Droplet option, pre-filtered to the address's region by enrichDetail. */
type DropletOption = { id: string; label: string };

/**
 * Header actions for a reserved IP: assign it to a Droplet in the same region,
 * or unassign it from the one it currently holds.
 *
 * Assign is a prompt with a Droplet **picker** rather than a numeric id field
 * — `enrichDetail` pre-fetches `/v2/droplets` filtered to this address's
 * region, since DigitalOcean rejects a cross-region assign outright. When the
 * region has no other Droplet the prompt degrades to a blocked, explanatory
 * modal instead of an empty select.
 *
 * Releasing the address entirely is the host's standard Delete (wired in
 * `client.deleteResource`), so it inherits the host's confirmation and change
 * freeze handling rather than being duplicated as a plugin action here.
 */
export function applyReservedIpDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
  const fields = resource.fields;
  const region = String(fields["region"] ?? "");
  const dropletId = String(fields["dropletId"] ?? "");
  const dropletName = String(fields["dropletName"] ?? "");
  const isAssigned = !!dropletId;
  const locked = fields["locked"] === true || String(fields["locked"] ?? "") === "true";

  const droplets = parseJsonArray<DropletOption>(resource.resolvedOutputs["__droplets__"]).filter(
    (d) => d.id !== dropletId,
  );

  const headerActions: DetailViewSchema["headerActions"] = [
    { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
  ];

  if (locked) {
    // A locked address has an action still running; DO would 422 anything we
    // send now. Say so instead of offering buttons that will fail.
    detail.sections.push({
      kind: "section",
      title: "Pending action",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "DigitalOcean is still working on this address (locked). Assign and unassign are unavailable until the pending action finishes — refresh in a moment.",
        },
      ],
    });
    detail.headerActions = headerActions;
    return;
  }

  headerActions.push({
    kind: "action",
    label: isAssigned ? "Reassign…" : "Assign to Droplet…",
    action:
      droplets.length > 0
        ? {
            type: "prompt-nosql-command",
            command: "reserved-ip-assign",
            title: isAssigned ? "Reassign reserved IP" : "Assign reserved IP",
            description: isAssigned
              ? `Moves ${String(fields["ip"] ?? "this address")} to another Droplet in ${region}. The current Droplet loses the address and traffic follows within seconds.`
              : `Assigns ${String(fields["ip"] ?? "this address")} to a Droplet in ${region}. Assigned reserved IPs are free; DigitalOcean bills unassigned ones.`,
            fields: [
              {
                key: "dropletId",
                label: "Droplet",
                kind: "select",
                required: true,
                options: droplets,
                ...(droplets[0] ? { defaultValue: droplets[0].id } : {}),
                description: `Only Droplets in ${region} are listed — DigitalOcean rejects a cross-region assignment.`,
              },
            ],
            submitLabel: "Assign",
          }
        : {
            type: "prompt-nosql-command",
            command: "reserved-ip-assign",
            title: "Assign reserved IP",
            description: `No other Droplet is available in ${region}. Reserved IPs can only be assigned to a Droplet in the region they are reserved to — create one there first.`,
            descriptionVariant: "error",
            blocked: true,
            fields: [],
          },
  });

  if (isAssigned) {
    headerActions.push({
      kind: "action",
      label: "Unassign",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "reserved-ip-unassign",
        confirmMessage: `Unassign ${String(fields["ip"] ?? "this address")} from ${dropletName || `Droplet ${dropletId}`}? Traffic to the address stops reaching the Droplet, and DigitalOcean starts billing the address while it sits unassigned.`,
        successMessage: "Unassign queued.",
      },
    });
  }

  detail.sections.push({
    kind: "section",
    title: "Assignment",
    children: [
      {
        kind: "key-value-list",
        items: [
          { key: "IP Address", value: String(fields["ip"] ?? ""), copyable: true },
          { key: "Region", value: region },
          {
            key: "Assigned To",
            value: isAssigned ? dropletName || `Droplet ${dropletId}` : "Not assigned",
          },
          { key: "Billing", value: isAssigned ? "Free while assigned" : "Billed while unassigned" },
        ],
      },
      ...(isAssigned
        ? []
        : [
            {
              kind: "text" as const,
              variant: "muted" as const,
              content:
                "DigitalOcean charges $5.00/month ($0.01/hour) for a reserved IPv4 that is reserved but not assigned to a Droplet. Assign it or delete it to stop the charge.",
            },
          ]),
    ],
  });

  detail.headerActions = headerActions;
}
