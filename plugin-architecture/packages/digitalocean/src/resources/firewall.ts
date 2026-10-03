import { f, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean Cloud Firewall (`/v2/firewalls`). Rules are stored as a
 * readable summary for the list view; the detail page reads the full rule
 * set from `resolvedOutputs` and manages it through the rules endpoints.
 *
 * Shape verified against digitalocean/openapi
 * (`specification/resources/firewalls/models/firewall.yml` and
 * `firewall_rule.yml`, which added the `allow`/`deny` rule action).
 */
export const FirewallResourceType = rt({
  name: "Firewall",
  id: "firewall",
  description: "A DigitalOcean Cloud Firewall applied to Droplets and tags.",
  fields: [
    f("name", "Name", {
      description: "Starts with a letter or digit; then letters, digits, periods and dashes only.",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("dropletIds", "Droplet IDs", {
      required: false,
      editable: false,
      description: "Comma-separated IDs of the Droplets this firewall protects.",
    }),
    f("tags", "Tags", {
      required: false,
      editable: false,
      description: "Droplet tags this firewall applies to.",
    }),
    f("inboundRuleCount", "Inbound Rules", { kind: "number", required: false, editable: false }),
    f("outboundRuleCount", "Outbound Rules", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "dropletIds", targetTypeId: "droplet", label: "protects" }],
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "firewall",
  /**
   * A firewall with no Droplets and no tags filters nothing. It costs nothing
   * either, but it is almost always left behind by a deleted Droplet. The
   * lister always writes both fields.
   */
  orphanRule: {
    conditions: [
      { fieldKey: "dropletIds", when: "equals", value: "" },
      { fieldKey: "tags", when: "equals", value: "" },
    ],
    reason: "Firewall is not applied to any Droplet or tag",
  },
});
