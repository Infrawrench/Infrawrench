/** A file at a ref: highlighted source with line anchors, or its image, preview or download. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FileBlob } from "@infrawrench/git-contract";
import { ApiError } from "../../api/client";
import { queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { ButtonLink, buttonClass } from "../../components/Button";
import { CodeView } from "../../components/CodeView";
import { CopyButton, Segmented } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page, Panel, PanelHeader } from "../../components/Panel";
import { CommitStripSkeleton, ErrorState } from "../../components/states";
import { formatBytes, plural } from "../../lib/format";
import { languageOfPath } from "../../lib/highlight";
import { formatLineHash, parseLineHash, selectLine, type LineRange } from "../../lib/lines";
import { paths, type RepoRef } from "../../lib/paths";
import { downloadUrl } from "../../lib/raw";
import { resolveRelative } from "../../lib/refs";
import { usePageTitle } from "../../lib/title";
import { useRepoRef } from "../../layout/RepoLayout";
import { CodePageSkeleton } from "./CodePageSkeleton";
import { blobQuery, latestCommitQuery } from "./requests";
import { RenderedMarkdown, isMarkdownPath } from "./ReadmePanel";
import { CodeRefPicker, CommitStrip, PathBreadcrumbs } from "./shared";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;

/** The line selection, kept in the URL hash so a selection is a link. */
export function useLineSelection(ready: boolean) {
  const [selected, setSelected] = useState<LineRange | null>(() =>
    parseLineHash(window.location.hash),
  );

  useEffect(() => {
    const onHash = () => setSelected(parseLineHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Arriving on a link to a line: bring it into view once the file is drawn.
  useEffect(() => {
    if (!ready) return;
    const initial = parseLineHash(window.location.hash);
    if (initial) document.getElementById(`L${initial.start}`)?.scrollIntoView({ block: "center" });
  }, [ready]);

  const latest = useRef(selected);
  latest.current = selected;
  const select = useCallback((line: number, extend: boolean) => {
    const next = selectLine(latest.current, line, extend);
    latest.current = next;
    setSelected(next);
    const url = new URL(window.location.href);
    url.hash = next === null ? "" : formatLineHash(next);
    // Replace, not push: clicking through lines should not fill the history.
    window.history.replaceState(window.history.state, "", url);
  }, []);

  return { selected, select };
}

export function BlobPage({ refName, path }: { refName: string; path: string }) {
  const repo = useRepoRef();
  const go = useGo();
  const blob = useQuery(blobQuery(repo, refName, path));
  usePageTitle(
    blob.data && `${repo.repo}/${blob.data.path} at ${blob.data.ref.name}`,
    `${repo.owner}/${repo.repo}`,
  );

  const isDirectory = blob.error instanceof ApiError && blob.error.code === "not_a_file";
  useEffect(() => {
    if (isDirectory) go(paths.tree(repo, refName, path), { replace: true });
  }, [isDirectory, go, repo.owner, repo.repo, refName, path]);

  if (blob.data === undefined) {
    return blob.error && !isDirectory ? (
      <Page>
        <ErrorState error={blob.error} onRetry={() => void blob.refetch()} />
      </Page>
    ) : (
      <CodePageSkeleton kind="file" />
    );
  }
  return <BlobView repo={repo} blob={blob.data} />;
}

function BlobView({ repo, blob }: { repo: RepoRef; blob: FileBlob }) {
  const refName = blob.ref.name;
  // The file shows first; the commit that last changed it follows.
  const latest = useQuery(latestCommitQuery(repo, blob.ref.commitOid, blob.path));
  const lastCommit = blob.lastCommit ?? latest.data?.commit ?? null;
  const historyLink = (
    <AppLink
      href={paths.commits(repo, refName, blob.path)}
      className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-on-surface hover:underline"
    >
      <Icon name="history" size={12} />
      History
    </AppLink>
  );
  const markdown = isMarkdownPath(blob.path) && blob.text !== null;
  const [mode, setMode] = useState<"preview" | "code">(() =>
    markdown && parseLineHash(window.location.hash) === null ? "preview" : "code",
  );
  const showCode = !markdown || mode === "code";
  const { selected, select } = useLineSelection(showCode && blob.text !== null);
  const symlink = blob.mode === "120000";

  return (
    <Page>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <CodeRefPicker
          repo={repo}
          resolved={blob.ref}
          to={(name) => paths.blob(repo, name, blob.path)}
        />
        <PathBreadcrumbs repo={repo} refName={refName} path={blob.path} />
        <CopyButton text={blob.path} label="Copy path" />
      </div>

      {/* Always there, so the file does not move when its commit arrives. */}
      <Panel className="mb-3">
        <div className="flex min-h-9 items-center px-3 py-2">
          {lastCommit !== null ? (
            <CommitStrip repo={repo} commit={lastCommit}>
              {historyLink}
            </CommitStrip>
          ) : latest.isPending ? (
            <span className="flex-1">
              <CommitStripSkeleton />
            </span>
          ) : (
            <span className="ml-auto">{historyLink}</span>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          actions={
            <>
              <a
                href={blob.rawUrl}
                target="_blank"
                rel="noopener"
                className={buttonClass("secondary", "sm")}
              >
                Raw
              </a>
              <a
                href={downloadUrl(blob.rawUrl)}
                download={blob.name}
                aria-label={`Download ${blob.name}`}
                className={buttonClass("secondary", "sm")}
              >
                <Icon name="download" size={12} />
              </a>
              {blob.text !== null && !symlink ? (
                <ButtonLink size="sm" href={paths.blame(repo, refName, blob.path)}>
                  Blame
                </ButtonLink>
              ) : null}
              {blob.ref.kind !== "commit" ? (
                <CopyButton
                  text={`${window.location.origin}${paths.blob(
                    repo,
                    blob.ref.commitOid,
                    blob.path,
                    selected ? formatLineHash(selected) : undefined,
                  )}`}
                  label="Copy permalink"
                />
              ) : null}
            </>
          }
        >
          {markdown ? (
            <Segmented
              label="View"
              value={mode}
              onChange={setMode}
              options={[
                { value: "preview", label: "Preview" },
                { value: "code", label: "Code" },
              ]}
            />
          ) : null}
          <span>
            {blob.lineCount !== null ? `${plural(blob.lineCount, "line")} · ` : ""}
            {formatBytes(blob.size)}
          </span>
          {blob.mode === "100755" ? <Badge tone="outline">Executable</Badge> : null}
          {symlink ? <Badge tone="outline">Symbolic link</Badge> : null}
          {blob.lfs !== null ? <Badge tone="outline">Git LFS</Badge> : null}
        </PanelHeader>
        <BlobBody
          repo={repo}
          blob={blob}
          showCode={showCode}
          selected={selected}
          onSelectLine={select}
        />
      </Panel>
    </Page>
  );
}

function Notice({ children, blob }: { children: string; blob: FileBlob }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-xs text-on-surface-muted">
      <p>{children}</p>
      <a
        href={downloadUrl(blob.rawUrl)}
        download={blob.name}
        className={buttonClass("secondary", "sm")}
      >
        <Icon name="download" size={12} />
        Download
      </a>
    </div>
  );
}

function BlobBody({
  repo,
  blob,
  showCode,
  selected,
  onSelectLine,
}: {
  repo: RepoRef;
  blob: FileBlob;
  showCode: boolean;
  selected: LineRange | null;
  onSelectLine: (line: number, extend: boolean) => void;
}) {
  if (blob.lfs !== null) {
    return <Notice blob={blob}>{`Stored with Git LFS (${formatBytes(blob.lfs.size)})`}</Notice>;
  }
  if (blob.binary && IMAGE.test(blob.name)) {
    return (
      <div className="flex justify-center bg-surface-inset p-6">
        <img
          src={blob.rawUrl}
          alt={blob.name}
          className="max-w-full rounded border border-border"
        />
      </div>
    );
  }
  if (blob.binary) return <Notice blob={blob}>Binary file</Notice>;
  if (blob.truncated || blob.text === null) {
    return <Notice blob={blob}>This file is too large to show</Notice>;
  }
  if (blob.mode === "120000") {
    const target = resolveRelative(blob.path, blob.text.trim());
    return (
      <p className="px-3 py-4 font-mono text-xs text-on-surface">
        {target !== null ? (
          <AppLink href={paths.blob(repo, blob.ref.name, target)} className="hover:underline">
            {blob.text.trim()}
          </AppLink>
        ) : (
          blob.text.trim()
        )}
      </p>
    );
  }
  if (blob.text === "") {
    return <p className="px-3 py-6 text-center text-xs text-on-surface-muted">Empty file</p>;
  }
  if (!showCode) {
    return (
      <div className="px-6 py-5">
        <RenderedMarkdown repo={repo} at={blob.ref.name} path={blob.path} source={blob.text} />
      </div>
    );
  }
  return (
    <CodeView
      text={blob.text}
      language={languageOfPath(blob.path)}
      selected={selected}
      onSelectLine={onSelectLine}
      label={`Contents of ${blob.name}`}
    />
  );
}
