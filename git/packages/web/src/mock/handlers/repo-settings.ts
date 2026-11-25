import {
  badRequest,
  conflict,
  defineMockHandlers,
  mockError,
  notFound,
  ok,
  unprocessable,
} from "../define";
import {
  findNamespace,
  findRepository,
  gitOf,
  isMember,
  repositories,
  requireUser,
  toRepository,
  type RepositoryRecord,
} from "../db";
import { knownContexts } from "../ci-data";
import {
  everyone,
  fingerprintOf,
  keyInUse,
  newId,
  organizationAccess,
  parsePublicKey,
  patternMatches,
  settingsOf,
} from "../settings-data";
import { userNamed } from "../threads-write";

const branchesMatching = (repo: RepositoryRecord, pattern: string): string[] =>
  repo.fixture === null
    ? []
    : Object.keys(gitOf(repo).branches)
        .filter((name) => patternMatches(pattern, name))
        .slice(0, 5);

export default defineMockHandlers({
  repositories: {
    transfer: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const target = findNamespace(payload.owner);
      if (!isMember(target)) throw badRequest("You cannot create repositories there");
      const clash = repositories.some(
        (other) =>
          other !== repo &&
          other.owner.slug === target.slug &&
          other.name.toLowerCase() === repo.name.toLowerCase(),
      );
      if (clash)
        throw conflict(`${target.slug} already has a repository by that name`, "name_taken");
      if (target.kind === "user" && repo.visibility === "private" && target.slug === "priya") {
        throw mockError(402, "That owner's plan has no private repositories", "plan_required");
      }
      repo.owner = {
        slug: target.slug,
        kind: target.kind,
        displayName: target.displayName,
        avatarUrl: target.avatarUrl,
      };
      repo.ownerUserId = target.userId;
      return toRepository(repo);
    },
  },
  collaborators: {
    list: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return {
        collaborators: settingsOf(repo).collaborators,
        organization: organizationAccess(repo),
      };
    },
    set: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const addedBy = requireUser();
      const user = userNamed(params.username);
      const settings = settingsOf(repo);
      const existing = settings.collaborators.find((item) => item.user.id === user.id);
      if (existing) {
        existing.role = payload.role;
        return existing;
      }
      const created = { user, role: payload.role, addedBy, createdAt: new Date().toISOString() };
      settings.collaborators.push(created);
      return created;
    },
    remove: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const settings = settingsOf(repo);
      settings.collaborators = settings.collaborators.filter(
        (item) => item.user.username !== params.username,
      );
      return ok;
    },
    listAssignable: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const words = (query?.q ?? "").toLowerCase();
      const people =
        repo.owner.kind === "org"
          ? organizationAccess(repo)
              .map((item) => item.user)
              .filter((user) => user.username !== null)
          : everyone().filter((user) => user.id === repo.ownerUserId);
      const collaborators = settingsOf(repo)
        .collaborators.filter((item) => item.role !== "read")
        .map((item) => item.user);
      return {
        users: [...people, ...collaborators].filter((user) =>
          `${user.username} ${user.displayName ?? ""}`.toLowerCase().includes(words),
        ),
      };
    },
  },
  protectedBranches: {
    list: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return {
        rules: settingsOf(repo)
          .rules.map((rule) => ({
            ...rule,
            matchingBranches: branchesMatching(repo, rule.pattern),
          }))
          .sort((a, b) => a.pattern.localeCompare(b.pattern)),
      };
    },
    create: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const settings = settingsOf(repo);
      if (settings.rules.some((rule) => rule.pattern === payload.pattern)) {
        throw conflict("A rule for that pattern exists", "name_taken");
      }
      const now = new Date().toISOString();
      const rule = {
        id: newId("rule"),
        pattern: payload.pattern,
        requirePullRequest: payload.requirePullRequest ?? false,
        requiredApprovals: payload.requiredApprovals ?? 0,
        dismissStaleApprovals: payload.dismissStaleApprovals ?? false,
        requiredStatusContexts: [...(payload.requiredStatusContexts ?? [])],
        allowForcePush: payload.allowForcePush ?? false,
        allowDeletion: payload.allowDeletion ?? false,
        restrictPushers: payload.restrictPushers ?? false,
        pushers: (payload.pushers ?? []).map(userNamed),
        enforceAdmins: payload.enforceAdmins ?? false,
        matchingBranches: branchesMatching(repo, payload.pattern),
        createdAt: now,
        updatedAt: now,
      };
      settings.rules.push(rule);
      return rule;
    },
    update: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const settings = settingsOf(repo);
      const rule = settings.rules.find((item) => item.id === params.ruleId);
      if (!rule) throw notFound("Rule not found");
      if (payload.pattern !== undefined && payload.pattern !== rule.pattern) {
        if (settings.rules.some((item) => item.pattern === payload.pattern)) {
          throw conflict("A rule for that pattern exists", "name_taken");
        }
        rule.pattern = payload.pattern;
      }
      const { pattern: _pattern, pushers, requiredStatusContexts, ...flags } = payload;
      Object.assign(rule, flags);
      if (requiredStatusContexts !== undefined) {
        rule.requiredStatusContexts = [...requiredStatusContexts];
      }
      if (pushers !== undefined) rule.pushers = pushers.map(userNamed);
      rule.matchingBranches = branchesMatching(repo, rule.pattern);
      rule.updatedAt = new Date().toISOString();
      return rule;
    },
    delete: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const settings = settingsOf(repo);
      settings.rules = settings.rules.filter((rule) => rule.id !== params.ruleId);
      return ok;
    },
    statusContexts: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return { contexts: knownContexts(repo) };
    },
  },
  deployKeys: {
    list: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return { keys: settingsOf(repo).deployKeys };
    },
    create: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const addedBy = requireUser();
      const parsed = parsePublicKey(payload.key);
      if (!parsed) throw badRequest("That is not a public key", "key_invalid");
      const fingerprint = fingerprintOf(parsed.body);
      if (keyInUse(fingerprint)) {
        throw conflict("That key is already in use somewhere else", "key_in_use");
      }
      if (payload.title.trim() === "") throw unprocessable("A title is required");
      const key = {
        id: newId("dk"),
        title: payload.title.trim(),
        algorithm: parsed.algorithm,
        fingerprint,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        readOnly: payload.readOnly ?? true,
        addedBy,
      };
      settingsOf(repo).deployKeys.push(key);
      return key;
    },
    delete: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const settings = settingsOf(repo);
      settings.deployKeys = settings.deployKeys.filter((key) => key.id !== params.keyId);
      return ok;
    },
  },
});
