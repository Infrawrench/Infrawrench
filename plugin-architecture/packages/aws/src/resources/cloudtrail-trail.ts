import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudTrailTrailResourceType = rt({
  name: "CloudTrail Trail",
  id: "cloudtrail-trail",
  description: "An AWS CloudTrail trail for API logging",
  fields: [
    f("name", "Name"),
    f("s3BucketName", "S3 Bucket", { required: false }),
    f("isMultiRegion", "Multi-Region", { kind: "boolean", required: false }),
    f("isOrganizationTrail", "Organization Trail", { kind: "boolean", required: false }),
    f("logFileValidationEnabled", "Log Validation", { kind: "boolean", required: false }),
    f("includeGlobalServiceEvents", "Global Events", { kind: "boolean", required: false }),
    f("status", "Logging", { kind: "boolean", required: false }),
  ],
  outputs: [o("trailArn", "Trail ARN")],
  dependsOn: [{ fieldKey: "s3BucketName", targetTypeId: "s3-bucket", label: "logs to" }],
  supportsCreate: true,
  iconKey: "log",
  postureChecks: [
    {
      id: "cloudtrail-no-log-validation",
      title: "Log file validation off",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "logFileValidationEnabled", when: "falsy" }],
      reason:
        "Log file integrity validation is off, so tampering with delivered CloudTrail log files cannot be detected afterwards.",
    },
  ],
});
