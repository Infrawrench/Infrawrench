import { ThreadList } from "./ThreadList";

export function IssuesPage({ q }: { q: string | undefined }) {
  return <ThreadList kind="issues" q={q} />;
}
