/**
 * The mock of `/api/workspace`: the home page of someone in agent mode, the
 * Changes list and the Mentions list, from `workspace-data.ts`, and the
 * issues and pull requests someone has a part in, from the threads of the
 * repositories they are a member of.
 */
import type { WorkThread } from "@infrawrench/git-contract";
import { defineMockHandlers, paginate } from "../define";
import { findNamespace, isMember, namespaces, repositories, requireUser } from "../db";
import { threadsOf } from "../threads-data";
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
    threads: ({ query }) => {
      const me = requireUser();
      const kind = query?.kind ?? "issues";
      const involvement = query?.involvement ?? "created";
      const state = query?.state ?? "open";
      const named = me.username === null ? null : `@${me.username.toLowerCase()}`;
      const names = (text: string) => named !== null && text.toLowerCase().includes(named);
      const items: WorkThread[] = [];
      for (const repo of repositories) {
        // The repositories they have a tie to, not every one they can read.
        if (!isMember(findNamespace(repo.owner.slug))) continue;
        for (const thread of threadsOf(repo).threads) {
          if ((thread.pull !== null) !== (kind === "pulls")) continue;
          if (state !== "all" && thread.state !== state) continue;
          const theirs = thread.author?.id === me.id;
          const involved =
            involvement === "created"
              ? theirs
              : involvement === "assigned"
                ? thread.assignees.some((user) => user.id === me.id)
                : (!theirs && names(thread.body)) ||
                  thread.items.some(
                    (item) =>
                      item.type === "comment" &&
                      item.comment.author?.id !== me.id &&
                      names(item.comment.body),
                  );
          if (!involved) continue;
          items.push({
            id: thread.id,
            repository: {
              id: repo.id,
              owner: repo.owner.slug,
              name: repo.name,
              visibility: repo.visibility,
            },
            number: thread.number,
            title: thread.title,
            isPullRequest: thread.pull !== null,
            state: thread.pull?.merged ? "merged" : thread.state,
            draft: thread.pull?.draft ?? false,
            author: thread.author,
            commentCount: thread.items.filter((item) => item.type === "comment").length,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
          });
        }
      }
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return paginate(items, query);
    },
    mentions: ({ query }) => {
      requireUser();
      return paginate(mockMentions(), query);
    },
  },
});
