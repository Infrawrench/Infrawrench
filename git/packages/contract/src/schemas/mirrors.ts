/** Push mirrors: another Git host kept equal to a repository here. */
import { Schema } from "effect";
import { IsoDateTime } from "./common";
import { UserRef } from "./people";

export const MIRROR_LIMITS = {
  /** Mirrors one repository may have. */
  maxMirrors: 5,
  maxUrlLength: 500,
  maxUsernameLength: 100,
  maxCredentialLength: 2000,
  maxExcludePatterns: 50,
  maxPatternLength: 200,
} as const;

const ExcludePatterns = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MIRROR_LIMITS.maxPatternLength)),
)
  .check(Schema.isMaxLength(MIRROR_LIMITS.maxExcludePatterns))
  .annotate({
    description:
      "Refs left alone on both sides: not pushed, and not deleted from the target. `*` matches within a path segment and `**` across segments. A pattern that starts with `refs/` is matched against the whole ref name; any other against the short name of a branch or a tag (`dependabot/**`, `v0.*`).",
  });

export const MirrorStatus = Schema.Literals(["ok", "error"]).annotate({
  identifier: "MirrorStatus",
});
export type MirrorStatus = typeof MirrorStatus.Type;

export const MirrorResult = Schema.Struct({
  created: Schema.Finite,
  updated: Schema.Finite,
  deleted: Schema.Finite,
  refused: Schema.Array(Schema.Struct({ ref: Schema.String, reason: Schema.String })).annotate({
    description:
      "Refs the target refused, or that differ and were left alone, with why. At most fifty.",
  }),
  refs: Schema.Array(Schema.String).annotate({
    description: "The refs that moved, at most fifty of them.",
  }),
}).annotate({ identifier: "MirrorResult" });
export type MirrorResult = typeof MirrorResult.Type;

export const Mirror = Schema.Struct({
  id: Schema.String,
  url: Schema.String.annotate({
    description: "The target repository's HTTPS address. It never holds a credential.",
  }),
  username: Schema.String.annotate({
    description: "The user the credential is sent with, as HTTP Basic.",
  }),
  exclude: ExcludePatterns,
  force: Schema.Boolean.annotate({
    description:
      "True: the target is made equal, overwriting and deleting its branches and tags. False: branches and tags are only created and fast-forwarded.",
  }),
  enabled: Schema.Boolean,
  pending: Schema.Boolean.annotate({
    description: "A run is owed: something was pushed, or changed, since the last one finished.",
  }),
  running: Schema.Boolean,
  lastStatus: Schema.NullOr(MirrorStatus),
  lastError: Schema.NullOr(Schema.String),
  lastResult: Schema.NullOr(MirrorResult),
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  lastSyncedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When a run last left the target equal to this repository.",
  }),
  nextAttemptAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When a failing mirror is tried again. Null when no retry is waiting.",
  }),
  addedBy: Schema.NullOr(UserRef),
  createdAt: IsoDateTime,
}).annotate({ identifier: "Mirror" });
export type Mirror = typeof Mirror.Type;

const Url = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MIRROR_LIMITS.maxUrlLength),
).annotate({
  description:
    "`https://host/path.git`, a public address, with no user, password, query or fragment.",
});
const Username = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MIRROR_LIMITS.maxUsernameLength),
);
const Credential = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MIRROR_LIMITS.maxCredentialLength),
).annotate({
  description:
    "A token the target takes as the password of HTTP Basic. Stored sealed and never returned.",
});

export const MirrorCreate = Schema.Struct({
  url: Url,
  username: Schema.optionalKey(
    Username.annotate({ description: "Default `x-access-token`, which GitHub takes for a token." }),
  ),
  credential: Credential,
  exclude: Schema.optionalKey(ExcludePatterns),
  force: Schema.optionalKey(Schema.Boolean.annotate({ description: "Default true." })),
}).annotate({ identifier: "MirrorCreate" });
export type MirrorCreate = typeof MirrorCreate.Type;

export const MirrorUpdate = Schema.Struct({
  url: Schema.optionalKey(Url),
  username: Schema.optionalKey(Username),
  credential: Schema.optionalKey(
    Credential.annotate({ description: "A new credential. Left out, the stored one is kept." }),
  ),
  exclude: Schema.optionalKey(ExcludePatterns),
  force: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "MirrorUpdate" });
export type MirrorUpdate = typeof MirrorUpdate.Type;
