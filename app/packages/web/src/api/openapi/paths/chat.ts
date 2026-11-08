import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid } from "../common";
import type { BuildContext } from "../context";

const ChatAskQuestionAnswer = strict({
  questionId: z.string().min(1).max(64).openapi({
    description: "Id of the question being answered.",
  }),
  optionId: z.string().min(1).max(64).optional().openapi({
    description: "Listed option id, or `other` when the user typed a custom value.",
  }),
  text: z.string().min(1).max(4000).optional().openapi({
    description: "Required for text questions and when optionId is `other`.",
  }),
}).openapi("ChatAskQuestionAnswer");

const ChatAskQuestionInput = strict({
  answers: z.array(ChatAskQuestionAnswer).min(1).openapi({
    description: "One answer per question the agent asked.",
  }),
}).openapi("ChatAskQuestionInput");

const ChatAskQuestionResult = strict({
  ok: z.literal(true),
  allResolved: z.boolean().openapi({
    description:
      "True when every pending action and secret request on this assistant message is resolved, so the caller may POST {resume: true}.",
  }),
}).openapi("ChatAskQuestionResult");

/**
 * The chat password field's body. The workflow-secrets domain (HttpApi)
 * defines the same `WorkflowSecretValueWrite` component for its value write;
 * the spec builder keeps that definition, so the two must stay identical.
 */
const WorkflowSecretValueWrite = strict({
  value: z
    .string()
    .min(1)
    .max(1024 * 1024)
    .openapi({
      description:
        "Write-only plaintext. It is AES-256-GCM encrypted before storage and is never returned.",
    }),
}).openapi("WorkflowSecretValueWrite");

const ChatSecretRequestResult = strict({
  ok: z.literal(true),
  allResolved: z.boolean(),
}).openapi("ChatSecretRequestResult");

export function registerChatPaths(ctx: BuildContext) {
  const { registry } = ctx;
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/chat/conversations/{conversationId}/pending/{pendingId}/answer",
    tags: ["Chat"],
    summary: "Answer an agent question",
    description:
      "Submit answers to a chat-only `ask_question` pending action (selection with an Other field, or a textarea). Not used for destructive-tool approval.",
    request: {
      params: OrgIdParam.extend({
        conversationId: Uuid.openapi({
          param: { name: "conversationId", in: "path" },
          description: "Chat conversation id",
        }),
        pendingId: Uuid.openapi({
          param: { name: "pendingId", in: "path" },
          description: "Pending ask_question action id",
        }),
      }),
      body: {
        required: true,
        content: { "application/json": { schema: ChatAskQuestionInput } },
      },
    },
    responses: {
      200: {
        description: "Answers recorded",
        content: { "application/json": { schema: ChatAskQuestionResult } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/chat/conversations/{conversationId}/secret-requests/{requestId}",
    tags: ["Chat"],
    summary: "Submit a requested workflow secret",
    description:
      "Human-only, write-only handoff from the chat password field to encrypted workflow-secret storage. The value is never returned or added to chat history.",
    request: {
      params: OrgIdParam.extend({
        conversationId: Uuid.openapi({
          param: { name: "conversationId", in: "path" },
          description: "Chat conversation id",
        }),
        requestId: Uuid.openapi({
          param: { name: "requestId", in: "path" },
          description: "Pending secret request id",
        }),
      }),
      body: {
        required: true,
        content: { "application/json": { schema: WorkflowSecretValueWrite } },
      },
    },
    responses: {
      200: {
        description: "Stored without returning the value",
        content: { "application/json": { schema: ChatSecretRequestResult } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });
}
