import {
  NAME_MAX_LENGTH,
  nameProblemMessage,
  namespaceClaimRefusal,
  namespaceSlugProblem,
  type Namespace,
} from "@infrawrench/git-contract";
import { badRequest, conflict, defineMockHandlers, mockError, notFound } from "../define";
import {
  claimOrganizationNamespace,
  findNamespace,
  isMember,
  namespaces,
  requireUser,
  unclaimedOrganizations,
  users,
  visibleRepositories,
} from "../db";

function toNamespace(slug: string): Namespace {
  const record = findNamespace(slug);
  const member = isMember(record);
  const { plan: _plan, defaultVisibility: _defaultVisibility, ...profile } = record;
  return {
    ...profile,
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
    claimForOrganization: ({ params, payload }) => {
      requireUser();
      if (namespaces.some((n) => n.organizationId === params.orgId)) {
        throw conflict(
          "This organisation already has a name. Change it in the app, in Settings > Git",
          "namespace_already_claimed",
        );
      }
      const organization = unclaimedOrganizations.find((o) => o.id === params.orgId);
      if (!organization) throw notFound("No such organisation");
      if (!organization.permissions.includes("git:admin")) {
        throw mockError(403, "This needs git:admin in the organisation");
      }
      // git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
      if (!organization.gitEnabled) {
        throw mockError(403, "Git is not turned on for this organisation", "git_not_enabled");
      }
      const problem = namespaceSlugProblem(payload.slug);
      if (problem !== null) {
        throw badRequest(
          nameProblemMessage(problem, NAME_MAX_LENGTH),
          problem === "reserved" ? "username_reserved" : "name_invalid",
        );
      }
      const planRefusal = namespaceClaimRefusal(organization.plan);
      if (planRefusal !== null) throw mockError(402, planRefusal, "plan_required");
      if (namespaces.some((n) => n.slug.toLowerCase() === payload.slug.toLowerCase())) {
        throw conflict("That name is taken", "namespace_taken");
      }
      return toNamespace(claimOrganizationNamespace(organization.id, payload.slug).slug);
    },
    searchUsers: () => {
      requireUser();
      return { users };
    },
  },
});
