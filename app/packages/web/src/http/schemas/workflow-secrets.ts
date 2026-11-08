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

/**
 * A secret's value, write-only. The body of the workflow-secrets value write
 * and of the chat password field's handoff (`POST .../chat/conversations/
 * {conversationId}/secret-requests/{requestId}`), one component for both.
 */
export const WorkflowSecretValueWrite = Schema.Struct({
  value: Schema.String.check(minLength(1), maxLength(1024 * 1024)).annotate({
    description:
      "Write-only plaintext. It is AES-256-GCM encrypted before storage and is never returned.",
  }),
}).annotate({ identifier: "WorkflowSecretValueWrite" });
