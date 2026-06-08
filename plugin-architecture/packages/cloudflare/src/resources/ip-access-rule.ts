import { f, o, rt } from "@infrawrench/plugin-base";

export const IpAccessRuleResourceType = rt({
  name: "IP Access Rule",
  pinnable: false,
  id: "ip-access-rule",
  description: "A Cloudflare IP Access Rule (allow/block/challenge by IP, CIDR, ASN, or country)",
  fields: [
    f("mode", "Mode"),
    f("target", "Target", { editable: false }),
    f("value", "Value", { editable: false }),
    f("notes", "Notes", { required: false }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "firewall",
});
