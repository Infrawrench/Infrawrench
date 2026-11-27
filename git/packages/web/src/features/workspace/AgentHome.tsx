/**
 * Home: how many branches are active, where work was pushed lately, the
 * reader's own branches beside everyone else's, the ones suggested for their
 * review, and what happened. A reader with nothing of their own here is sent
 * to Explore.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ActivityEvent, WorkspaceHome } from "@infrawrench/git-contract";
import { queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { ButtonLink, buttonClass } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Menu } from "../../components/Menu";
import { Avatar, ShortAge } from "../../components/people";
import { EmptyState, ErrorState, Loading, Skeleton } from "../../components/states";
import { showBidi } from "../../lib/bidi";
import { plural } from "../../lib/format";
import { useSession } from "../../lib/session";
import { paths } from "../../lib/paths";
import { TopBar } from "../../layout/TopBar";
import { type Workspace, useWorkspaces } from "../../layout/workspace";
import { AvatarStack, ChangeRow, SuggestedRow, WorkCard, personOf } from "./rows";
import { activityActor, activityVerb, headline, pushedSentence, windowLabel } from "./sentences";

const WINDOWS = [1, 7, 30] as const;
type Days = (typeof WINDOWS)[number];

function RangePicker({ days, onChange }: { days: Days; onChange: (days: Days) => void }) {
  return (
    <Menu
      label="Range"
      align="end"
      trigger={({ props }) => (
        <button
          {...props}
          type="button"
          aria-haspopup="menu"
          aria-label={`Range: ${windowLabel(days)}`}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-on-surface-secondary hover:bg-surface-sunken"
        >
          {windowLabel(days)}
          <Icon name="chevronsUpDown" size={13} className="text-on-surface-muted" />
        </button>
      )}
      items={WINDOWS.map((value) => ({
        label: windowLabel(value),
        checked: value === days,
        onSelect: () => onChange(value),
      }))}
    />
  );
}

/** Agents at work, the bar's one live number. Nothing when none is. */
function AgentsWorking({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-2 border-l border-border pl-4 text-sm text-on-surface-secondary">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-notice" />
      {plural(count, "agent")} working
    </span>
  );
}

// The gutters are the bar's, so the page starts under its name at every width.
const section = "border-b border-border px-4 py-8 md:px-10 md:py-10";
const column = "mx-auto w-full max-w-[1640px]";

const SeeAll = ({ href, children }: { href: string; children: string }) => (
  <AppLink href={href} className="text-sm text-on-surface-muted hover:text-on-surface">
    {children}
  </AppLink>
);

function Activity({ events }: { events: ReadonlyArray<ActivityEvent> }) {
  return (
    <section aria-labelledby="workspace-activity" className="px-4 py-8 md:px-10 md:py-10">
      <div className={column}>
        <h2
          id="workspace-activity"
          className="flex items-center gap-2 text-sm font-medium text-on-surface"
        >
          <Icon name="zap" size={15} filled />
          Workspace activity
        </h2>
        {events.length === 0 ? (
          <p className="mt-4 text-sm text-on-surface-muted">Nothing yet</p>
        ) : (
          <ul className="mt-5 space-y-4">
            {events.map((event) => {
              const repo = { owner: event.repository.owner, repo: event.repository.name };
              const actor = activityActor(event);
              const person = personOf(event.actor);
              const byAgent = event.type === "findings" || event.agent !== null;
              return (
                <li key={event.id} className="flex items-center gap-2.5 text-sm">
                  <AvatarStack
                    people={[byAgent || person === null ? { name: actor, agent: true } : person]}
                  />
                  <p className="min-w-0 truncate text-on-surface-muted">
                    <span className="font-medium text-on-surface">{actor}</span>{" "}
                    {activityVerb(event)}{" "}
                    <AppLink
                      href={paths.branchPage(repo, event.key)}
                      className="font-medium text-on-surface hover:underline"
                    >
                      {showBidi(event.title)}
                    </AppLink>
                  </p>
                  <ShortAge iso={event.at} className="shrink-0 text-xs text-on-surface-faint" />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Two cards side by side once each has room for a row's title and its line of text. */
const cards = "grid gap-8 2xl:grid-cols-2";

/** The page's outline while it loads: the lead, the two cards, the suggestions. */
function HomeSkeleton() {
  return (
    <>
      <div className={section}>
        <div className={`${column} space-y-4`} role="status" aria-label="Loading">
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="h-10 w-2/5" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </div>
      <div className={section} aria-hidden="true">
        <div className={`${column} ${cards}`}>
          <Loading count={4} />
          <Loading count={4} />
        </div>
      </div>
      <div className={section} aria-hidden="true">
        <div className={column}>
          <Loading count={5} />
        </div>
      </div>
    </>
  );
}

function Lead({ home, workspace }: { home: WorkspaceHome; workspace: Workspace }) {
  return (
    <div className={section}>
      <div className={`${column} flex items-start justify-between gap-6`}>
        <div className="min-w-0">
          <Avatar
            name={workspace.name}
            src={workspace.avatarUrl}
            size={40}
            square={workspace.kind === "org"}
          />
          <h2 className="mt-5 text-4xl leading-tight font-semibold tracking-tight text-on-surface md:text-[2.75rem]">
            {headline(home)}
          </h2>
          <p className="mt-2.5 text-[15px] text-on-surface-secondary">{pushedSentence(home)}</p>
        </div>
        <div className="shrink-0">
          <StartWork workspace={workspace} />
        </div>
      </div>
    </div>
  );
}

/**
 * Start work on a new branch: straight to the one repository's form, or a
 * menu of them when the workspace has several. A workspace with none offers
 * a repository first.
 */
function StartWork({ workspace }: { workspace: Workspace }) {
  const open = workspace.repositories.filter((repository) => !repository.archived);
  const only = open.length === 1 ? open[0] : undefined;
  if (open.length === 0) {
    return (
      <ButtonLink variant="primary" href={paths.newRepository(workspace.slug)}>
        New repository
      </ButtonLink>
    );
  }
  if (only !== undefined) {
    return (
      <ButtonLink
        variant="primary"
        href={paths.startWork({ owner: only.owner.slug, repo: only.name })}
      >
        Start work
      </ButtonLink>
    );
  }
  return (
    <Menu
      label="Start work in"
      align="end"
      header="Start work in"
      items={open.map((repository) => ({
        label: repository.name,
        href: paths.startWork({ owner: repository.owner.slug, repo: repository.name }),
      }))}
      trigger={({ props }) => (
        <button
          {...props}
          type="button"
          aria-haspopup="menu"
          className={buttonClass("primary", "md", "gap-1.5")}
        >
          Start work
          <Icon name="chevronDown" size={13} />
        </button>
      )}
    />
  );
}

/** `/`: the workspace's home for a member, Explore for anyone else. */
export function HomePage() {
  const session = useSession();
  const go = useGo();
  const member = session.data?.user != null && session.data.user.username !== null;
  const known = session.data !== undefined;
  useEffect(() => {
    if (known && !member) go(paths.explore(), { replace: true });
  }, [known, member, go]);
  return member ? <AgentHome /> : <Loading shape="page" />;
}

export function AgentHome() {
  const [days, setDays] = useState<Days>(7);
  const { workspaces, current } = useWorkspaces();
  const home = useQuery({
    ...queries.workspace.home({
      query: { namespace: current?.slug ?? "", days: String(days) as "1" | "7" | "30" },
    }),
    enabled: current !== null,
    placeholderData: (previous) => previous,
  });
  const data = home.data;
  return (
    <>
      <TopBar
        title="Home"
        actions={
          <>
            <RangePicker days={days} onChange={setDays} />
            {data !== undefined ? <AgentsWorking count={data.agentsWorking} /> : null}
          </>
        }
      />
      {workspaces !== undefined && current === null ? (
        <EmptyState action={<ButtonLink href={paths.newRepository()}>New repository</ButtonLink>}>
          No repositories yet
        </EmptyState>
      ) : home.error ? (
        <div className="p-10">
          <ErrorState error={home.error} />
        </div>
      ) : data === undefined || current === null ? (
        <HomeSkeleton />
      ) : (
        <>
          <Lead home={data} workspace={current} />
          <div className={section}>
            <div className={`${column} ${cards}`}>
              <WorkCard
                title="Your changes"
                label="Your changes"
                count={data.yours.count}
                action={<SeeAll href={paths.changes({ author: "mine" })}>See all</SeeAll>}
                {...(data.yours.items.length === 0
                  ? { empty: <EmptyState>No open branches of yours</EmptyState> }
                  : {})}
              >
                {data.yours.items.map((change) => (
                  <ChangeRow key={`${change.repository.id}:${change.key}`} change={change} />
                ))}
              </WorkCard>
              <WorkCard
                title="Team changes"
                label="Team changes"
                count={data.team.count}
                action={<SeeAll href={paths.changes({ author: "team" })}>See all</SeeAll>}
                {...(data.team.items.length === 0
                  ? { empty: <EmptyState>No open branches from anyone else</EmptyState> }
                  : {})}
              >
                {data.team.items.map((change) => (
                  <ChangeRow key={`${change.repository.id}:${change.key}`} change={change} />
                ))}
              </WorkCard>
            </div>
          </div>
          <div className={section}>
            <div className={column}>
              <WorkCard
                title="Suggested for your review"
                label="Suggested for your review"
                count={data.suggested.count}
                action={<SeeAll href={paths.reviews()}>Go to Reviews</SeeAll>}
                {...(data.suggested.items.length === 0
                  ? { empty: <EmptyState>Nothing to review</EmptyState> }
                  : {})}
              >
                {data.suggested.items.map((change) => (
                  <SuggestedRow key={`${change.repository.id}:${change.key}`} change={change} />
                ))}
              </WorkCard>
            </div>
          </div>
          <Activity events={data.activity} />
        </>
      )}
    </>
  );
}
