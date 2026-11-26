/**
 * The mock of `/api/workspace`: the home page, the Changes list and the
 * Mentions list, from `workspace-data.ts`.
 */
import { defineMockHandlers, paginate } from "../define";
import { namespaces, requireUser } from "../db";
import {
  mockActivity,
  mockAgentsWorking,
  mockChanges,
  mockMentions,
  mockPushed,
  mockSuggested,
} from "../workspace-data";

const HOME_ROWS = 5;

export default defineMockHandlers({
  workspace: {
    home: ({ query }) => {
      requireUser();
      const namespace = query?.namespace;
      const days = Number(query?.days ?? "7");
      const found = namespaces.find(
        (candidate) => candidate.slug.toLowerCase() === namespace?.toLowerCase(),
      );
      const yours = mockChanges({ namespace, state: "open", author: "mine" });
      const team = mockChanges({ namespace, state: "open", author: "team" });
      const suggested = mockSuggested(namespace);
      return {
        namespace: found
          ? {
              slug: found.slug,
              kind: found.kind,
              displayName: found.displayName,
              avatarUrl: found.avatarUrl,
            }
          : null,
        shared: found?.kind === "org" || team.length > 0,
        activeBranches: yours.length + team.length,
        agentsWorking: mockAgentsWorking(namespace),
        pushed: { days, ...mockPushed(namespace, days) },
        yours: { count: yours.length, items: yours.slice(0, HOME_ROWS) },
        team: { count: team.length, items: team.slice(0, HOME_ROWS) },
        suggested: { count: suggested.length, items: suggested.slice(0, HOME_ROWS) },
        activity: mockActivity(namespace, days),
      };
    },
    changes: ({ query }) => {
      requireUser();
      return paginate(
        mockChanges({
          namespace: query?.namespace,
          state: query?.state ?? "open",
          author: query?.author ?? "all",
        }),
        query,
      );
    },
    mentions: ({ query }) => {
      requireUser();
      return paginate(mockMentions(), query);
    },
  },
});
