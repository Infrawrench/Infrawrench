/** Repositories as rows: the list on a namespace's page, explore, and home. */
import type { RepositorySummary } from "@infrawrench/git-contract";
import { compactCount } from "../lib/format";
import { paths } from "../lib/paths";
import { AppLink } from "./AppLink";
import { Badge, LanguageLabel, VisibilityBadge } from "./Badge";
import { Icon } from "./icons";
import { RelativeTime } from "./people";

export function RepoRow({
  repository,
  showOwner = true,
}: {
  repository: RepositorySummary;
  /** Off on a namespace's own page, where every row has the same owner. */
  showOwner?: boolean;
}) {
  const repo = { owner: repository.owner.slug, repo: repository.name };
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <AppLink
          href={paths.repo(repo)}
          className="text-sm font-semibold text-on-surface hover:underline"
        >
          {showOwner ? (
            <span className="font-normal text-on-surface-secondary">{repository.owner.slug}/</span>
          ) : null}
          {repository.name}
        </AppLink>
        <VisibilityBadge visibility={repository.visibility} />
        {repository.archived ? <Badge tone="warning">Archived</Badge> : null}
      </div>
      {repository.parent !== null ? (
        <p className="text-xs text-on-surface-muted">
          Forked from{" "}
          <AppLink
            href={paths.repo({ owner: repository.parent.owner, repo: repository.parent.name })}
            className="hover:underline"
          >
            {repository.parent.owner}/{repository.parent.name}
          </AppLink>
        </p>
      ) : null}
      {repository.description !== null && repository.description !== "" ? (
        <p className="text-xs text-on-surface-secondary">{repository.description}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-muted">
        {repository.primaryLanguage !== null ? (
          <LanguageLabel language={repository.primaryLanguage} />
        ) : null}
        {repository.starCount > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Icon name="star" size={12} />
            <span className="sr-only">Stars:</span>
            {compactCount(repository.starCount)}
          </span>
        ) : null}
        {repository.forkCount > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Icon name="gitFork" size={12} />
            <span className="sr-only">Forks:</span>
            {compactCount(repository.forkCount)}
          </span>
        ) : null}
        {repository.pushedAt !== null ? (
          <span>
            Pushed <RelativeTime iso={repository.pushedAt} />
          </span>
        ) : (
          <span>Nothing pushed</span>
        )}
      </div>
    </li>
  );
}

export function RepoList({
  repositories,
  showOwner,
  label,
}: {
  repositories: ReadonlyArray<RepositorySummary>;
  showOwner?: boolean;
  label: string;
}) {
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {repositories.map((repository) => (
        <RepoRow
          key={repository.id}
          repository={repository}
          {...(showOwner === undefined ? {} : { showOwner })}
        />
      ))}
    </ul>
  );
}
