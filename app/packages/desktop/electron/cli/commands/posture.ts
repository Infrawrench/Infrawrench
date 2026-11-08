// `infrawrench posture`; plugin-declared security checks over synced
// resources: public buckets, world-open ingress, unencrypted disks, stale
// credentials, missing backup/deletion protection, ranked by severity.
//
// Works in both modes, because the classification is declarative and runs
// over stored state rather than a live provider call:
//   - cloud (default): GET /posture, the same endpoint the web + desktop
//     Posture screens render.
//   - --local: electron/local-posture.ts runs the shared computation over
//     this machine's SQLite workspace. No credentials, no network.
//
// `posture dismiss` / `posture restore` accept and un-accept a finding by
// (resource, rule). Cloud mode records the decision for the organization
// through the API; --local writes this machine's own table.
//
// The response schema is checked against `@infrawrench/client-core` by
// `wire` (the same definition every other surface uses), so a server-side
// change breaks the CLI's build instead of its output, and the CLI still
// ships no new runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type { PostureListResponse, PostureSeverity } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import {
  dismissLocalPostureFinding,
  listLocalPosture,
  restoreLocalPostureFinding,
} from "../../local-posture";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { reason } from "../effect/triage-flags";
import { spreadBody, wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/posture";

const Finding = Schema.Struct({
  // A severity bucket this build does not know renders uncoloured.
  severity: Schema.String,
  displayName: Schema.String,
  resourceTypeName: Schema.String,
  accountName: Schema.String,
  title: Schema.String,
});

const Listing = wire<PostureListResponse>()(
  Schema.Struct({
    findings: Schema.Array(Finding),
    totalCount: Schema.Finite,
    counts: Schema.Struct({
      critical: Schema.Finite,
      high: Schema.Finite,
      medium: Schema.Finite,
      low: Schema.Finite,
    }),
    dismissed: Schema.Array(
      Schema.Struct({
        displayName: Schema.String,
        accountName: Schema.String,
        title: Schema.String,
        dismissal: Schema.Struct({
          dismissedAt: Schema.String,
          dismissedBy: Schema.NullOr(Schema.String),
          reason: Schema.NullOr(Schema.String),
        }),
      }),
    ),
    dismissedCount: Schema.Finite,
  }),
);
type Listing = typeof Listing.Type;

/** Terminal tone per bucket: red = drop everything, yellow = soon, dim = hygiene. */
const SEVERITY_COLOR: Partial<Record<string, (s: string) => string>> = {
  critical: c.red,
  high: c.yellow,
  medium: (s) => s,
  low: c.dim,
} satisfies Record<PostureSeverity, (s: string) => string>;

/** The header's severity tally, e.g. "1 critical · 3 high · 2 medium". */
function countsSummary(response: Listing): string {
  const { counts } = response;
  const parts: string[] = [];
  if (counts.critical > 0) parts.push(c.red(`${counts.critical} critical`));
  if (counts.high > 0) parts.push(c.yellow(`${counts.high} high`));
  if (counts.medium > 0) parts.push(`${counts.medium} medium`);
  if (counts.low > 0) parts.push(c.dim(`${counts.low} low`));
  return parts.join(c.dim(" · "));
}

/**
 * The finding a dismiss/restore names. `--resource` already exists as the
 * "focus one resource" flag; the rule id is the second positional so the pair
 * reads as one thing: `posture dismiss <resourceId> <ruleId>`.
 */
const target = {
  resourceId: Argument.String("resourceId").pipe(
    Argument.withDescription("The resource, as `posture --json` prints it"),
    Argument.optional,
  ),
  ruleId: Argument.String("ruleId").pipe(
    Argument.withDescription("The rule, as `posture --json` prints it"),
    Argument.optional,
  ),
};

const requireTarget = (input: {
  readonly resourceId: Option.Option<string>;
  readonly ruleId: Option.Option<string>;
}) => {
  const resourceId = Option.getOrUndefined(input.resourceId);
  const ruleId = Option.getOrUndefined(input.ruleId);
  if (!resourceId || !ruleId) {
    return Effect.fail(
      new CliUsageError({
        message:
          "Usage: infrawrench posture dismiss|restore <resourceId> <ruleId> [--reason <text>]\n" +
          "Both ids are printed by `infrawrench posture --json`.",
      }),
    );
  }
  return Effect.succeed({ resourceId, ruleId });
};

/** A CLI write while the GUI holds the lock is never persisted: refuse it. */
const refuseWhileGuiRuns = (verb: string) =>
  Effect.gen(function* () {
    const session = yield* CliSession;
    if (session.guiRunning) {
      return yield* new CliFailure({
        message: `The Infrawrench desktop app is running. ${verb} the finding from the app instead; the CLI shares its workspace.`,
      });
    }
  });

/** `infrawrench posture dismiss <resourceId> <ruleId> [--reason ...]`. */
const dismiss = Command.make(
  "dismiss",
  {
    ...target,
    reason: reason({ description: "Why the finding is an accepted risk" }),
  },
  Effect.fn("posture.dismiss")(function* (input) {
    const session = yield* CliSession;
    const { resourceId, ruleId } = yield* requireTarget(input);
    const why = Option.getOrNull(input.reason);

    if (session.local) {
      yield* refuseWhileGuiRuns("Dismiss");
      // Report the note as stored, not as typed: a blank `--reason " "` is
      // persisted as no note, and the JSON has to agree with the next
      // `posture --json`.
      const stored = yield* Effect.promise(() =>
        dismissLocalPostureFinding(resourceId, ruleId, why),
      );
      if (session.output === "json") {
        return yield* Print.json({ dismissed: { resourceId, ruleId, reason: stored } });
      }
      yield* Print.line(`${c.bold("Dismissed")} ${resourceId} ${c.dim(`· ${ruleId}`)}`);
      return yield* Print.line(
        c.dim("Local workspace only. It stays off the list until `posture restore`."),
      );
    }

    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const dismissal = yield* api.json(org.id, "/posture/dismissals", {
      method: "POST",
      body: JSON.stringify({ resourceId, ruleId, reason: why }),
    });
    if (session.output === "json") {
      return yield* Print.json({ org: org.id, dismissed: dismissal });
    }
    yield* Print.line(`${c.bold("Dismissed")} ${resourceId} ${c.dim(`· ${ruleId}`)}`);
    yield* Print.line(
      c.dim(
        `Accepted for ${org.displayName}. It leaves the posture list and the daily alerts until \`posture restore\`.`,
      ),
    );
  }),
).pipe(Command.withDescription("Accept a finding as a known risk"));

/** `infrawrench posture restore <resourceId> <ruleId>`. */
const restore = Command.make(
  "restore",
  target,
  Effect.fn("posture.restore")(function* (input) {
    const session = yield* CliSession;
    const { resourceId, ruleId } = yield* requireTarget(input);

    if (session.local) {
      yield* refuseWhileGuiRuns("Restore");
      const restored = yield* Effect.promise(() => restoreLocalPostureFinding(resourceId, ruleId));
      if (!restored) {
        return yield* new CliFailure({
          message: "That finding is not dismissed in the local workspace.",
        });
      }
      if (session.output === "json") return yield* Print.json({ restored: { resourceId, ruleId } });
      return yield* Print.line(`${c.bold("Restored")} ${resourceId} ${c.dim(`· ${ruleId}`)}`);
    }

    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const query = new URLSearchParams({ resourceId, ruleId });
    yield* api.json(org.id, `/posture/dismissals?${query.toString()}`, { method: "DELETE" });
    if (session.output === "json") {
      return yield* Print.json({ org: org.id, restored: { resourceId, ruleId } });
    }
    yield* Print.line(`${c.bold("Restored")} ${resourceId} ${c.dim(`· ${ruleId}`)}`);
    yield* Print.line(c.dim("Back on the posture list and in the daily alerts."));
  }),
).pipe(Command.withDescription("Put a dismissed finding back on the list"));

/** The scan in scope: the local workspace, or the `--org` org's. */
const loadListing = Effect.fn("posture.load")(function* () {
  const session = yield* CliSession;
  if (session.local) {
    const response = yield* Effect.promise(listLocalPosture);
    return { label: "Local workspace", json: { ...response }, response };
  }
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);
  return {
    label: org.displayName,
    json: yield* spreadBody({ org: org.id }, body, PATH),
    response: yield* decodeBody(Listing, PATH)(body),
  };
});

/**
 * The accepted risks, listed rather than hidden: a silenced finding nobody
 * can see is worse than a noisy one. Never colored by severity: these are
 * decisions, not alarms.
 */
const printDismissed = Effect.fnUntraced(function* (dismissed: Listing["dismissed"]) {
  yield* Print.line();
  yield* Print.line(
    `${c.bold("Dismissed")} ${c.dim(
      `· ${dismissed.length} accepted risk${dismissed.length === 1 ? "" : "s"}`,
    )}`,
  );
  yield* Print.line();
  yield* Print.table(dismissed, [
    { header: "resource", value: (r) => c.dim(r.displayName) },
    { header: "account", value: (r) => c.dim(r.accountName) },
    { header: "finding", value: (r) => c.dim(r.title) },
    {
      header: "accepted",
      value: (r) =>
        c.dim(
          [r.dismissal.dismissedAt.slice(0, 10), r.dismissal.dismissedBy, r.dismissal.reason]
            .filter(Boolean)
            .join(" · "),
        ),
    },
  ]);
  yield* Print.line();
  yield* Print.line(c.dim("Undo with `infrawrench posture restore <resourceId> <ruleId>`."));
});

export const posture = Command.make(
  "posture",
  {},
  Effect.fn("posture")(function* () {
    const session = yield* CliSession;
    const scope = yield* loadListing();
    const { response } = scope;

    if (session.output === "json") return yield* Print.json(scope.json);

    if (response.findings.length === 0) {
      yield* Print.line(
        response.dismissedCount > 0
          ? c.dim(
              "No open findings. Everything currently flagged has been dismissed as an accepted risk.",
            )
          : c.dim(
              "No findings. Checks appear when a plugin declares posture rules over synced fields. A bucket's public-access setting, a firewall's source ranges, a disk's encryption flag.",
            ),
      );
      if (response.dismissedCount > 0) yield* printDismissed(response.dismissed);
      if (session.local) {
        yield* Print.line(
          c.dim("This scan covered the local workspace only; drop --local for your organization."),
        );
      }
      return;
    }

    yield* Print.line(
      `${c.bold(scope.label)} ${c.dim(
        `· ${response.totalCount} finding${response.totalCount === 1 ? "" : "s"}`,
      )}  ${countsSummary(response)}`,
    );
    yield* Print.line();

    // The contract serves findings worst first; the table keeps that order.
    const columns: Column<typeof Finding.Type>[] = [
      {
        header: "severity",
        // Unknown severity buckets from a newer server render uncolored
        // rather than crashing the whole listing.
        value: (r) => (SEVERITY_COLOR[r.severity] ?? ((s: string) => s))(r.severity),
      },
      { header: "resource", value: (r) => r.displayName },
      { header: "type", value: (r) => c.dim(r.resourceTypeName) },
      { header: "account", value: (r) => c.dim(r.accountName) },
      { header: "finding", value: (r) => r.title },
    ];
    yield* Print.table(response.findings, columns);

    if (response.dismissedCount > 0) yield* printDismissed(response.dismissed);

    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Computed from already-synced fields. No provider was contacted. Rules are declared by each plugin; critical & high findings feed the daily posture alerts.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Security checks over synced resources (public buckets, open ingress, unencrypted disks), worst first",
  ),
  Command.withSubcommands([dismiss, restore]),
);
