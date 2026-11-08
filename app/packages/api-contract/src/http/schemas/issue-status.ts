/**
 * Live status of filed issues: the schema pieces the Jira, Linear and GitHub
 * issue links share (`issue-status.ts` in client-core is the contract), plus
 * the checks the three tracker domains have in common.
 */
import { Schema } from "effect";
import { IsoDateTime } from "./common";

export const IssueStatusCategory = Schema.Literals([
  "todo",
  "in_progress",
  "done",
  "canceled",
]).annotate({
  identifier: "IssueStatusCategory",
  description:
    "Tracker-neutral progress. Jira's status category, Linear's workflow state type, and GitHub's state and close reason all map onto these four.",
});

/** The status columns on every issue link. Null until the first sync. */
export const issueStatusFields = {
  status: Schema.NullOr(Schema.String).annotate({
    description: "The tracker's own status name, e.g. `In Progress`, `Backlog`, `Closed`.",
    examples: ["In Progress"],
  }),
  statusCategory: Schema.NullOr(IssueStatusCategory),
  assignee: Schema.NullOr(Schema.String).annotate({
    description: "Assignee display name (Jira, Linear) or login (GitHub).",
  }),
  issueUpdatedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the issue last changed, as the tracker reports it.",
  }),
  statusSyncedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When Infrawrench last learned the status, by webhook or poll.",
  }),
};

export const IssueWebhookState = Schema.Struct({
  mode: Schema.NullOr(Schema.Literals(["registered", "manual"])).annotate({
    description:
      "`registered`: created in the tracker by Infrawrench. `manual`: created by a person with the URL and secret from here. Null: no webhook; statuses come from the poll.",
  }),
  url: Schema.NullOr(Schema.String).annotate({
    description: "The receiver URL the tracker posts to.",
  }),
  lastDeliveryAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the last correctly signed delivery arrived.",
  }),
}).annotate({ identifier: "IssueWebhookState" });

export const IssueWebhookSetupResult = Schema.Struct({
  webhook: IssueWebhookState,
  secret: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Jira manual mode only: the signing secret to paste into Jira's webhook form. Returned this once; it is stored encrypted and never read back.",
    }),
  ),
  fallbackReason: Schema.optionalKey(
    Schema.String.annotate({ description: "Why automatic registration fell back to manual." }),
  ),
}).annotate({ identifier: "IssueWebhookSetupResult" });

export const IssueStatusRefreshResult = Schema.Struct({
  checked: Schema.Int.annotate({ description: "Links the tracker was asked about." }),
  changed: Schema.Int.annotate({ description: "Links whose status, assignee or time moved." }),
}).annotate({ identifier: "IssueStatusRefreshResult" });

// Zod's `.email()` pattern, which the tracker routes validated with.
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

/** An email address, checked as the routes' zod `.email()` checked it. */
export const isEmail = Schema.makeFilter<string>(
  (value) => EMAIL_PATTERN.test(value) || "Invalid email",
  { toJsonSchema: () => ({ format: "email" }) },
);

/** An absolute URL, checked as zod's `.url()` checked it (`new URL` parses it). */
export const isUrl = Schema.makeFilter<string>((value) => URL.canParse(value) || "Invalid url", {
  toJsonSchema: () => ({ format: "uri" }),
});
