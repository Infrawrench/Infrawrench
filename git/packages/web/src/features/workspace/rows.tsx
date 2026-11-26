/**
 * The one-line row every list of work is made of: a state icon, a title, an
 * optional short commit id, a summary that takes the room left, then chips,
 * the people behind it and its age. The whole row is the link.
 */
import type { ReactNode } from "react";
import type {
  ChangeState,
  ChangeSummary,
  SuggestedReview,
  UserRef,
} from "@infrawrench/git-contract";
import { AppLink } from "../../components/AppLink";
import { Icon, type IconName } from "../../components/icons";
import { Avatar, ShortAge } from "../../components/people";
import { showBidi } from "../../lib/bidi";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import { CHANGE_STATE_LABEL, reasonText, reviewTime } from "./sentences";

const STATE_ICON: Record<ChangeState, { icon: IconName; tone: string }> = {
  agent_working: { icon: "bot", tone: "text-notice" },
  needs_review: { icon: "circleChevronUp", tone: "text-on-surface-secondary" },
  changes_requested: { icon: "contrast", tone: "text-warning" },
  approved: { icon: "checkCircle", tone: "text-success" },
  merged: { icon: "gitMerge", tone: "text-notice" },
  closed: { icon: "circleSlash", tone: "text-on-surface-muted" },
};

/** A branch's state as a glyph in the state's colour. A draft nobody is on is a dashed ring. */
export function ChangeStateIcon({
  state,
  draft = false,
  size = 16,
}: {
  state: ChangeState;
  draft?: boolean;
  size?: number;
}) {
  const waiting = draft && state === "needs_review";
  const { icon, tone } = waiting
    ? { icon: "circleDashed" as const, tone: "text-on-surface-muted" }
    : STATE_ICON[state];
  const label = waiting ? "Draft" : CHANGE_STATE_LABEL[state];
  return (
    <span role="img" aria-label={label} title={label} className={`inline-flex shrink-0 ${tone}`}>
      <Icon name={icon} size={size} />
    </span>
  );
}

/** A quiet pill at the end of a row: why it is here, how long it takes. */
export function Chip({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2 py-0.5 text-xs whitespace-nowrap text-on-surface-secondary">
      {icon !== undefined ? <Icon name={icon} size={12} className="text-on-surface-muted" /> : null}
      {children}
    </span>
  );
}

/** A count beside a card's title. */
export function CountChip({ count }: { count: number }) {
  return (
    <span className="rounded bg-surface-sunken px-1.5 py-px text-xs text-on-surface-muted tabular-nums">
      {count}
    </span>
  );
}

export interface RowPerson {
  readonly name: string;
  readonly src?: string | null;
  /** An agent, drawn as a tile with the agent glyph rather than initials. */
  readonly agent?: boolean;
}

/** The people behind a row, overlapped: the newest on top. */
export function AvatarStack({
  people,
  size = 20,
}: {
  people: ReadonlyArray<RowPerson>;
  size?: number;
}) {
  if (people.length === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center -space-x-1.5"
      title={people.map((p) => p.name).join(", ")}
    >
      {people.map((person) => (
        <span key={person.name} className="rounded-full ring-2 ring-surface-raised">
          {person.agent === true ? (
            <span
              aria-hidden="true"
              style={{ width: size, height: size }}
              className="inline-flex items-center justify-center rounded-full bg-surface-sunken text-on-surface-secondary"
            >
              <Icon name="bot" size={Math.round(size * 0.6)} />
            </span>
          ) : (
            <Avatar name={person.name} src={person.src} size={size} />
          )}
        </span>
      ))}
      <span className="sr-only">{people.map((p) => p.name).join(", ")}</span>
    </span>
  );
}

export const personOf = (user: UserRef | null): RowPerson | null =>
  user === null
    ? null
    : { name: user.displayName ?? user.username ?? "Someone", src: user.avatarUrl };

export interface WorkRowProps {
  readonly href: string;
  readonly icon: ReactNode;
  readonly title: string;
  /** A short commit id beside the title. */
  readonly sha?: string | null;
  readonly summary?: ReactNode;
  readonly chips?: ReactNode;
  readonly people?: ReadonlyArray<RowPerson>;
  /** When it last moved. */
  readonly at: string;
}

export function WorkRow({ href, icon, title, sha, summary, chips, people = [], at }: WorkRowProps) {
  return (
    <li className="group relative flex h-11 items-center gap-3 px-5 text-sm hover:bg-surface-inset">
      {icon}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <AppLink
          href={href}
          className="max-w-[60%] shrink-0 truncate font-medium text-on-surface after:absolute after:inset-0"
        >
          {showBidi(title)}
        </AppLink>
        {sha !== undefined && sha !== null ? (
          <code className="shrink-0 rounded bg-surface-sunken px-1.5 py-px font-mono text-xs text-on-surface-secondary">
            {shortOid(sha)}
          </code>
        ) : null}
        {summary !== undefined && summary !== null && summary !== "" ? (
          <>
            <span aria-hidden="true" className="shrink-0 text-on-surface-faint">
              ·
            </span>
            <span className="min-w-0 truncate text-on-surface-muted">{summary}</span>
          </>
        ) : null}
      </div>
      {chips !== undefined ? (
        <div className="hidden shrink-0 items-center gap-2 lg:flex">{chips}</div>
      ) : null}
      <AvatarStack people={people} />
      <ShortAge
        iso={at}
        className="w-8 shrink-0 text-right text-xs text-on-surface-muted tabular-nums"
      />
    </li>
  );
}

const peopleOf = (change: ChangeSummary): RowPerson[] => {
  const author = personOf(change.author);
  return [
    ...(change.agent !== null ? [{ name: change.agent.displayName, agent: true }] : []),
    ...(author !== null ? [author] : []),
  ];
};

/** The repository a row is in, where a list spans several. */
function RepositoryChip({ change }: { change: ChangeSummary }) {
  return <span className="shrink-0 text-xs text-on-surface-muted">{change.repository.name}</span>;
}

export function ChangeRow({
  change,
  chips,
  showRepository = false,
  href,
}: {
  change: ChangeSummary;
  chips?: ReactNode;
  showRepository?: boolean;
  href?: string;
}) {
  const repo = { owner: change.repository.owner, repo: change.repository.name };
  return (
    <WorkRow
      href={href ?? paths.pull(repo, change.number)}
      icon={<ChangeStateIcon state={change.state} draft={change.draft} />}
      title={change.title}
      // Named by nothing but its commits: the commit says which.
      sha={change.summary === null ? change.headOid : null}
      summary={change.summary === null ? null : showBidi(change.summary)}
      chips={
        chips !== undefined || showRepository ? (
          <>
            {chips}
            {showRepository ? <RepositoryChip change={change} /> : null}
          </>
        ) : undefined
      }
      people={peopleOf(change)}
      at={change.updatedAt}
    />
  );
}

export function SuggestedRow({ change }: { change: SuggestedReview }) {
  const repo = { owner: change.repository.owner, repo: change.repository.name };
  const reason = change.reasons[0];
  const words = reason === undefined ? null : reasonText(reason, change.repository.name);
  return (
    <ChangeRow
      change={change}
      // Opens on what is new to them: the newest version against the one they reviewed.
      href={paths.branchPage(
        repo,
        change.number,
        change.reviewedVersion === null || change.latestVersion === null
          ? {}
          : { v: change.latestVersion, diff: "since" },
      )}
      chips={
        <>
          {words !== null ? (
            <Chip icon="lightbulb">
              <span>
                {words.text}
                {words.strong !== null ? (
                  <>
                    {" "}
                    <span className="font-medium text-on-surface">{words.strong}</span>
                  </>
                ) : null}
              </span>
            </Chip>
          ) : null}
          <Chip>
            <Icon name="clock" size={12} className="text-on-surface-muted" />
            {reviewTime(change.size)}
          </Chip>
        </>
      }
    />
  );
}

/** A bordered list of rows with a title row: the home page's cards, and each list page. */
export function WorkCard({
  title,
  count,
  action,
  label,
  children,
  empty,
}: {
  title?: string;
  count?: number;
  action?: ReactNode;
  /** Names the list for a screen reader. */
  label: string;
  children: ReactNode;
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="overflow-hidden rounded-lg border border-border bg-surface-raised"
    >
      {title !== undefined ? (
        <header className="flex h-12 items-center gap-2.5 border-b border-border px-5">
          <h2 className="text-sm font-medium text-on-surface">{title}</h2>
          {count !== undefined ? <CountChip count={count} /> : null}
          <div className="flex-1" />
          {action}
        </header>
      ) : null}
      {empty !== undefined ? (
        empty
      ) : (
        <ul aria-label={label} className="divide-y divide-border">
          {children}
        </ul>
      )}
    </section>
  );
}
