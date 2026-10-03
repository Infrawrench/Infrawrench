import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifySnippetResourceType = rt({
  name: "Snippet",
  pinnable: false,
  id: "netlify-snippet",
  description: "An HTML snippet Netlify injects into every page of a site (analytics, widgets)",
  parentTypeId: "netlify-site",
  fields: [
    f("title", "Title"),
    f("position", "Position", {
      kind: "enum",
      enumValues: ["head", "footer"],
      required: false,
      description: "Inject before </head> or before </body>",
    }),
    f("code", "HTML", { required: false }),
    f("siteId", "Site", { required: false, editable: false }),
  ],
  outputs: [o("snippetId", "Snippet ID")],
  dependsOn: [{ fieldKey: "siteId", targetTypeId: "netlify-site", label: "injected into" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "file",
});
