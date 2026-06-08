import { f, o, rt } from "@infrawrench/plugin-base";

export const AccessApplicationResourceType = rt({
  name: "Access Application",
  id: "access-application",
  description: "A Cloudflare Zero Trust Access application",
  fields: [
    f("name", "Name"),
    f("domain", "Domain"),
    f("type", "Type", { required: false, editable: false }),
    f("sessionDuration", "Session Duration", { required: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("aud", "Application AUD", { description: "The AUD tag for this Access application" }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "access",
});
