import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SSMParameterResourceType: ResourceTypeDefinition = {
  id: "ssm-parameter",
  displayName: "SSM Parameter",
  pluralDisplayName: "SSM Parameters",
  description: "An AWS Systems Manager Parameter Store parameter",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "type", label: "Type", kind: "enum", required: true, enumValues: ["String", "StringList", "SecureString"] },
    { key: "version", label: "Version", kind: "number", required: false },
    { key: "tier", label: "Tier", kind: "enum", required: false, enumValues: ["Standard", "Advanced", "Intelligent-Tiering"] },
    { key: "lastModifiedDate", label: "Last Modified", kind: "string", required: false },
    { key: "dataType", label: "Data Type", kind: "string", required: false },
  ],
  outputs: [
    { key: "parameterArn", label: "Parameter ARN", sensitive: false },
    { key: "parameterValue", label: "Value", sensitive: true },
  ],
  dashboardPinnable: false,
  iconKey: "secret",
};
