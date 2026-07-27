import { f, rt } from "@infrawrench/plugin-base";

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description: "A DigitalOcean Project — groups related resources",
  fields: [
    f("name", "Name"),
    f("purpose", "Purpose", {
      kind: "enum",
      required: false,
      enumValues: ["Web Application", "API", "Mobile Application", "Website", "CI/CD", "Other"],
    }),
    f("description", "Description", { required: false }),
    f("environment", "Environment", {
      kind: "enum",
      required: false,
      enumValues: ["Development", "Staging", "Production"],
    }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "project",
});
