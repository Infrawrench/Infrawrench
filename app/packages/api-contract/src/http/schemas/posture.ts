/**
 * A posture finding: one rule a resource fails. Shared by the posture screen
 * (`/posture`) and a service's summary (`/services/{id}/summary`), which lists
 * the same findings for the service's resources.
 */
import { Schema } from "effect";
import { Uuid } from "./common";
import { PluginId } from "./plugin-registry";

export const PostureSeverity = Schema.Literals(["critical", "high", "medium", "low"]).annotate({
  description:
    "How bad the finding is. `critical` and `high` findings feed the posture alerts; " +
    "`medium` and `low` are hygiene work surfaced on the posture screen only.",
});

export const PostureCategory = Schema.Literals([
  "public-exposure",
  "encryption",
  "credential-age",
  "data-protection",
  "other",
]).annotate({ description: "Grouping bucket for what kind of exposure the finding describes." });

// Kept as a field set so `DismissedPostureFinding` is one flat object rather
// than an `allOf` branch, which `additionalProperties: false` would make
// uninhabited.
export const postureFindingFields = {
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id." }),
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["AWS"] }),
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["S3 Bucket"] }),
  accountId: Uuid,
  accountName: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "Provider-native id, when known.",
  }),
  ruleId: Schema.String.annotate({
    description: "The matched rule's stable id, unique within the plugin.",
    examples: ["hetzner-server-no-firewall"],
  }),
  title: Schema.String.annotate({
    description: "Short rule title.",
    examples: ["No firewall attached"],
  }),
  severity: PostureSeverity,
  category: PostureCategory,
  reason: Schema.String.annotate({
    description: "Plugin-authored explanation of why this is a finding.",
  }),
};

export const PostureFinding = Schema.Struct(postureFindingFields).annotate({
  identifier: "PostureFinding",
});
