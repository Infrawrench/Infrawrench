import { f, rt } from "@infrawrench/plugin-base";

export const AccessPolicyResourceType = rt({
  name: "Access Policy",
  plural: "Access Policies",
  pinnable: false,
  id: "access-policy",
  description: "A policy within a Cloudflare Zero Trust Access application",
  fields: [
    f("name", "Name"),
    f("decision", "Decision"),
    f("precedence", "Precedence", { kind: "number", required: false }),
    f("includeRules", "Include Rules", { required: false, editable: false }),
    f("excludeRules", "Exclude Rules", { required: false, editable: false }),
    f("requireRules", "Require Rules", { required: false, editable: false }),
    f("applicationId", "Application", { required: false, editable: false }),
  ],
  outputs: [],
  // The Access application's external id is the bare app id, which is exactly
  // what the lister now stores — no template needed.
  dependsOn: [
    { fieldKey: "applicationId", targetTypeId: "access-application", label: "policy for" },
  ],
  parentTypeId: "access-application",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "policy",
});
