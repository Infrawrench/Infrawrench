/**
 * The mock's settings state: who reaches a repository, its protected-branch
 * rules and deploy keys, and the signed-in person's SSH keys and tokens.
 */
import type { UserRef } from "@infrawrench/git-contract";
import type {
  AccessToken,
  Collaborator,
  DeployKey,
  OrganizationAccess,
  ProtectedBranch,
  UserKey,
} from "@infrawrench/git-contract";
import type { Mutable } from "./define";
import { users, type RepositoryRecord } from "./db";

export const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 3_600_000).toISOString();
export const daysAgo = (days: number): string => hoursAgo(days * 24);

export const person = (username: string): UserRef => {
  const found = users.find((user) => user.username === username);
  if (!found) throw new Error(`No mock user ${username}`);
  return found;
};

/** People who exist on the forge without being in the fixture histories. */
export const OUTSIDERS: UserRef[] = [
  { id: "user_tomas", username: "tomas", displayName: "Tomas Okafor", avatarUrl: null },
  { id: "user_lena", username: "lena", displayName: "Lena Fischer", avatarUrl: null },
  { id: "user_sam", username: "sam-ito", displayName: "Sam Ito", avatarUrl: null },
];

// They are found by the people search like anyone else.
for (const outsider of OUTSIDERS) {
  if (!users.some((user) => user.id === outsider.id)) users.push(outsider);
}

export const everyone = (): UserRef[] => users;

// Past the ids the fixtures write out by hand (`tok_1`, `key_2`).
let nextId = 1000;
export const newId = (prefix: string): string => `${prefix}_${(nextId++).toString(36)}`;

interface RepoSettings {
  collaborators: Array<Mutable<Collaborator>>;
  rules: Array<Mutable<ProtectedBranch>>;
  deployKeys: Array<Mutable<DeployKey>>;
}

const store = new Map<string, RepoSettings>();

function seed(repo: RepositoryRecord): RepoSettings {
  const key = `${repo.owner.slug}/${repo.name}`;
  if (key === "acme/infra") {
    return {
      collaborators: [
        { user: OUTSIDERS[0]!, role: "write", addedBy: person("mara"), createdAt: daysAgo(31) },
        { user: OUTSIDERS[1]!, role: "read", addedBy: person("jonas"), createdAt: daysAgo(9) },
      ],
      rules: [
        {
          id: "rule_main",
          pattern: "main",
          requireBranchPage: true,
          requiredApprovals: 1,
          dismissStaleApprovals: true,
          requiredStatusContexts: ["Infrawrench CI / fmt", "Infrawrench CI / validate"],
          allowForcePush: false,
          allowDeletion: false,
          restrictPushers: false,
          pushers: [],
          enforceAdmins: false,
          matchingBranches: ["main"],
          createdAt: daysAgo(48),
          updatedAt: daysAgo(12),
        },
        {
          id: "rule_release",
          pattern: "release/*",
          requireBranchPage: true,
          requiredApprovals: 2,
          dismissStaleApprovals: false,
          requiredStatusContexts: ["Infrawrench CI / validate"],
          allowForcePush: false,
          allowDeletion: false,
          restrictPushers: true,
          pushers: [person("mara"), person("priya")],
          enforceAdmins: true,
          matchingBranches: ["release/2026.11"],
          createdAt: daysAgo(40),
          updatedAt: daysAgo(40),
        },
      ],
      deployKeys: [
        {
          id: "dk_1",
          title: "ci-runner read",
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:Qp7lW0y3nZk5dVJ1m2cXo8uTtR4aB6eH9sLfKgYwNxE",
          createdAt: daysAgo(44),
          lastUsedAt: hoursAgo(1),
          readOnly: true,
          addedBy: person("mara"),
        },
        {
          id: "dk_2",
          title: "release bot",
          algorithm: "ecdsa-sha2-nistp256",
          fingerprint: "SHA256:b1Vd9xZ2pQe7LmN4rTg6HsYc0KuWa3JfO8iEoCtRyMk",
          createdAt: daysAgo(20),
          lastUsedAt: daysAgo(6),
          readOnly: false,
          addedBy: person("jonas"),
        },
      ],
    };
  }
  return { collaborators: [], rules: [], deployKeys: [] };
}

export function settingsOf(repo: RepositoryRecord): RepoSettings {
  let found = store.get(repo.id);
  if (!found) store.set(repo.id, (found = seed(repo)));
  return found;
}

/** `*` within a segment, `**` across them. */
export function patternMatches(pattern: string, branch: string): boolean {
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`).test(branch);
}

export function ruleFor(repo: RepositoryRecord, branch: string): ProtectedBranch | null {
  return settingsOf(repo).rules.find((rule) => patternMatches(rule.pattern, branch)) ?? null;
}

export function organizationAccess(repo: RepositoryRecord): OrganizationAccess[] {
  if (repo.owner.kind !== "org") return [];
  return [
    { user: person("mara"), access: "admin", roleName: "Owner" },
    { user: person("jonas"), access: "write", roleName: "Engineer" },
    { user: person("priya"), access: "write", roleName: "Engineer" },
    {
      user: { id: "user_finance", username: null, displayName: "Ines Duarte", avatarUrl: null },
      access: "read",
      roleName: "Finance",
    },
  ];
}

export const userKeys: Array<Mutable<UserKey>> = [
  {
    id: "key_1",
    title: "mara@thinkpad",
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:u8Hn3kQ0vXc5JrT2yLpWm9ZsEa1Dg7BfN4oKiYt6RxM",
    createdAt: daysAgo(190),
    lastUsedAt: hoursAgo(3),
  },
  {
    id: "key_2",
    title: "yubikey 5c",
    algorithm: "sk-ssh-ed25519@openssh.com",
    fingerprint: "SHA256:Xf2aPq9LwZ7mKc4Rb1eTn6VyH0oJs8Gd3UiMtNxE5kA",
    createdAt: daysAgo(64),
    lastUsedAt: null,
  },
];

export const tokens: Array<Mutable<AccessToken>> = [
  {
    id: "tok_1",
    name: "laptop git over https",
    prefix: "iwg_4f9c2a7e",
    scopes: ["repo:read", "repo:write"],
    createdAt: daysAgo(120),
    expiresAt: null,
    lastUsedAt: hoursAgo(20),
  },
  {
    id: "tok_2",
    name: "renovate",
    prefix: "iwg_b03d51c8",
    scopes: ["repo:read"],
    createdAt: daysAgo(27),
    expiresAt: new Date(Date.now() + 63 * 86_400_000).toISOString(),
    lastUsedAt: daysAgo(1),
  },
  {
    id: "tok_3",
    name: "one-off migration",
    prefix: "iwg_7ae1d640",
    scopes: ["repo:read", "repo:write"],
    createdAt: daysAgo(80),
    expiresAt: daysAgo(50),
    lastUsedAt: daysAgo(52),
  },
];

/** A fingerprint that looks like one, derived from the key text so the same key reads the same. */
export function fingerprintOf(key: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let seed = 2166136261;
  for (const char of key) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  let text = "";
  for (let index = 0; index < 43; index++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    text += alphabet[seed % 64];
  }
  return `SHA256:${text}`;
}

const KEY_LINE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/]{20,}={0,3})(?:\s+(.*))?$/;

/** An `authorized_keys` line taken apart, or null when it is not one. */
export function parsePublicKey(
  text: string,
): { algorithm: string; body: string; comment: string | null } | null {
  const match = KEY_LINE.exec(text.trim());
  if (!match) return null;
  const comment = match[3]?.trim() ?? "";
  return { algorithm: match[1]!, body: match[2]!, comment: comment === "" ? null : comment };
}

const usedFingerprints = (): Set<string> => {
  const used = new Set(userKeys.map((key) => key.fingerprint));
  for (const settings of store.values()) {
    for (const key of settings.deployKeys) used.add(key.fingerprint);
  }
  return used;
};

export const keyInUse = (fingerprint: string): boolean => usedFingerprints().has(fingerprint);
