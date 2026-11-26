/** A file with, beside each run of lines, the commit that last changed them. */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BlameRange } from "@infrawrench/git-contract";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { ButtonLink } from "../../components/Button";
import { CodeView } from "../../components/CodeView";
import { Icon } from "../../components/icons";
import { Page, Panel, PanelHeader } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { QueryView } from "../../components/states";
import { formatBytes, plural } from "../../lib/format";
import { languageOfPath } from "../../lib/highlight";
import { paths } from "../../lib/paths";
import { useRepoRef } from "../../layout/RepoLayout";
import { useLineSelection } from "./BlobPage";
import { CodeRefPicker, PathBreadcrumbs } from "./shared";
import { showBidi } from "../../lib/bidi";

export function BlamePage({ refName, path }: { refName: string; path: string }) {
  const repo = useRepoRef();
  const blame = useQuery(queries.contents.blame({ params: repo, query: { ref: refName, path } }));
  const { selected, select } = useLineSelection(blame.data !== undefined);

  // The range that starts at each line, so the gutter draws one cell per range.
  const startOf = useMemo(() => {
    const starts = new Map<number, BlameRange>();
    for (const range of blame.data?.ranges ?? []) starts.set(range.startLine, range);
    return starts;
  }, [blame.data]);

  return (
    <Page>
      <QueryView query={blame}>
        {(data) => (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <CodeRefPicker
                repo={repo}
                resolved={data.ref}
                to={(name) => paths.blame(repo, name, path)}
              />
              <PathBreadcrumbs repo={repo} refName={data.ref.name} path={path} />
            </div>
            <Panel>
              <PanelHeader
                actions={
                  <>
                    <ButtonLink size="sm" href={paths.blob(repo, data.ref.name, path)}>
                      Code
                    </ButtonLink>
                    <ButtonLink size="sm" href={paths.commits(repo, data.ref.name, path)}>
                      <Icon name="history" size={12} />
                      History
                    </ButtonLink>
                  </>
                }
              >
                <span className="font-medium text-on-surface">Blame</span>
                <span>
                  {data.blob.lineCount !== null ? `${plural(data.blob.lineCount, "line")} · ` : ""}
                  {formatBytes(data.blob.size)}
                </span>
              </PanelHeader>
              <CodeView
                text={data.blob.text ?? ""}
                language={languageOfPath(path)}
                selected={selected}
                onSelectLine={select}
                label={`Blame of ${data.blob.name}`}
                gutter={(line) => {
                  const range = startOf.get(line);
                  if (!range) return null;
                  const commit = data.commits[range.commitOid];
                  return (
                    <td
                      rowSpan={range.lineCount}
                      className="w-72 max-w-72 border-r border-t border-border bg-surface-inset px-2 align-top font-sans"
                    >
                      {commit ? (
                        <div className="flex items-center gap-2 text-[11px] leading-5">
                          <AppLink
                            href={paths.commit(repo, commit.oid)}
                            title={`${showBidi(commit.summary)}\n${commit.author.name}`}
                            className="min-w-0 flex-1 truncate text-on-surface-secondary hover:underline"
                          >
                            {showBidi(commit.summary)}
                          </AppLink>
                          <RelativeTime
                            iso={commit.author.when}
                            className="whitespace-nowrap text-on-surface-faint"
                          />
                          {range.previousCommitOid !== null ? (
                            <AppLink
                              href={paths.blame(repo, range.previousCommitOid, range.originalPath)}
                              aria-label={`Blame before ${showBidi(commit.summary)}`}
                              title="Blame before this change"
                              className="inline-flex text-on-surface-faint hover:text-on-surface"
                            >
                              <Icon name="history" size={12} />
                            </AppLink>
                          ) : (
                            <span className="w-3" />
                          )}
                        </div>
                      ) : null}
                    </td>
                  );
                }}
              />
            </Panel>
          </>
        )}
      </QueryView>
    </Page>
  );
}
