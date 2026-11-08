/**
 * Local-mode posture findings: the cloud's `/posture` computation over this
 * machine's SQLite workspace, and accepting (or un-accepting) a finding there
 * (see `electron/local-posture.ts`).
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type {
  DismissedPostureFinding,
  PostureDismissal,
  PostureFinding,
  PostureListResponse as PostureListResponseType,
} from "@infrawrench/client-core";
import { exact } from "../exact";
import { LocalWorkspaceError } from "../errors";
import { PostureSeverity } from "./local-dns";

const postureFindingFields = {
  resourceId: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  ruleId: Schema.String,
  title: Schema.String,
  severity: PostureSeverity,
  category: Schema.Literals([
    "public-exposure",
    "encryption",
    "credential-age",
    "data-protection",
    "other",
  ]),
  reason: Schema.String,
};

const PostureFinding = exact<PostureFinding>()(Schema.Struct(postureFindingFields));

const PostureDismissal = exact<PostureDismissal>()(
  Schema.Struct({
    resourceId: Schema.String,
    ruleId: Schema.String,
    dismissedAt: Schema.String,
    dismissedBy: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
  }),
);

const DismissedPostureFinding = exact<DismissedPostureFinding>()(
  Schema.Struct({ ...postureFindingFields, dismissal: PostureDismissal }),
);

export const PostureListResponse = exact<PostureListResponseType>()(
  Schema.Struct({
    findings: Schema.mutable(Schema.Array(PostureFinding)),
    totalCount: Schema.Int,
    counts: Schema.Struct({
      critical: Schema.Int,
      high: Schema.Int,
      medium: Schema.Int,
      low: Schema.Int,
    }),
    dismissed: Schema.mutable(Schema.Array(DismissedPostureFinding)),
    dismissedCount: Schema.Int,
    leakedCredentials: Schema.optionalKey(
      Schema.Struct({ open: Schema.Int, matched: Schema.Int, scanners: Schema.Int }),
    ),
    generatedAt: Schema.String,
  }),
);

const FindingKey = { resourceId: Schema.String, ruleId: Schema.String };

export class LocalPostureRpcs extends RpcGroup.make(
  Rpc.make("LocalPostureList", { success: PostureListResponse, error: LocalWorkspaceError }),
  /** Accept a finding, or rewrite its note; answers the note as stored. */
  Rpc.make("LocalPostureDismiss", {
    payload: { ...FindingKey, reason: Schema.String },
    success: Schema.NullOr(Schema.String),
    error: LocalWorkspaceError,
  }),
  /** Undo a dismissal; answers whether there was one. */
  Rpc.make("LocalPostureRestore", {
    payload: FindingKey,
    success: Schema.Boolean,
    error: LocalWorkspaceError,
  }),
) {}
