import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  agentGitWorkFromSearch,
  setPendingAgentGitWork,
  validateAgentsSearch,
} from "@/lib/agent-git-work";

export const Route = createFileRoute("/org/$orgId/agents")({
  // `git` and `pull`: a pull request on git.infrawrench.com to start a session
  // on ("Start work with Infrawrench" on the forge links here).
  validateSearch: validateAgentsSearch,
  component: AgentsRoute,
});

/**
 * The tab's content renders in the workspace viewport; the route only hands
 * a pull request named in the URL to the Agents panel.
 */
function AgentsRoute() {
  const { orgId } = Route.useParams();
  const search = Route.useSearch();
  const work = agentGitWorkFromSearch(search);
  const owner = work?.owner;
  const repo = work?.repo;
  const pull = work?.pull;
  useEffect(() => {
    if (owner && repo && pull !== undefined) setPendingAgentGitWork(orgId, { owner, repo, pull });
  }, [orgId, owner, repo, pull]);
  return null;
}
