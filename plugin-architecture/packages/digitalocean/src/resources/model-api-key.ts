import { f, o, rt } from "@infrawrench/plugin-base";

export const ModelApiKeyResourceType = rt({
  name: "Model API Key",
  pinnable: false,
  id: "model-api-key",
  description:
    "A DigitalOcean model access key — scoped credential used to authenticate against the serverless inference endpoints at inference.do-ai.run. Create these in DigitalOcean's Model Studio (the create endpoint is retired); Infrawrench lists and deletes them.",
  fields: [
    f("name", "Name"),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
  ],
  outputs: [],
  iconKey: "key",
});
