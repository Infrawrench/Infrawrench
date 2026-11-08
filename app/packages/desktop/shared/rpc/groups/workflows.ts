/**
 * Local workflows: the QuickJS sandbox that runs them, and the encrypted
 * secrets they are given.
 *
 * The sandbox needs Node's `Buffer`, so it runs in the main process
 * (`electron/workflow-host.ts`), while every host capability it calls
 * (plugin clients, the local database, prompts) lives in the renderer. A run
 * is one streaming call, `WorkflowRun`: it streams each `HostCall` the
 * sandbox makes and each `Log` entry, and ends with `Done`. The renderer
 * answers a call with `WorkflowHostReply`; Effect RPC has no
 * server-to-client request, and this is what one looks like.
 *
 * `WorkflowStop` aborts the run the way the editor's Stop button always has:
 * the sandbox winds down and the stream still ends with `Done` and its
 * result. Interrupting the stream (the renderer going away) aborts it too,
 * and fails the host calls still waiting.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type {
  RunLogEntry as RunLogEntryType,
  RunResult as RunResultType,
} from "@infrawrench/workflow-runtime/client";
import { exact } from "../exact";
import { StructuredArgs, StructuredValue } from "../structured";

const LogLevel = Schema.Literals(["debug", "info", "warn", "error"]);

export const RunLogEntry = exact<RunLogEntryType>()(
  Schema.Struct({ at: Schema.Finite, level: LogLevel, message: Schema.String }),
);

const RunError = Schema.Struct({
  message: Schema.String,
  stack: Schema.optionalKey(Schema.String),
});

export const RunResult = exact<RunResultType>()(
  Schema.Struct({
    status: Schema.Literals(["pending", "running", "success", "failure", "canceled"]),
    logs: Schema.mutable(Schema.Array(RunLogEntry)),
    output: Schema.optionalKey(StructuredValue),
    error: Schema.optionalKey(RunError),
    startedAt: Schema.Finite,
    finishedAt: Schema.Finite,
    durationMs: Schema.Finite,
  }),
);

export const WorkflowRunEvent = Schema.Union([
  /** The sandbox called `method` on the host; answer with `WorkflowHostReply` and this `callId`. */
  Schema.TaggedStruct("HostCall", {
    callId: Schema.Int,
    method: Schema.String,
    args: StructuredArgs,
  }),
  Schema.TaggedStruct("Log", { entry: RunLogEntry }),
  Schema.TaggedStruct("Done", { result: RunResult }),
]);
export type WorkflowRunEvent = typeof WorkflowRunEvent.Type;

/** The run could not start: its workflow or an assigned secret is gone, or the runtime failed to load. */
export class WorkflowRunError extends Schema.TaggedError<WorkflowRunError>()("WorkflowRunError", {
  message: Schema.String,
}) {}

export const WorkflowSecretSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  hasValue: Schema.Boolean,
});
export type WorkflowSecretSummary = typeof WorkflowSecretSummary.Type;

/** A dot identifier: `infra.secrets.<name>` in the workflow. */
const SecretName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/, {
    message: "Secret name must be a JavaScript dot identifier",
  }),
);

const SecretId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: "Invalid workflow secret id",
  }),
);

/** The secret is missing, its name conflicts with another, or the database write failed. */
export class WorkflowSecretError extends Schema.TaggedError<WorkflowSecretError>()(
  "WorkflowSecretError",
  { message: Schema.String },
) {}

export class WorkflowRpcs extends RpcGroup.make(
  Rpc.make("WorkflowRun", {
    payload: {
      /** Names this run for `WorkflowStop`. */
      runToken: Schema.String,
      source: Schema.String,
      interactive: Schema.Boolean,
      /** Main loads this workflow's assigned secret snapshot from SQLite. */
      workflowId: Schema.String,
      debug: Schema.optionalKey(Schema.Boolean),
    },
    success: WorkflowRunEvent,
    error: WorkflowRunError,
    stream: true,
  }),
  Rpc.make("WorkflowStop", { payload: { runToken: Schema.String } }),
  /** An unknown or already-answered `callId` is ignored. */
  Rpc.make("WorkflowHostReply", {
    payload: Schema.Union([
      Schema.TaggedStruct("Ok", { callId: Schema.Int, value: StructuredValue }),
      Schema.TaggedStruct("Failed", { callId: Schema.Int, error: RunError }),
    ]),
  }),
  Rpc.make("WorkflowSecretsList", {
    success: Schema.mutable(Schema.Array(WorkflowSecretSummary)),
    error: WorkflowSecretError,
  }),
  Rpc.make("WorkflowSecretUpsert", {
    payload: {
      id: Schema.optionalKey(SecretId),
      name: SecretName,
      value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024 * 1024)),
    },
    success: WorkflowSecretSummary,
    error: WorkflowSecretError,
  }),
  Rpc.make("WorkflowSecretDelete", {
    payload: { id: SecretId },
    error: WorkflowSecretError,
  }),
) {}
