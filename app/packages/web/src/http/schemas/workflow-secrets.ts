/**
 * Reusable workflow secrets as the API sends them: metadata only, never the
 * value. Shared by the workflow-secrets domain (the secrets themselves) and
 * the workflows domain (a workflow's assigned secrets).
 */
import { Schema } from "effect";
import { maxLength, minLength, pattern } from "@infrawrench/ui/schemas";
import { IsoDateTime, Uuid } from "./common";

export const WorkflowSecretName = Schema.String.check(
  minLength(1),
  maxLength(128),
  pattern(/^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/),
).annotate({
  description:
    "JavaScript dot identifier used to expose the value to workflow code, for example `API_TOKEN` or `stripe.apiKey`.",
});

export const WorkflowSecret = Schema.Struct({
  id: Uuid,
  name: WorkflowSecretName,
  description: Schema.NullOr(Schema.String),
  hasValue: Schema.Boolean.annotate({
    description: "Whether an encrypted value is stored. The value is never returned.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "WorkflowSecret" });
