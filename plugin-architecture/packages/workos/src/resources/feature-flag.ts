import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A WorkOS feature flag for this environment. Flags are defined in the
 * dashboard; the API toggles them and manages which organizations and users
 * they target.
 * Docs: https://workos.com/docs/reference/feature-flags
 */
export const FeatureFlagResourceType = rt({
  name: "Feature Flag",
  id: "feature-flag",
  description:
    "A feature flag in this environment. Turn it on or off and target organizations or users here; define new flags in the WorkOS dashboard.",
  fields: [
    f("slug", "Slug", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("enabled", "Enabled", {
      kind: "boolean",
      required: false,
      description: "Whether the flag is active in this environment.",
    }),
    f("defaultValue", "Default value", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "What users and organizations outside every targeting rule receive.",
    }),
    f("tags", "Tags", { required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("flagSlug", "Flag Slug")],
  supportsUpdate: true,
  iconKey: "flag",
});
