import { f, rt } from "@infrawrench/plugin-base";

export const RedirectRuleResourceType = rt({
  name: "Redirect Rule",
  pinnable: false,
  id: "redirect-rule",
  description: "A Cloudflare single redirect rule (rulesets http_request_dynamic_redirect phase)",
  fields: [
    f("description", "Description", { required: false }),
    f("expression", "Expression"),
    f("target", "Target URL"),
    f("statusCode", "Status", { kind: "number" }),
    f("preserveQuery", "Preserve Query", { kind: "boolean", required: false }),
    f("enabled", "Enabled", { kind: "boolean" }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dns",
});
