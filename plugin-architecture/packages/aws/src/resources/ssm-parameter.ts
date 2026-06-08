import { f, o, rt } from "@infrawrench/plugin-base";

export const SSMParameterResourceType = rt({
  name: "SSM Parameter",
  pinnable: false,
  id: "ssm-parameter",
  description: "An AWS Systems Manager Parameter Store parameter",
  fields: [
    f("name", "Name"),
    f("type", "Type", { kind: "enum", enumValues: ["String", "StringList", "SecureString"] }),
    f("version", "Version", { kind: "number", required: false }),
    f("tier", "Tier", {
      kind: "enum",
      required: false,
      enumValues: ["Standard", "Advanced", "Intelligent-Tiering"],
    }),
    f("lastModifiedDate", "Last Modified", { required: false }),
    f("dataType", "Data Type", { required: false }),
  ],
  outputs: [o("parameterArn", "Parameter ARN"), o("parameterValue", "Value", { sensitive: true })],
  iconKey: "secret",
  supportsCreate: true,
});
