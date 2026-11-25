import type { Namespace } from "@infrawrench/git-contract";
import { defineMockHandlers, mockError } from "../define";
import { findNamespace, isMember, requireUser, users, visibleRepositories } from "../db";

function toNamespace(slug: string): Namespace {
  const record = findNamespace(slug);
  const member = isMember(record);
  return {
    ...record,
    organizationId: member ? record.organizationId : null,
    appUrl: member ? record.appUrl : null,
    repositoryCount: visibleRepositories().filter((r) => r.owner.slug === record.slug).length,
    viewer: {
      isOwner: member,
      canCreateRepository: member,
      canAdminister: member,
      permissions: member && record.kind === "org" ? ["git:read", "git:write", "git:admin"] : [],
    },
  };
}

export default defineMockHandlers({
  namespaces: {
    get: ({ params }) => toNamespace(params.namespace),
    update: ({ params, payload }) => {
      requireUser();
      const record = findNamespace(params.namespace);
      if (!isMember(record)) throw mockError(403, "Forbidden");
      Object.assign(record, payload);
      return toNamespace(record.slug);
    },
    searchUsers: () => {
      requireUser();
      return { users };
    },
  },
});
