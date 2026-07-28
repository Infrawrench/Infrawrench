import { f, o, rt } from "@infrawrench/plugin-base";

export const SecretResourceType = rt({
  name: "Secret",
  id: "secret",
  description:
    "An account-scoped secret Fireworks jobs can reference by key name (e.g. a Weights & Biases token). Values are write-only and never returned.",
  fields: [f("keyName", "Key Name"), f("secretId", "Secret ID")],
  outputs: [o("secretName", "Secret Resource Name"), o("keyName", "Key Name")],
  iconKey: "secret",
});
