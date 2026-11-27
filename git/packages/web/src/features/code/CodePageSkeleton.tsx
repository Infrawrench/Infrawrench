/**
 * A folder's or a file's page while it loads, laid out as the page will be:
 * the toolbar (branch picker and path), then the file table or the file, and
 * on a repository's front page the About column beside it. Drawn in `Page`
 * so it never spans the window.
 */
import { Page } from "../../components/Panel";
import { Loading, Skeleton } from "../../components/states";

function Toolbar() {
  return (
    <div className="mb-3 flex min-h-[30px] items-center gap-2" aria-hidden="true">
      <Skeleton className="h-[30px]" width={112} />
      <Skeleton className="h-4" width={180} />
    </div>
  );
}

function AboutSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <Skeleton className="h-4" width="40%" />
      <Skeleton className="h-3" width="90%" />
      <Skeleton className="h-3" width="70%" />
      <Skeleton className="h-3" width="50%" />
    </div>
  );
}

export function CodePageSkeleton({
  kind,
  root = false,
}: {
  kind: "table" | "file";
  /** A repository's front page, with its About column. */
  root?: boolean;
}) {
  const main = <Loading shape={kind} label={kind === "table" ? "Loading files" : "Loading file"} />;
  return (
    <Page>
      <Toolbar />
      {root ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          {main}
          <AboutSkeleton />
        </div>
      ) : (
        main
      )}
    </Page>
  );
}
