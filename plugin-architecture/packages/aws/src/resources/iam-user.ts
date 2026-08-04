import { f, o, rt } from "@infrawrench/plugin-base";

export const IAMUserResourceType = rt({
  name: "IAM User",
  pinnable: false,
  id: "iam-user",
  description: "An AWS Identity and Access Management user",
  fields: [
    f("userName", "User Name"),
    f("userId", "User ID"),
    f("path", "Path", { required: false }),
    f("createDate", "Created", { required: false }),
    f("passwordLastUsed", "Password Last Used", { required: false }),
  ],
  outputs: [
    o("userArn", "User ARN"),
    o("accessKey", "Access Key (credentials file)", {
      sensitive: true,
      description:
        "Creates a new programmatic access key on resolve. Emitted in ini format (`[default]\\naws_access_key_id=…\\naws_secret_access_key=…`). Each resolve creates one key; AWS caps at 2 per user.",
    }),
  ],
  iconKey: "user",
  supportsCreate: true,
  credentialFormats: [
    {
      id: "access-key",
      label: "Access Key",
      description: "Programmatic access key (ID + secret). Limit: 2 keys per user.",
      mediaType: "ini",
      filenameTemplate: "{resource}.credentials",
    },
  ],
  // `passwordLastUsed` is empty for users without console access, and an
  // unparseable value never matches — only genuinely stale passwords flag.
  postureChecks: [
    {
      id: "iam-user-stale-password",
      title: "Console password unused for 90+ days",
      severity: "low",
      category: "credential-age",
      conditions: [{ fieldKey: "passwordLastUsed", when: "olderThanDays", days: 90 }],
      reason:
        "This user's console password was last used more than 90 days ago — dormant credentials are a favorite target; disable console access or remove the user.",
    },
  ],
});
