import { useQuery } from "@tanstack/react-query";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Icon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Panel, PanelHeader } from "../../components/Panel";
import { Loading } from "../../components/states";
import { paths, type RepoRef } from "../../lib/paths";
import { rawUrl } from "../../lib/raw";
import { resolveRelative } from "../../lib/refs";

export const isMarkdownPath = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);

/**
 * A Markdown file rendered in place: relative links go to the file they name
 * at the same commit, relative images to its bytes.
 */
export function RenderedMarkdown({
  repo,
  at,
  path,
  source,
}: {
  repo: RepoRef;
  /** The ref or commit the file was read at. */
  at: string;
  path: string;
  source: string;
}) {
  return (
    <Markdown
      source={source}
      resolveLink={(href) => {
        const target = resolveRelative(path, href);
        if (target === null) return null;
        const hash = href.includes("#") ? href.slice(href.indexOf("#")) : "";
        return (target === "" ? paths.tree(repo, at) : paths.blob(repo, at, target)) + hash;
      }}
      resolveImage={(src) => {
        const target = resolveRelative(path, src);
        return target === null || target === "" ? null : rawUrl(repo, at, target);
      }}
    />
  );
}

/** The README under a file table. */
export function ReadmePanel({
  repo,
  commitOid,
  path,
}: {
  repo: RepoRef;
  commitOid: string;
  path: string;
}) {
  const blob = useQuery(queries.contents.blob({ params: repo, query: { ref: commitOid, path } }));
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <Panel>
      <PanelHeader>
        <Icon name="book" />
        <AppLink
          href={paths.blob(repo, commitOid, path)}
          className="font-medium text-on-surface hover:underline"
        >
          {name}
        </AppLink>
      </PanelHeader>
      {blob.data === undefined ? (
        blob.error ? null : (
          <Loading />
        )
      ) : blob.data.text === null ? null : (
        <div className="px-6 py-5">
          {isMarkdownPath(path) ? (
            <RenderedMarkdown repo={repo} at={commitOid} path={path} source={blob.data.text} />
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-on-surface">
              {blob.data.text}
            </pre>
          )}
        </div>
      )}
    </Panel>
  );
}
