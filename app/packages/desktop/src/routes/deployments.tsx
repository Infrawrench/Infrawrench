import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/deployments")({
  // `?repo=owner/name` preselects a repository in cloud mode, matching the
  // web app's route. Rendering happens in WorkspaceTabsViewport (the tab stays
  // mounted so a streaming deploy survives a tab switch), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { repo?: string } => {
    const repo = typeof search["repo"] === "string" ? search["repo"] : undefined;
    return repo ? { repo } : {};
  },
  component: () => null,
});
