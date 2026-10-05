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
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
  ],
  outputs: [],
  // `lastUsedAt` is real; there is no creation date in the field bag, so the
  // key's age reads as unknown while its activity does not.
  principalRole: { role: "key", lastUsedKey: "lastUsedAt", parentKey: "createdBy" },
  iconKey: "key",
});
