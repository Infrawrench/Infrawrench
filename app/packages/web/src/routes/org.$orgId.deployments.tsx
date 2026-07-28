import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId/deployments")({
  // `?repo=owner/name` preselects a repository — that is what a
  // `/deploy/github.com/owner/name` hotlink redirects into.
  validateSearch: (search: Record<string, unknown>): { repo?: string } => {
    const repo = typeof search["repo"] === "string" ? search["repo"] : undefined;
    return repo ? { repo } : {};
  },
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches —
  // which matters here: a deploy streams over a websocket and must survive the
  // user switching tabs mid-build. The route only exists for URL navigation.
  component: () => null,
});
