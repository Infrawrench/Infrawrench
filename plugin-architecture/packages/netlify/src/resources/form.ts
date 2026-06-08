import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyFormResourceType = rt({
  name: "Form",
  pinnable: false,
  id: "netlify-form",
  description: "A Netlify form — collects submissions from static HTML forms",
  fields: [
    f("name", "Name"),
    f("submissionCount", "Submissions", { kind: "number", required: false }),
    f("paths", "Paths", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("formId", "Form ID"), o("formName", "Form Name")],
  parentTypeId: "netlify-site",
  iconKey: "form",
});
