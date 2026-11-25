import { ThreadList } from "../issues/ThreadList";

export function PullsPage({ q }: { q: string | undefined }) {
  return <ThreadList kind="pulls" q={q} />;
}
