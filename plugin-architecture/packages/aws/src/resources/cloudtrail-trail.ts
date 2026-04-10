import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudTrailTrailResourceType: ResourceTypeDefinition = {
  id: "cloudtrail-trail",
  displayName: "CloudTrail Trail",
  pluralDisplayName: "CloudTrail Trails",
  description: "An AWS CloudTrail trail for API logging",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "s3BucketName", label: "S3 Bucket", kind: "string", required: false },
    { key: "isMultiRegion", label: "Multi-Region", kind: "boolean", required: false },
    { key: "isOrganizationTrail", label: "Organization Trail", kind: "boolean", required: false },
    { key: "logFileValidationEnabled", label: "Log Validation", kind: "boolean", required: false },
    { key: "includeGlobalServiceEvents", label: "Global Events", kind: "boolean", required: false },
    { key: "status", label: "Logging", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "trailArn", label: "Trail ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "log",
};
