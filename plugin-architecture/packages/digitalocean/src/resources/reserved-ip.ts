import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean reserved IP (`/v2/reserved_ips`) — the product formerly
 * called "floating IP". The address itself is the identifier: DO's detail,
 * delete and action endpoints are all keyed by `/v2/reserved_ips/{ip}`, so
 * `externalId` is the dotted-quad rather than a uuid.
 *
 * Shape verified against digitalocean/openapi
 * (`specification/resources/reserved_ips/models/reserved_ip.yml`): `ip`,
 * `region` (the full region object), `droplet` (the full Droplet object, or
 * `null` when unassigned), `locked`, `project_id`.
 *
 * Why this type exists at all: DigitalOcean gives away reserved IPs that are
 * assigned to a Droplet and bills $5/month ($0.01/hour) for ones that are
 * merely reserved, which makes an unassigned address the single most common
 * silent line item on a DO invoice — see `orphanRule` below.
 */
export const ReservedIpResourceType = rt({
  name: "Reserved IP",
  id: "reserved-ip",
  description: "A DigitalOcean reserved IP address (formerly floating IP)",
  fields: [
    f("ip", "IP Address"),
    f("region", "Region", { description: "Region slug the address is reserved to, e.g. nyc3." }),
    f("dropletId", "Assigned Droplet", {
      required: false,
      description: "ID of the Droplet this address is assigned to. Empty when unassigned.",
    }),
    f("dropletName", "Droplet Name", { required: false }),
    f("locked", "Locked", {
      kind: "boolean",
      required: false,
      description: "True while DigitalOcean has a pending action on this address.",
    }),
    f("projectId", "Project", {
      required: false,
      description: "UUID of the project the address belongs to.",
    }),
  ],
  outputs: [o("ip", "IP Address")],
  // The lister records the assigned Droplet's numeric id, which is exactly a
  // Droplet resource's externalId — one edge per assignment, no translation.
  dependsOn: [{ fieldKey: "dropletId", targetTypeId: "droplet", label: "assigned to" }],
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  iconKey: "network",
  /**
   * An unassigned reserved IPv4 costs $5/month; an assigned one is free. The
   * lister always writes `dropletId` (`""` when `droplet` is null), so the
   * condition is `equals: ""` rather than `empty` — `equals` never matches an
   * absent field, so a row written by anything that doesn't populate
   * `dropletId` can never be falsely flagged.
   *
   * `locked` is a second guard: a locked address has a queued assign/unassign
   * action, so flagging it would make the savings list flap while DO settles.
   * Same absent-field reasoning applies — `equals` skips rows without it.
   */
  orphanRule: {
    conditions: [
      { fieldKey: "dropletId", when: "equals", value: "" },
      { fieldKey: "locked", when: "equals", value: "false" },
    ],
    reason: "Reserved IP is not assigned to any Droplet (DigitalOcean bills idle reserved IPs)",
  },
  // Region-matched: DO rejects an assign whose Droplet lives elsewhere.
  attachTargets: [
    {
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      matchField: "region",
      verb: "Assign",
    },
  ],
});
