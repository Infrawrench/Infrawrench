/**
 * The AI chat agent: `/api/org/:orgId/chat`, the endpoint definitions.
 *
 * Conversation CRUD, the month's spend, the SSE turn stream, pending-action
 * approval, structured answers to `ask_question` and the human-only secret
 * handoff. Outside the org tree's auth chain: every handler authenticates
 * itself (`http/org-request-caller.ts`) as a session, a WorkOS bearer token
 * or an `iwk_` key holding `chat:read` / `chat:write`, so the web app, the
 * desktop's cloud proxy, the mobile app and unattended servers share one
 * surface, and the refusals keep their published sentences.
 *
 * The hand-written spec documented two operations, the question answer and
 * the secret handoff; everything else stays out of the document, as it did.
 * Every body is read by hand, as the Hono routes read it, so the declared
 * payloads are documentation only.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "../schemas";
import { DocumentedPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound } from "../http/errors";
import { OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { WorkflowSecretValueWrite } from "../http/schemas/workflow-secrets";

const ConversationId = Uuid.annotate({ description: "Chat conversation id" });

const ConversationParams = { orgId: OrgId, conversationId: ConversationId } as const;

const PendingParams = {
  ...ConversationParams,
  pendingId: Uuid.annotate({ description: "Pending ask_question action id" }),
} as const;

const SecretRequestParams = {
  ...ConversationParams,
  requestId: Uuid.annotate({ description: "Pending secret request id" }),
} as const;

const ChatAskQuestionAnswer = Schema.Struct({
  questionId: Schema.String.check(minLength(1), maxLength(64)).annotate({
    description: "Id of the question being answered.",
  }),
  optionId: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(64)).annotate({
      description: "Listed option id, or `other` when the user typed a custom value.",
    }),
  ),
  text: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(4000)).annotate({
      description: "Required for text questions and when optionId is `other`.",
    }),
  ),
}).annotate({ identifier: "ChatAskQuestionAnswer" });

const ChatAskQuestionInput = Schema.Struct({
  answers: Schema.Array(ChatAskQuestionAnswer)
    .check(minLength(1))
    .annotate({ description: "One answer per question the agent asked." }),
}).annotate({ identifier: "ChatAskQuestionInput" });

export const ChatAskQuestionResult = Schema.Struct({
  ok: Schema.Literal(true),
  allResolved: Schema.Boolean.annotate({
    description:
      "True when every pending action and secret request on this assistant message is resolved, so the caller may POST {resume: true}.",
  }),
}).annotate({ identifier: "ChatAskQuestionResult" });

export const ChatSecretRequestResult = Schema.Struct({
  ok: Schema.Literal(true),
  allResolved: Schema.Boolean,
}).annotate({ identifier: "ChatSecretRequestResult" });

/** What an undocumented endpoint sends: the route's own JSON, untouched. */
const Undocumented = Schema.Unknown;

/** The turn stream: `event: <type>` / `data: <AgentEvent JSON>` frames. */
const TurnStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

export class ChatGroup extends HttpApiGroup.make("chat")
  .add(
    HttpApiEndpoint.get("listConversations", "/conversations", {
      params: OrgParams,
      success: Undocumented,
    })
      .annotate(OpenApi.Summary, "List the caller's chat conversations")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("createConversation", "/conversations", {
      params: OrgParams,
      success: Undocumented,
      error: [BadRequest],
    })
      .annotate(OpenApi.Summary, "Start a chat conversation")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.patch("updateConversation", "/conversations/:conversationId", {
      params: ConversationParams,
      success: Undocumented,
      error: [BadRequest, NotFound],
    })
      .annotate(OpenApi.Summary, "Switch a conversation's model")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.get("getConversation", "/conversations/:conversationId", {
      params: ConversationParams,
      success: Undocumented,
      error: [NotFound],
    })
      .annotate(OpenApi.Summary, "A conversation with its messages and pending items")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.delete("archiveConversation", "/conversations/:conversationId", {
      params: ConversationParams,
      success: Undocumented,
    })
      .annotate(OpenApi.Summary, "Archive a conversation")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.get("spend", "/spend", {
      params: OrgParams,
      success: Undocumented,
    })
      .annotate(OpenApi.Summary, "Month-to-date chat spend and cap")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("sendMessage", "/conversations/:conversationId/messages", {
      params: ConversationParams,
      success: TurnStream,
      error: [BadRequest, NotFound],
    })
      .annotate(OpenApi.Summary, "Run a turn (new text or resume), streamed as SSE")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("decidePending", "/conversations/:conversationId/pending/:pendingId", {
      params: PendingParams,
      success: Undocumented,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    })
      .annotate(OpenApi.Summary, "Approve or reject a pending tool call")
      .annotate(OpenApi.Exclude, true),
  )
  .add(
    HttpApiEndpoint.post(
      "answerQuestion",
      "/conversations/:conversationId/pending/:pendingId/answer",
      {
        params: PendingParams,
        payload: ChatAskQuestionInput,
        success: ChatAskQuestionResult,
        error: [BadRequest, Forbidden, NotFound, Conflict],
      },
    )
      .annotate(OpenApi.Summary, "Answer an agent question")
      .annotate(
        OpenApi.Description,
        "Submit answers to a chat-only `ask_question` pending action (selection with an Other field, or a textarea). Not used for destructive-tool approval.",
      )
      .annotate(SuccessDescription, "Answers recorded")
      .annotate(DocumentedPermission, "chat:write"),
    HttpApiEndpoint.post(
      "submitSecretRequest",
      "/conversations/:conversationId/secret-requests/:requestId",
      {
        params: SecretRequestParams,
        payload: WorkflowSecretValueWrite,
        success: ChatSecretRequestResult,
        error: [BadRequest, Forbidden, NotFound, Conflict],
      },
    )
      .annotate(OpenApi.Summary, "Submit a requested workflow secret")
      .annotate(
        OpenApi.Description,
        "Human-only, write-only handoff from the chat password field to encrypted workflow-secret storage. The value is never returned or added to chat history.",
      )
      .annotate(SuccessDescription, "Stored without returning the value"),
  )
  .prefix("/api/org/:orgId/chat")
  .annotate(OpenApi.Title, "Chat") {}

export class ChatApi extends withApiDefaults(HttpApi.make("chat").add(ChatGroup)) {}
