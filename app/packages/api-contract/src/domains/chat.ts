/**
 * The AI chat agent: `/api/org/:orgId/chat`, the endpoint definitions.
 *
 * Conversation CRUD, the month's spend, the SSE turn stream, pending-action
 * approval, structured answers to `ask_question` and the human-only secret
 * handoff. Outside the org tree's auth chain: every handler authenticates
 * itself (`http/org-request-caller.ts`) as a session, a WorkOS bearer token
 * or an `iwk_` key holding `chat:read` / `chat:write`, so the web app, the
 * desktop's cloud transport, the mobile app and unattended servers share one
 * surface, and the refusals keep their published sentences.
 *
 * Every operation is documented except the turn stream, whose answer is a
 * `text/event-stream` no generated client could consume. Every body is read
 * by hand, as the Hono routes read it (a refused field answers the handler's
 * own sentence), so the declared payloads describe what clients send rather
 * than decoding it. The shapes are client-core's chat contract
 * (`ChatConversationDetail`, `SpendStatus`, ...), which every host's chat UI
 * reads; the answers are those rows as the server stores them, so a
 * conversation carries every column, not only the summary the list sends.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { CHAT_MODELS } from "@infrawrench/client-core";
import { maxLength, minLength } from "../schemas";
import { DocumentedPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, InternalServerError, NotFound } from "../http/errors";
import { documentedAs } from "../http/schemas/documented";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../http/schemas/common";
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

/**
 * A model id from client-core's `CHAT_MODELS`. Read as sent: the handler
 * answers an id it does not price with its own 400 (`Unknown model.
 * Supported: ...`), so the list is documentation, not a decode.
 */
const ChatModelId = documentedAs(
  Schema.Literals(CHAT_MODELS.map((model) => model.id)).annotate({
    description: "One of the chat models the server prices (`CHAT_MODELS`).",
  }),
);

const ChatConversationCreateInput = Schema.Struct({
  model: Schema.optionalKey(
    ChatModelId.annotate({
      description: "The model the conversation runs on. Omitted: the cheapest model.",
    }),
  ),
  title: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Initial title, cut to 200 characters. Omitted: `New chat`, renamed after the first message.",
    }),
  ),
  systemPrompt: Schema.optionalKey(
    Schema.String.annotate({ description: "Replaces the agent's default system prompt." }),
  ),
}).annotate({ identifier: "ChatConversationCreateInput" });

export const ChatConversationCreated = Schema.Struct({ id: Uuid }).annotate({
  identifier: "ChatConversationCreated",
});

const ChatConversationModelInput = Schema.Struct({
  model: ChatModelId.annotate({
    description: "The model the next turn runs on. Required.",
  }),
}).annotate({ identifier: "ChatConversationModelInput" });

/** What the conversation list sends per row (client-core `ConversationSummary`). */
const ChatConversationSummary = Schema.Struct({
  id: Uuid,
  title: Schema.String,
  model: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ChatConversationSummary" });

export const ChatConversationList = Schema.Struct({
  conversations: Schema.Array(ChatConversationSummary).annotate({
    description:
      "The caller's conversations in this organization, most recently active first; at most 200, archived ones left out.",
  }),
}).annotate({ identifier: "ChatConversationList" });

/** The conversation row itself: the summary's fields plus the rest of its columns. */
const ChatConversation = Schema.Struct({
  id: Uuid,
  organizationId: OrgId,
  userId: Schema.NullOr(Schema.String).annotate({
    description:
      "The owner: always the caller, since a conversation is only readable by its owner.",
  }),
  costCanvasId: Schema.NullOr(Uuid).annotate({
    description:
      "The cost canvas this conversation builds and edits, when it was started from one.",
  }),
  title: Schema.String,
  model: Schema.String,
  systemPrompt: Schema.NullOr(Schema.String).annotate({
    description: "The system prompt override; null runs the agent's default.",
  }),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ChatConversation" });

const ChatBlockProvider = Schema.optionalKey(
  Schema.Literals(["anthropic", "gemini"]).annotate({
    description:
      "Which provider minted the block's signature; absent on blocks written before the field, which are Anthropic's.",
  }),
);

/** One stored content block (client-core `ChatContentBlock`), in the Anthropic message shape. */
const ChatContentBlock = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
    signature: Schema.optionalKey(Schema.String),
    provider: ChatBlockProvider,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking"),
    thinking: Schema.String,
    signature: Schema.String,
    provider: ChatBlockProvider,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_use"),
    id: Schema.String,
    name: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
    signature: Schema.optionalKey(Schema.String),
    provider: ChatBlockProvider,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    tool_use_id: Schema.String,
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    ]),
    is_error: Schema.optionalKey(Schema.Boolean),
  }),
]).annotate({ identifier: "ChatContentBlock" });

const ChatMessage = Schema.Struct({
  id: Uuid,
  conversationId: Uuid,
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Array(ChatContentBlock),
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  cacheReadTokens: Schema.Int,
  cacheWriteTokens: Schema.Int,
  stopReason: Schema.NullOr(Schema.String).annotate({
    description:
      "The model's stop reason (`end_turn`, `tool_use`, `max_tokens`, ...); null on user messages.",
  }),
  createdAt: IsoDateTime,
}).annotate({ identifier: "ChatMessage" });

const ChatPendingAction = Schema.Struct({
  id: Uuid,
  conversationId: Uuid,
  messageId: Uuid,
  toolUseId: Schema.String,
  toolName: Schema.String,
  toolInput: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.Literals(["pending", "approved", "rejected", "executed", "errored"]),
  result: Schema.NullOr(Schema.String).annotate({
    description: "The tool's result once executed, or the rejection reason.",
  }),
  isError: Schema.Boolean,
  summary: Schema.NullOr(Schema.String).annotate({
    description: "What approving would change, in plain lines, when the tool can say so.",
  }),
  resolvedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
}).annotate({ identifier: "ChatPendingAction" });

const ChatPendingSecretRequest = Schema.Struct({
  id: Uuid,
  conversationId: Uuid,
  messageId: Uuid,
  toolUseId: Schema.String,
  secretId: Schema.NullOr(Uuid),
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "submitting", "stored"]),
  resolvedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ChatPendingSecretRequest" });

export const ChatConversationDetail = Schema.Struct({
  conversation: ChatConversation,
  messages: Schema.Array(ChatMessage).annotate({ description: "Oldest first." }),
  pendingActions: Schema.Array(ChatPendingAction).annotate({
    description:
      "Every tool call that needed approval or an answer, oldest first, whatever its status.",
  }),
  pendingSecretRequests: Schema.Array(ChatPendingSecretRequest).annotate({
    description:
      "Every secret the agent asked a human to enter, oldest first. Values are never included.",
  }),
}).annotate({ identifier: "ChatConversationDetail" });

export const ChatSpendStatus = Schema.Struct({
  monthToDateMicros: Schema.Finite.annotate({
    description:
      "AI spend this calendar month (chat and workflow `infra.ai`), in millionths of a US dollar.",
  }),
  monthlyCapMicros: Schema.NullOr(Schema.Finite).annotate({
    description: "The cap that spend is held to; null when the organization set none and pays.",
  }),
  exceeded: Schema.Boolean.annotate({
    description: "True when there is a cap and spend has reached it.",
  }),
  freeTier: Schema.Boolean.annotate({
    description:
      "True when the cap is the free tier's (no paid plan) rather than one the organization set.",
  }),
  complimentary: Schema.Boolean.annotate({
    description:
      "True when the organization has complimentary access: never billed, uncapped by default.",
  }),
}).annotate({ identifier: "ChatSpendStatus" });

const ChatPendingDecisionInput = Schema.Struct({
  action: Schema.Literals(["approve", "reject"]),
  reason: Schema.optionalKey(
    Schema.String.annotate({ description: "Recorded as the tool's result on a rejection." }),
  ),
}).annotate({ identifier: "ChatPendingDecisionInput" });

export const ChatPendingDecisionResult = Schema.Struct({
  ok: Schema.Literal(true),
  allResolved: Schema.Boolean.annotate({
    description:
      "True when every pending action and secret request on this assistant message is resolved, so the caller may POST {resume: true}.",
  }),
}).annotate({ identifier: "ChatPendingDecisionResult" });

const ChatTurnInput = Schema.Struct({
  text: Schema.optionalKey(
    Schema.String.annotate({
      description: "A new user message. One of `text` or `resume` is required.",
    }),
  ),
  resume: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Continue the turn once every pending action on it is resolved.",
    }),
  ),
}).annotate({ identifier: "ChatTurnInput" });

/** The turn stream: `event: <type>` / `data: <AgentEvent JSON>` frames. */
const TurnStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

export class ChatGroup extends HttpApiGroup.make("chat")
  .add(
    HttpApiEndpoint.get("listConversations", "/conversations", {
      params: OrgParams,
      success: ChatConversationList,
    })
      .annotate(OpenApi.Summary, "List the caller's chat conversations")
      .annotate(SuccessDescription, "Conversations")
      .annotate(DocumentedPermission, "chat:read"),
    HttpApiEndpoint.post("createConversation", "/conversations", {
      params: OrgParams,
      payload: ChatConversationCreateInput,
      success: ChatConversationCreated,
      error: [BadRequest],
    })
      .annotate(OpenApi.Summary, "Start a chat conversation")
      .annotate(
        OpenApi.Description,
        "Creates an empty conversation owned by the caller. Send its first message with `POST /conversations/{conversationId}/messages`.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(DocumentedPermission, "chat:write"),
    HttpApiEndpoint.patch("updateConversation", "/conversations/:conversationId", {
      params: ConversationParams,
      payload: ChatConversationModelInput,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(OpenApi.Summary, "Switch a conversation's model")
      .annotate(OpenApi.Description, "Takes effect on the conversation's next turn.")
      .annotate(SuccessDescription, "Switched")
      .annotate(DocumentedPermission, "chat:write"),
    HttpApiEndpoint.get("getConversation", "/conversations/:conversationId", {
      params: ConversationParams,
      success: ChatConversationDetail,
      error: [NotFound],
    })
      .annotate(OpenApi.Summary, "A conversation with its messages and pending items")
      .annotate(SuccessDescription, "Conversation")
      .annotate(DocumentedPermission, "chat:read"),
    HttpApiEndpoint.delete("archiveConversation", "/conversations/:conversationId", {
      params: ConversationParams,
      success: Ok,
    })
      .annotate(OpenApi.Summary, "Archive a conversation")
      .annotate(
        OpenApi.Description,
        "Hides the conversation from the list; its history is kept. Answers `ok` whether or not the conversation was the caller's.",
      )
      .annotate(SuccessDescription, "Archived")
      .annotate(DocumentedPermission, "chat:write"),
    HttpApiEndpoint.get("spend", "/spend", {
      params: OrgParams,
      success: ChatSpendStatus,
    })
      .annotate(OpenApi.Summary, "Month-to-date chat spend and cap")
      .annotate(SuccessDescription, "Spend")
      .annotate(DocumentedPermission, "chat:read"),
    // A `text/event-stream` answer, which no generated client consumes.
    HttpApiEndpoint.post("sendMessage", "/conversations/:conversationId/messages", {
      params: ConversationParams,
      payload: ChatTurnInput,
      success: TurnStream,
      error: [BadRequest, NotFound],
    })
      .annotate(OpenApi.Summary, "Run a turn (new text or resume), streamed as SSE")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("decidePending", "/conversations/:conversationId/pending/:pendingId", {
      params: PendingParams,
      payload: ChatPendingDecisionInput,
      success: ChatPendingDecisionResult,
      error: [BadRequest, Forbidden, NotFound, Conflict, InternalServerError],
    })
      .annotate(OpenApi.Summary, "Approve or reject a pending tool call")
      .annotate(
        OpenApi.Description,
        "Approving runs the tool now, before answering; a tool that fails answers 500 with its error and the action is recorded as `errored`. Not for `ask_question` actions, which take answers instead.",
      )
      .annotate(SuccessDescription, "Decided")
      .annotate(DocumentedPermission, "chat:write"),
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
