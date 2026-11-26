/**
 * A thread's timeline, oldest first: comments, the events between them, and
 * for a pull request the commits pushed to it and its reviews (drawn by the
 * pull request page through `renderReview`).
 */
import type { ReactNode } from "react";
import type { TimelineItem } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { CommitStatusIcon } from "../../components/Badge";
import { Icon, type IconName } from "../../components/icons";
import { LabelChip } from "../../components/LabelChip";
import { RelativeTime, UserLink } from "../../components/people";
import { ErrorState, Loading, LoadMore } from "../../components/states";
import { ThreadStateIcon, pullKind } from "../../components/StatusIcons";
import { useRepoRef } from "../../layout/RepoLayout";
import { shortOid } from "../../lib/format";
import { paths, type RepoRef } from "../../lib/paths";
import { terraformEventSentence } from "../infrastructure/PlanSummary";
import { CommentCard } from "./CommentCard";
import { threadSearchHref } from "./ThreadList";
import { cursorQuery } from "../../lib/cursor";
import { showBidi } from "../../lib/bidi";

type ReviewItem = Extract<TimelineItem, { type: "review" }>;
type TerraformRunItem = Extract<TimelineItem, { type: "terraform_run" }>;
type EventItem = Exclude<
  TimelineItem,
  { type: "comment" | "review" | "commits" | "terraform_run" }
>;

const code = "rounded bg-surface-sunken px-1 py-px font-mono text-[11px] text-on-surface";

function CommitLink({ repo, oid }: { repo: RepoRef; oid: string }) {
  return (
    <AppLink href={paths.commit(repo, oid)} className={`${code} hover:underline`}>
      {shortOid(oid)}
    </AppLink>
  );
}

/** The glyph and the sentence of an event, or null for one this build does not know. */
function describe(
  item: EventItem,
  repo: RepoRef,
  kind: "issues" | "pulls",
): { icon: IconName; tone?: string; text: ReactNode } | null {
  const sameActor = (user: { id: string } | null) =>
    user !== null && item.actor !== null && user.id === item.actor.id;
  switch (item.type) {
    case "labeled":
    case "unlabeled":
      return {
        icon: "tag",
        text: (
          <>
            {item.type === "labeled" ? "added the" : "removed the"}{" "}
            <LabelChip
              label={item.label}
              href={threadSearchHref(repo, kind, { labels: [item.label.name] })}
            />{" "}
            label
          </>
        ),
      };
    case "assigned":
    case "unassigned":
      return {
        icon: "user",
        text: sameActor(item.assignee) ? (
          item.type === "assigned" ? (
            "self-assigned this"
          ) : (
            "removed their assignment"
          )
        ) : (
          <>
            {item.type === "assigned" ? "assigned" : "unassigned"}{" "}
            {item.assignee !== null ? <UserLink user={item.assignee} /> : "someone"}
          </>
        ),
      };
    case "milestoned":
    case "demilestoned":
      return {
        icon: "milestone",
        text: (
          <>
            {item.type === "milestoned" ? "added this to the" : "removed this from the"}{" "}
            <span className="font-medium text-on-surface">{item.milestoneTitle}</span> milestone
          </>
        ),
      };
    case "renamed":
      return {
        icon: "pencil",
        text: (
          <>
            changed the title from <s>{item.from}</s> to{" "}
            <span className="font-medium text-on-surface">{item.to}</span>
          </>
        ),
      };
    case "closed":
      return {
        icon: item.stateReason === "not_planned" ? "circleSlash" : "checkCircle",
        tone: item.stateReason === "not_planned" ? "text-on-surface-muted" : "text-notice",
        text: (
          <>
            closed this
            {item.stateReason === "not_planned"
              ? " as not planned"
              : item.stateReason === "completed"
                ? " as completed"
                : ""}
            {item.commitOid !== null ? (
              <>
                {" "}
                in <CommitLink repo={repo} oid={item.commitOid} />
              </>
            ) : null}
          </>
        ),
      };
    case "reopened":
      return { icon: "circleDot", tone: "text-success", text: "reopened this" };
    case "locked":
      return {
        icon: "lock",
        text: item.reason === null ? "locked the conversation" : `locked this as ${item.reason}`,
      };
    case "unlocked":
      return { icon: "unlock", text: "unlocked the conversation" };
    case "referenced":
      return {
        icon: "gitCommit",
        text: (
          <>
            referenced this in{" "}
            <AppLink
              href={paths.commit(repo, item.commit.oid)}
              className="text-on-surface hover:underline"
            >
              {showBidi(item.commit.summary)}
            </AppLink>{" "}
            <CommitLink repo={repo} oid={item.commit.oid} />
          </>
        ),
      };
    case "cross_referenced": {
      const source = item.source;
      const target = { owner: source.repository.owner, repo: source.repository.name };
      return {
        icon: "link",
        text: (
          <>
            mentioned this in{" "}
            <span className="inline-flex items-center gap-1 align-middle">
              {source.isPullRequest ? (
                <ThreadStateIcon kind={pullKind(source.state, false)} size={12} />
              ) : null}
              <AppLink
                href={
                  source.isPullRequest
                    ? paths.pull(target, source.number)
                    : paths.issue(target, source.number)
                }
                className="font-medium text-on-surface hover:underline"
              >
                {source.title}
              </AppLink>
              <span>#{source.number}</span>
            </span>
          </>
        ),
      };
    }
    case "merged":
      return {
        icon: "gitMerge",
        tone: "text-notice",
        text: (
          <>
            merged commit <CommitLink repo={repo} oid={item.commitOid} /> into{" "}
            <span className={code}>{item.baseRef}</span>
          </>
        ),
      };
    case "head_force_pushed":
      return {
        icon: "gitCommit",
        text: (
          <>
            force-pushed from <CommitLink repo={repo} oid={item.beforeOid} /> to{" "}
            <CommitLink repo={repo} oid={item.afterOid} />
          </>
        ),
      };
    case "head_branch_deleted":
    case "head_branch_restored":
      return {
        icon: "gitBranch",
        text: (
          <>
            {item.type === "head_branch_deleted" ? "deleted" : "restored"} the{" "}
            <span className={code}>{item.ref}</span> branch
          </>
        ),
      };
    case "base_changed":
      return {
        icon: "gitBranch",
        text: (
          <>
            changed the base from <span className={code}>{item.from}</span> to{" "}
            <span className={code}>{item.to}</span>
          </>
        ),
      };
    case "ready_for_review":
      return { icon: "eye", text: "marked this as ready for review" };
    case "converted_to_draft":
      return { icon: "gitPullRequestDraft", text: "marked this as a draft" };
    case "review_dismissed":
      return {
        icon: "x",
        text: (
          <>
            dismissed a review
            {item.reason !== null && item.reason !== "" ? (
              <span className="text-on-surface-secondary">: {item.reason}</span>
            ) : null}
          </>
        ),
      };
    default:
      return null;
  }
}

/** The rail every entry between comments hangs on: a glyph in a disc, then its line. */
export function TimelineRow({
  icon,
  tone = "text-on-surface-muted",
  children,
}: {
  icon: IconName;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 sm:pl-10">
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-raised ${tone}`}
      >
        <Icon name={icon} size={12} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5 text-xs leading-5 text-on-surface-muted">
        {children}
      </div>
    </div>
  );
}

function EventRow({ item, kind }: { item: EventItem; kind: "issues" | "pulls" }) {
  const repo = useRepoRef();
  const described = describe(item, repo, kind);
  if (described === null) return null;
  return (
    <TimelineRow icon={described.icon} {...(described.tone ? { tone: described.tone } : {})}>
      {item.actor !== null ? <UserLink user={item.actor} /> : <span>Someone</span>} {described.text}{" "}
      <RelativeTime iso={item.createdAt} />
    </TimelineRow>
  );
}

const TERRAFORM_TONE = {
  success: "text-success",
  danger: "text-danger",
  neutral: "text-on-surface-muted",
} as const;

/** A Terraform run of the pull request: the workspace, linked to the run, and what it reported. */
function TerraformRunRow({ item }: { item: TerraformRunItem }) {
  const repo = useRepoRef();
  const { text, tone } = terraformEventSentence(item);
  return (
    <TimelineRow icon="boxes" tone={TERRAFORM_TONE[tone]}>
      Terraform{" "}
      <AppLink
        href={paths.terraformRun(repo, item.workspace, item.runId)}
        className="font-medium text-on-surface hover:underline"
      >
        {item.workspace}
      </AppLink>{" "}
      <span className={tone === "danger" ? "text-danger" : undefined}>{text}</span>{" "}
      <RelativeTime iso={item.createdAt} />
    </TimelineRow>
  );
}

function CommitsRow({ item }: { item: Extract<TimelineItem, { type: "commits" }> }) {
  const repo = useRepoRef();
  return (
    <ul className="space-y-1" aria-label="Commits pushed">
      {item.commits.map((commit) => (
        <li key={commit.oid}>
          <TimelineRow icon="gitCommit">
            <span className="flex min-w-0 items-center gap-2">
              <AppLink
                href={paths.commit(repo, commit.oid)}
                className="min-w-0 truncate text-on-surface-secondary hover:underline"
              >
                {showBidi(commit.summary)}
              </AppLink>
              <CommitStatusIcon state={commit.status} size={12} />
              <span className="ml-auto shrink-0">
                <CommitLink repo={repo} oid={commit.oid} />
              </span>
            </span>
          </TimelineRow>
        </li>
      ))}
    </ul>
  );
}

export function Timeline({
  number,
  kind,
  renderReview,
}: {
  number: number;
  kind: "issues" | "pulls";
  renderReview?: (item: ReviewItem) => ReactNode;
}) {
  const repo = useRepoRef();
  const request = { params: { ...repo, number } };
  const timeline = usePages(["issues", "timeline", request], (cursor) =>
    api.issues.timeline({ ...request, query: { ...cursorQuery(cursor), limit: 100 } }),
  );
  if (timeline.error) return <ErrorState error={timeline.error} />;
  if (timeline.isLoading) return <Loading shape="text" />;
  const refresh = () => invalidate("issues");
  return (
    <>
      {timeline.items.map((item) => {
        if (item.type === "comment") {
          const { comment } = item;
          return (
            <CommentCard
              key={item.id}
              id={`comment-${comment.id}`}
              author={comment.author}
              createdAt={comment.createdAt}
              body={comment.body}
              edited={comment.edited}
              access={comment.authorAccess}
              canEdit={comment.viewerCanEdit}
              canDelete={comment.viewerCanDelete}
              onSave={(body) =>
                api.issues
                  .updateComment({ params: { ...repo, commentId: comment.id }, payload: { body } })
                  .then(refresh)
              }
              onDelete={() =>
                api.issues
                  .deleteComment({ params: { ...repo, commentId: comment.id } })
                  .then(refresh)
              }
            />
          );
        }
        if (item.type === "commits") return <CommitsRow key={item.id} item={item} />;
        if (item.type === "terraform_run") return <TerraformRunRow key={item.id} item={item} />;
        if (item.type === "review") {
          return renderReview ? <div key={item.id}>{renderReview(item)}</div> : null;
        }
        return <EventRow key={item.id} item={item} kind={kind} />;
      })}
      <LoadMore pages={timeline} />
    </>
  );
}
