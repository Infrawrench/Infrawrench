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
}
