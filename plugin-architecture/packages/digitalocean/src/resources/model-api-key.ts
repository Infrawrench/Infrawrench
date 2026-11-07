import { f, rt } from "@infrawrench/plugin-base";

export const ModelApiKeyResourceType = rt({
  name: "Model API Key",
  pinnable: false,
  id: "model-api-key",
  description:
    "A DigitalOcean model access key for the serverless inference endpoints at inference.do-ai.run. Create keys in DigitalOcean's Model Studio; Infrawrench lists and deletes them.",
  fields: [
    f("name", "Name"),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { showcase: true, required: false, editable: false }),
  ],
  outputs: [],
  // The document's key has `created_at` and no last use, so the key's age is known and
  // its activity reads as unknown.
  principalRole: { role: "key", parentKey: "createdBy" },
  iconKey: "key",
});
