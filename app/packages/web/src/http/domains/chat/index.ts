/**
 * The AI chat agent: `/api/org/:orgId/chat`, the handlers.
 *
 * Each authenticates first, in its own words (`asChatCaller`), then reads its
 * input the way the Hono route did: a body that is not JSON where the route
 * called `c.req.json()` bare is the 500 it always was, one read with a
 * fallback is the fallback. An `iwk_` caller's key is the audit principal for
 * the whole request, carried on the fiber (`http/caller-auth.ts`), so a tool
 * run from an approval or a turn records the key rather than its owner.
 *
 * The write endpoints are uninterruptible: the Hono handlers ran to the end
 * whether or not the client stayed, and an approval interrupted between
 * claiming its row and running the tool would leave it claimed and never run.
 */
import { Effect, Predicate } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from "@infrawrench/ui";
import {
  ASK_QUESTION_TOOL_NAME,
  formatAskQuestionResult,
  parseAskQuestionInput,
  validateAskQuestionAnswers,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import {
  badRequest,
  ChatApi,
  ChatAskQuestionResult,
  ChatConversationCreated,
  ChatConversationDetail,
  ChatConversationList,
  ChatPendingDecisionResult,
  ChatSecretRequestResult,
  ChatSpendStatus,
  conflict,
  forbidden,
  notFound,
  Ok,
} from "@infrawrench/api-contract";
import type { OrgAuthResult } from "../../../auth/org-request-auth";
import { effectivePermissions } from "../../../auth/effective-permissions";
import { executePendingAction, rejectPendingAction, runAgentTurn } from "../../../chat/agent";
import { getMonthlySpend } from "../../../chat/billing";
import { noteChatToolApprovalDecided } from "../../../chat/slack-approvals";
import { storeWorkflowSecretFromChat } from "../../../chat/workflow-secret-store";
import { db } from "../../../db/client";
import {
  chatConversations,
  chatMessages,
  chatPendingActions,
  chatPendingSecretRequests,
  users,
} from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import type { ToolAuthContext } from "../../../tools/types";
import { makeDomain } from "../../domain";
import { fieldsOf, readJson, readJsonOr } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { asOrgRequestCaller } from "../../org-request-caller";
import { respond } from "../../response";
import { turnStreamResponse } from "./turn-stream";

/**
 * Authenticate as {@link asOrgRequestCaller} with one of the two chat
 * scopes, so a typo in a scope is a type error rather than a permission that
 * silently never matches.
 */
const asChatCaller = <A, E, R>(
  scope: "chat:read" | "chat:write",
  serve: (caller: OrgAuthResult) => Effect.Effect<A, E, R>,
) => asOrgRequestCaller(scope, serve);

const unknownModel = () =>
  badRequest(`Unknown model. Supported: ${CHAT_MODELS.map((m) => m.id).join(", ")}`);

const isChatModel = (model: unknown) => CHAT_MODELS.some((m) => m.id === model);

/** The tool layer's view of the caller: who, through what, with which key scopes. */
const toolAuthOf = (auth: OrgAuthResult): ToolAuthContext => ({
  userId: auth.userId,
  organizationId: auth.organizationId,
  source: auth.via === "api-key" ? "api" : "chat",
  ...(auth.email !== undefined ? { email: auth.email } : {}),
  ...(auth.apiKeyId !== undefined ? { apiKeyId: auth.apiKeyId } : {}),
  ...(auth.scopes !== undefined ? { scopes: auth.scopes } : {}),
});

/** `value.slice(...)` on a body field, as the route wrote it: a non-string threw (a 500). */
const stringField = (value: unknown, name: string): Effect.Effect<string | undefined> => {
  if (Predicate.isString(value) || Predicate.isNullish(value)) {
    return Effect.succeed(value ?? undefined);
  }
  return Effect.die(new TypeError(`body.${name}.slice is not a function`));
};

/** The conversation, when it is the caller's own in this org. */
const ownConversation = (auth: OrgAuthResult, conversationId: string) =>
  and(
    eq(chatConversations.id, conversationId),
    eq(chatConversations.organizationId, auth.organizationId),
    eq(chatConversations.userId, auth.userId),
  );

/**
 * Whether every pending action and secret request on an assistant message is
 * settled, which is when the client may resume the turn.
 */
async function allResolved(messageId: string): Promise<boolean> {
  const [actions, requests] = await Promise.all([
    db
      .select({ status: chatPendingActions.status })
      .from(chatPendingActions)
      .where(eq(chatPendingActions.messageId, messageId)),
    db
      .select({ status: chatPendingSecretRequests.status })
      .from(chatPendingSecretRequests)
      .where(eq(chatPendingSecretRequests.messageId, messageId)),
  ]);
  return (
    actions.every((item) => ["executed", "errored", "rejected"].includes(item.status)) &&
    requests.every((item) => item.status === "stored")
  );
}

/** A pending action, with the org and user owning its conversation. */
const pendingActionRow = (conversationId: string, pendingId: string) =>
  legacy(async () => {
    const [row] = await db
      .select({
        pending: chatPendingActions,
        orgId: chatConversations.organizationId,
        userId: chatConversations.userId,
      })
      .from(chatPendingActions)
      .innerJoin(chatConversations, eq(chatConversations.id, chatPendingActions.conversationId))
      .where(
        and(
          eq(chatPendingActions.id, pendingId),
          eq(chatPendingActions.conversationId, conversationId),
        ),
      )
      .limit(1);
    return row;
  });

/** A failure the handler answers itself rather than leaving to the defect renderer. */
class Caught {
  constructor(readonly error: unknown) {}
}
const caught = (error: unknown) => new Caught(error);

const ChatHandlers = HttpApiBuilder.group(ChatApi, "chat", (handlers) =>
  handlers
    // The caller's own conversations, most recent first.
    .handleRaw("listConversations", () =>
      asChatCaller("chat:read", (auth) =>
        Effect.gen(function* () {
          const rows = yield* legacy(() =>
            db
              .select({
                id: chatConversations.id,
                title: chatConversations.title,
                model: chatConversations.model,
                createdAt: chatConversations.createdAt,
                updatedAt: chatConversations.updatedAt,
              })
              .from(chatConversations)
              .where(
                and(
                  eq(chatConversations.organizationId, auth.organizationId),
                  eq(chatConversations.userId, auth.userId),
                  isNull(chatConversations.archivedAt),
                ),
              )
              .orderBy(desc(chatConversations.updatedAt))
              .limit(200),
          );
          return yield* respond(ChatConversationList)({
            conversations: rows,
          });
        }),
      ),
    )
    .handleRaw(
      "createConversation",
      ({ request }) =>
        asChatCaller("chat:write", (auth) =>
          Effect.gen(function* () {
            const body = yield* fieldsOf(yield* readJson(request));
            if (body["model"] && !isChatModel(body["model"])) return yield* unknownModel();
            const title = yield* stringField(body["title"], "title");
            const systemPrompt = body["systemPrompt"];
            if (systemPrompt && !Predicate.isString(systemPrompt)) {
              return yield* Effect.die(new TypeError("body.systemPrompt must be a string"));
            }
            const id = uuidv4();
            yield* legacy(() =>
              db.insert(chatConversations).values({
                id,
                organizationId: auth.organizationId,
                userId: auth.userId,
                title: title?.slice(0, 200) ?? "New chat",
                // Always write a model rather than letting the column default
                // decide. A caller that omits one (the desktop sidebar's New
                // chat did) would otherwise get whatever the schema happens to
                // say, which is how new chats silently opened on the most
                // expensive model instead of the cheapest.
                model: Predicate.isString(body["model"]) ? body["model"] : DEFAULT_CHAT_MODEL,
                ...(Predicate.isString(systemPrompt) && systemPrompt ? { systemPrompt } : {}),
              }),
            );
            return yield* respond(ChatConversationCreated)({ id });
          }),
        ),
      { uninterruptible: true },
    )
    // Switch the model; it takes effect on the next turn.
    .handleRaw(
      "updateConversation",
      ({ request, params }) =>
        asChatCaller("chat:write", (auth) =>
          Effect.gen(function* () {
            const body = yield* fieldsOf(yield* readJsonOr(request, {}));
            const model = body["model"];
            if (!model) return yield* badRequest("`model` is required");
            if (!isChatModel(model) || !Predicate.isString(model)) return yield* unknownModel();
            const updated = yield* legacy(() =>
              db
                .update(chatConversations)
                .set({ model, updatedAt: new Date() })
                .where(ownConversation(auth, params.conversationId))
                .returning({ id: chatConversations.id }),
            );
            if (updated.length === 0) return yield* notFound();
            return yield* respond(Ok)({ ok: true });
          }),
        ),
      { uninterruptible: true },
    )
    // A conversation with its messages, pending actions and secret requests.
    .handleRaw("getConversation", ({ params }) =>
      asChatCaller("chat:read", (auth) =>
        Effect.gen(function* () {
          const { conversationId } = params;
          const [conversationRows, messages, pending, pendingSecretRequests] = yield* legacy(() =>
            Promise.all([
              db
                .select()
                .from(chatConversations)
                .where(ownConversation(auth, conversationId))
                .limit(1),
              db
                .select()
                .from(chatMessages)
                .where(eq(chatMessages.conversationId, conversationId))
                .orderBy(asc(chatMessages.createdAt)),
              db
                .select()
                .from(chatPendingActions)
                .where(eq(chatPendingActions.conversationId, conversationId))
                .orderBy(asc(chatPendingActions.createdAt)),
              db
                .select()
                .from(chatPendingSecretRequests)
                .where(eq(chatPendingSecretRequests.conversationId, conversationId))
                .orderBy(asc(chatPendingSecretRequests.createdAt)),
            ]),
          );
          const [conversation] = conversationRows;
          if (!conversation) return yield* notFound();
          return yield* respond(ChatConversationDetail)({
            conversation,
            messages,
            pendingActions: pending,
            pendingSecretRequests,
          });
        }),
      ),
    )
    // Archive: the row stays, the lists stop showing it.
    .handleRaw(
      "archiveConversation",
      ({ params }) =>
        asChatCaller("chat:write", (auth) =>
          Effect.gen(function* () {
            yield* legacy(() =>
              db
                .update(chatConversations)
                .set({ archivedAt: new Date() })
                .where(ownConversation(auth, params.conversationId)),
            );
            return yield* respond(Ok)({ ok: true });
          }),
        ),
      { uninterruptible: true },
    )
    // Month-to-date spend and the cap it is held to.
    .handleRaw("spend", () =>
      asChatCaller("chat:read", (auth) =>
        Effect.gen(function* () {
          const status = yield* legacy(() => getMonthlySpend(auth.organizationId));
          return yield* respond(ChatSpendStatus)(status);
        }),
      ),
    )
    // Start a turn, with a new user message or by resuming once every pending
    // action is resolved, and stream it as SSE.
    .handleRaw(
      "sendMessage",
      ({ request, params }) =>
        asChatCaller("chat:write", (auth) =>
          Effect.gen(function* () {
            const { conversationId } = params;
            const [conversation] = yield* legacy(() =>
              db
                .select({ id: chatConversations.id })
                .from(chatConversations)
                .where(ownConversation(auth, conversationId))
                .limit(1),
            );
            if (!conversation) return yield* notFound();

            const body = yield* fieldsOf(yield* readJsonOr(request, {}));
            if (!body["text"] && !body["resume"]) {
              return yield* badRequest("Either `text` or `resume: true` is required");
            }
            const text = body["text"] ? yield* stringField(body["text"], "text") : undefined;

            // Title auto-rename: a conversation still on the default title is
            // named after the first 60 characters of the text just sent.
            if (text) {
              yield* fireAndForget(() =>
                db
                  .update(chatConversations)
                  .set({ title: text.slice(0, 60) })
                  .where(
                    and(
                      eq(chatConversations.id, conversationId),
                      eq(chatConversations.title, "New chat"),
                    ),
                  )
                  .catch((err: unknown) => {
                    console.error(`[chat] auto-rename failed for ${conversationId}:`, err);
                  }),
              );
            }

            const toolAuth = toolAuthOf(auth);
            const body$ = yield* turnStreamResponse(() =>
              runAgentTurn({
                conversationId,
                auth: toolAuth,
                ...(text ? { userText: text } : {}),
              }),
            );
            return HttpServerResponse.raw(body$);
          }),
        ),
      { uninterruptible: true },
    )
    // Approve or reject a tool call that needed approval. Approving runs it
    // here, synchronously; the client resumes the turn once all are resolved.
    .handleRaw(
      "decidePending",
      ({ request, params }) =>
        asChatCaller("chat:write", (auth) =>
          Effect.gen(function* () {
            const { conversationId, pendingId } = params;
            const row = yield* pendingActionRow(conversationId, pendingId);
            if (!row) return yield* notFound("Pending action not found");
            if (row.orgId !== auth.organizationId || row.userId !== auth.userId) {
              return yield* forbidden("Forbidden");
            }

            const body = yield* fieldsOf(yield* readJson(request));
            const action = body["action"];
            if (action !== "approve" && action !== "reject") {
              return yield* badRequest("action must be 'approve' or 'reject'");
            }
            if (row.pending.status !== "pending") {
              return yield* conflict(`Action already resolved (status=${row.pending.status})`);
            }
            if (row.pending.toolName === ASK_QUESTION_TOOL_NAME) {
              return yield* badRequest(
                "This pending action is a question; submit answers instead of approve/reject.",
              );
            }

            // Name the decider the way every other approval surface does:
            // display name first, email as the fallback.
            const [decider] = yield* legacy(() =>
              db
                .select({ displayName: users.displayName })
                .from(users)
                .where(eq(users.id, auth.userId))
                .limit(1),
            );
            const decidedByName = decider?.displayName ?? auth.email ?? null;

            // Retire the interactive Slack copies of this request, whatever
            // the decision. Fire-and-forget (the helper never throws): the
            // decision below is the record; Slack is presentation.
            const noteDecided = (decision: "approved" | "denied") =>
              fireAndForget(() =>
                keepAlive(
                  noteChatToolApprovalDecided({
                    organizationId: auth.organizationId,
                    pendingActionId: pendingId,
                    toolName: row.pending.toolName,
                    toolInput: row.pending.toolInput,
                    decision,
                    decidedByName,
                    via: "the web app",
                  }),
                ),
              );

            // Claim the row conditioned on it still being `pending`: the
            // returned row count makes two racing deciders (this route, a
            // Slack button, or both) produce exactly one decision. The loser
            // gets the same 409 as the status pre-check above.
            const claimed = yield* legacy(() =>
              db
                .update(chatPendingActions)
                .set({ status: action === "reject" ? "rejected" : "approved" })
                .where(
                  and(
                    eq(chatPendingActions.id, pendingId),
                    eq(chatPendingActions.status, "pending"),
                  ),
                )
                .returning({ id: chatPendingActions.id }),
            );
            if (claimed.length === 0) return yield* conflict("Action already resolved");

            if (action === "reject") {
              // The claim already decided the row, so the Slack copies retire
              // even when recording the rejection details throws.
              const reason = body["reason"];
              const { allResolved } = yield* legacy(() =>
                rejectPendingAction(pendingId, Predicate.isString(reason) ? reason : undefined),
              ).pipe(Effect.ensuring(noteDecided("denied")));
              return yield* respond(ChatPendingDecisionResult)({ ok: true, allResolved });
            }

            // Approved and claimed: execute synchronously. If execution
            // succeeds and every sibling is resolved, the caller can POST
            // /messages { resume: true } to continue the model loop.
            const toolAuth = toolAuthOf(auth);
            return yield* legacyTry(() => executePendingAction(pendingId, toolAuth), caught).pipe(
              Effect.flatMap(({ allResolved }) =>
                noteDecided("approved").pipe(
                  Effect.andThen(respond(ChatPendingDecisionResult)({ ok: true, allResolved })),
                ),
              ),
              Effect.catch(({ error }) =>
                Effect.gen(function* () {
                  const message = error instanceof Error ? error.message : "Execution failed";
                  yield* legacy(() =>
                    db
                      .update(chatPendingActions)
                      .set({
                        status: "errored",
                        result: message,
                        isError: true,
                        resolvedAt: new Date(),
                      })
                      .where(eq(chatPendingActions.id, pendingId)),
                  );
                  // The approval itself landed (only the execution failed), so
                  // the Slack copies' decision controls still retire.
                  yield* noteDecided("approved");
                  return HttpServerResponse.jsonUnsafe({ error: message }, { status: 500 });
                }),
              ),
            );
          }),
        ),
      { uninterruptible: true },
    )
    // The structured reply to `ask_question`, recorded as the tool's result.
    .handleRaw(
      "answerQuestion",
      ({ request, params }) =>
        asChatCaller("chat:write", (auth) =>
          Effect.gen(function* () {
            const { conversationId, pendingId } = params;
            const row = yield* pendingActionRow(conversationId, pendingId);
            if (!row) return yield* notFound("Pending action not found");
            if (row.orgId !== auth.organizationId || row.userId !== auth.userId) {
              return yield* forbidden("Forbidden");
            }
            if (row.pending.toolName !== ASK_QUESTION_TOOL_NAME) {
              return yield* badRequest("This pending action is not a question.");
            }
            if (row.pending.status !== "pending") {
              return yield* conflict(`Question already answered (status=${row.pending.status})`);
            }

            const parsedQuestions = parseAskQuestionInput(row.pending.toolInput);
            if (!parsedQuestions.ok) return yield* badRequest(parsedQuestions.error);

            const body = yield* fieldsOf(yield* readJsonOr(request, { answers: undefined }));
            const parsedAnswers = validateAskQuestionAnswers(
              parsedQuestions.questions,
              body["answers"],
            );
            if (!parsedAnswers.ok) return yield* badRequest(parsedAnswers.error);

            const result = formatAskQuestionResult(
              parsedQuestions.questions,
              parsedAnswers.answers,
            );
            const claimed = yield* legacy(() =>
              db
                .update(chatPendingActions)
                .set({ status: "executed", result, isError: false, resolvedAt: new Date() })
                .where(
                  and(
                    eq(chatPendingActions.id, pendingId),
                    eq(chatPendingActions.status, "pending"),
                  ),
                )
                .returning({ id: chatPendingActions.id }),
            );
            if (claimed.length === 0) return yield* conflict("Question already answered");

            const resolved = yield* legacy(() => allResolved(row.pending.messageId));
            return yield* respond(ChatAskQuestionResult)({ ok: true, allResolved: resolved });
          }),
        ),
      { uninterruptible: true },
    )
    // The chat password field's value, straight into encrypted workflow-secret
    // storage. Human-only: an API key is a machine principal.
    .handleRaw(
      "submitSecretRequest",
      ({ request, params }) =>
        asChatCaller("chat:write", (auth) =>
          Effect.gen(function* () {
            if (auth.via === "api-key") return yield* forbidden("Human authentication required");
            const permissions = yield* legacy(() =>
              effectivePermissions({
                userId: auth.userId,
                organizationId: auth.organizationId,
                ...(auth.scopes ? { scopes: auth.scopes } : {}),
              }),
            );
            if (!hasPermission(permissions, "secrets:write")) {
              return yield* forbidden("Missing required permission: secrets:write");
            }

            const { conversationId, requestId } = params;
            const body = yield* fieldsOf(yield* readJsonOr(request, { value: undefined }));
            const value = body["value"];
            if (!Predicate.isString(value)) return yield* badRequest("`value` must be a string");

            const row = yield* legacy(async () => {
              const [found] = await db
                .select({
                  request: chatPendingSecretRequests,
                  orgId: chatConversations.organizationId,
                  userId: chatConversations.userId,
                })
                .from(chatPendingSecretRequests)
                .innerJoin(
                  chatConversations,
                  eq(chatConversations.id, chatPendingSecretRequests.conversationId),
                )
                .where(
                  and(
                    eq(chatPendingSecretRequests.id, requestId),
                    eq(chatPendingSecretRequests.conversationId, conversationId),
                  ),
                )
                .limit(1);
              return found;
            });
            if (!row) return yield* notFound("Secret request not found");
            if (row.orgId !== auth.organizationId || row.userId !== auth.userId) {
              return yield* forbidden("Forbidden");
            }
            if (row.request.status !== "pending") {
              return yield* conflict("Secret request already submitted");
            }

            const claimed = yield* legacy(() =>
              db
                .update(chatPendingSecretRequests)
                .set({ status: "submitting", updatedAt: new Date() })
                .where(
                  and(
                    eq(chatPendingSecretRequests.id, requestId),
                    eq(chatPendingSecretRequests.status, "pending"),
                  ),
                )
                .returning({ id: chatPendingSecretRequests.id }),
            );
            if (claimed.length === 0) return yield* conflict("Secret request already submitted");

            const stored = yield* legacyTry(async () => {
              const secret = await storeWorkflowSecretFromChat({
                organizationId: auth.organizationId,
                secretId: row.request.secretId,
                name: row.request.name,
                description: row.request.description,
                value,
                onResolvedId: async (secretId) => {
                  // Persist only the resulting id before the value write. If
                  // encryption or storage fails, a retry updates the same
                  // secret instead of creating a duplicate.
                  await db
                    .update(chatPendingSecretRequests)
                    .set({ secretId, updatedAt: new Date() })
                    .where(eq(chatPendingSecretRequests.id, requestId));
                },
              });
              void logAudit({
                organizationId: auth.organizationId,
                userId: auth.userId,
                action: "workflow_secret.value_write",
                entityType: "workflow_secret",
                entityId: secret.id,
                metadata: { name: secret.name, source: "chat" },
              });
              await db
                .update(chatPendingSecretRequests)
                .set({ status: "stored", resolvedAt: new Date(), updatedAt: new Date() })
                .where(eq(chatPendingSecretRequests.id, requestId));
              return allResolved(row.request.messageId);
            }, caught).pipe(Effect.result);

            if (stored._tag === "Failure") {
              // Never serialize or log the exception: third-party and database
              // errors can carry bound values. Reset the metadata-only claim so
              // the human can safely retry.
              yield* legacy(() =>
                db
                  .update(chatPendingSecretRequests)
                  .set({ status: "pending", updatedAt: new Date() })
                  .where(eq(chatPendingSecretRequests.id, requestId)),
              );
              return HttpServerResponse.jsonUnsafe(
                { error: "Secret could not be stored" },
                { status: 500 },
              );
            }
            return yield* respond(ChatSecretRequestResult)({
              ok: true,
              allResolved: stored.success,
            });
          }),
        ),
      { uninterruptible: true },
    ),
);

export const chatDomain = makeDomain("chat", ChatApi, ChatHandlers);
