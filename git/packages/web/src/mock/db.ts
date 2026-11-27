/**
 * The mock's state: who is signed in, the namespaces and the repositories.
 * In memory, so a reload starts over; every handler file reads and writes it
 * through the functions here.
 *
 * Who is signed in is a scenario kept in `sessionStorage`, switched with
 * `?mock=signed-in | signed-out | new-user` on any URL.
 */
import {
  httpCloneUrl,
  privateRepositoryRefusal,
  sshCloneUrl,
  type ForgePlan,
  type Namespace,
  type NamespaceRef,
  type Repository,
  type RepositorySummary,
  type Session,
  type UserRef,
  type Visibility,
} from "@infrawrench/git-contract";
import { mockError, notFound, unauthorized, type Mutable } from "./define";
import { FIXTURE_PEOPLE, fixtureInstance, type FixtureName, type GitFixture } from "./git";
import { commitTexts, textAt } from "./git-write";

export type MockScenario = "signed-in" | "signed-out" | "new-user";

const SCENARIO_KEY = "git-mock-scenario";
const SCENARIOS: ReadonlyArray<MockScenario> = ["signed-in", "signed-out", "new-user"];

function readScenario(): MockScenario {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("mock");
    if (fromUrl !== null && (SCENARIOS as ReadonlyArray<string>).includes(fromUrl)) {
      sessionStorage.setItem(SCENARIO_KEY, fromUrl);
    }
    const stored = sessionStorage.getItem(SCENARIO_KEY);
    if (stored !== null && (SCENARIOS as ReadonlyArray<string>).includes(stored)) {
      return stored as MockScenario;
    }
  } catch {
    // No storage (a private window): the default scenario.
  }
  return "signed-in";
}

let scenario: MockScenario = readScenario();

export function setScenario(next: MockScenario): void {
  scenario = next;
  try {
    sessionStorage.setItem(SCENARIO_KEY, next);
  } catch {
    // Not remembered across a reload, which is all storage was for.
  }
}

export const APP_URL = "https://app.infrawrench.com";
const ACME_ORG_ID = "org_acme";
const TIDEWATER_ORG_ID = "org_tidewater";

const me = FIXTURE_PEOPLE["mara@acme.example"]!;
let myUsername: string | null = scenario === "new-user" ? null : "mara";

export const users: UserRef[] = Object.values(FIXTURE_PEOPLE);

/** The signed-in person, or null. */
export function currentUser(): UserRef | null {
  if (scenario === "signed-out") return null;
  return { ...me, username: myUsername };
}

/** The signed-in person, or a 401 as an endpoint with `RequiresUser` answers. */
export function requireUser(): UserRef {
  const user = currentUser();
  if (!user) throw unauthorized();
  return user;
}

export function session(): Session {
  const user = currentUser();
  if (!user) {
    return {
      user: null,
      onboarding: null,
      personal: null,
      organizations: [],
      signInUrl: "/auth/sign-in",
      appUrl: APP_URL,
      sshEnabled: true,
    };
  }
  const own = namespaces.find((n) => n.userId === user.id && user.username !== null);
  const fits = (namespace: NamespaceRecord) => {
    const refusal = privateRefusal(namespace);
    return {
      privateRepositories: refusal === null,
      privateRepositoryRefusal: refusal,
      defaultVisibility: namespace.defaultVisibility,
    };
  };
  return {
    user: {
      id: user.id,
      email: "mara@acme.example",
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    },
    onboarding: {
      needsUsername: user.username === null,
      suggestedUsername: user.username === null ? "mara" : null,
      signupsOpen: true, // git-feature-flag
    },
    personal: own ? fits(own) : null,
    organizations: [
      ...namespaces
        .filter((n) => n.kind === "org")
        .map((n) => ({
          id: n.organizationId!,
          name: n.displayName ?? n.slug,
          namespace: n.slug,
          permissions: ["git:read", "git:write", "git:admin"] as const,
          canClaimNamespace: false,
          ...fits(n),
        })),
      {
        id: "org_northwind",
        name: "Northwind Labs",
        namespace: null,
        permissions: ["git:read", "git:write", "git:admin"],
        canClaimNamespace: true,
        privateRepositories: true,
        privateRepositoryRefusal: null,
        defaultVisibility: "private",
      },
    ],
    signInUrl: "/auth/sign-in",
    appUrl: APP_URL,
    sshEnabled: true,
  };
}

export function claimUsername(username: string): NamespaceRef {
  myUsername = username;
  const existing = namespaces.find((n) => n.userId === me.id);
  if (existing) existing.slug = username;
  for (const repo of repositories) {
    if (repo.owner.kind === "user" && repo.ownerUserId === me.id) {
      repo.owner = { ...repo.owner, slug: username };
    }
  }
  return { slug: username, kind: "user", displayName: me.displayName, avatarUrl: null };
}

type NamespaceRecord = Mutable<Omit<Namespace, "viewer" | "repositoryCount">> & {
  /** Whose limits apply (`FORGE_LIMITS`): the organisation's plan, or a person's allowance. */
  plan: ForgePlan;
  /** What a new repository here starts as, as the app's Settings > Git sets it. */
  defaultVisibility: Visibility;
};

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

export const namespaces: NamespaceRecord[] = [
  {
    id: "ns_acme",
    slug: "acme",
    kind: "org",
    displayName: "Acme",
    description: null,
    avatarUrl: null,
    websiteUrl: "https://acme.example",
    location: "Berlin",
    userId: null,
    organizationId: ACME_ORG_ID,
    appUrl: `${APP_URL}/org/${ACME_ORG_ID}`,
    createdAt: daysAgo(420),
    plan: "paid",
    defaultVisibility: "private",
  },
  {
    id: "ns_tidewater",
    slug: "tidewater",
    kind: "org",
    displayName: "Tidewater",
    description: null,
    avatarUrl: null,
    websiteUrl: null,
    location: null,
    userId: null,
    organizationId: TIDEWATER_ORG_ID,
    appUrl: `${APP_URL}/org/${TIDEWATER_ORG_ID}`,
    createdAt: daysAgo(64),
    // On the free plan with every private repository it includes, and public by default.
    plan: "free",
    defaultVisibility: "public",
  },
  ...[
    { slug: "mara", displayName: "Mara Lindqvist", location: "Stockholm" },
    { slug: "jonas", displayName: "Jonas Weber", location: "Hamburg" },
    { slug: "priya", displayName: "Priya Raman", location: null },
  ].map(({ slug, displayName, location }): NamespaceRecord => ({
    id: `ns_${slug}`,
    slug,
    kind: "user",
    displayName,
    description: null,
    avatarUrl: null,
    websiteUrl: null,
    location,
    userId: `user_${slug}`,
    organizationId: null,
    appUrl: null,
    createdAt: daysAgo(300),
    plan: "personal",
    defaultVisibility: "private",
  })),
];

export function findNamespace(slug: string): NamespaceRecord {
  const found = namespaces.find((n) => n.slug.toLowerCase() === slug.toLowerCase());
  if (!found) throw notFound("No user or organisation by that name");
  return found;
}

/** Whether the signed-in person is the namespace's user or a member of its organisation. */
export function isMember(namespace: NamespaceRecord): boolean {
  const user = currentUser();
  if (!user) return false;
  return namespace.kind === "org" ? true : namespace.userId === user.id;
}

/**
 * Why the namespace may not take one more private repository, or null: the
 * plan's own limit and sentence, as the API's 402 words it.
 */
export function privateRefusal(namespace: NamespaceRecord): string | null {
  const held = repositories.filter(
    (repo) => repo.owner.slug === namespace.slug && repo.visibility === "private",
  ).length;
  return privateRepositoryRefusal(namespace.plan, held);
}

export interface RepositoryRecord extends Mutable<Omit<Repository, "viewer" | "viewerHasStarred">> {
  /** The Git history behind it; null for an empty repository. */
  fixture: FixtureName | null;
  ownerUserId: string | null;
  /** Ids of the users who starred it. */
  stars: Set<string>;
}

interface Seed {
  owner: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  fixture: FixtureName | null;
  language: string | null;
  topics?: string[];
  stars?: number;
  forks?: number;
  parent?: string;
  archived?: boolean;
  hasCi?: boolean;
  hasTerraform?: boolean;
  issues?: number;
  pages?: number;
  starredByMe?: boolean;
}

const seeds: Seed[] = [
  {
    owner: "acme",
    name: "infra",
    description: "Terraform for Acme's cloud accounts",
    visibility: "private",
    fixture: "infra",
    language: "HCL",
    topics: ["terraform", "aws"],
    stars: 4,
    forks: 1,
    hasCi: true,
    hasTerraform: true,
    issues: 6,
    // Open pages: #12, #14 and #18 (`threads-data.ts`).
    pages: 3,
    starredByMe: true,
  },
  {
    owner: "acme",
    name: "edge-router",
    description: "Routes requests at the edge by host and path prefix",
    visibility: "public",
    fixture: "edge-router",
    language: "TypeScript",
    topics: ["edge", "proxy"],
    stars: 128,
    forks: 9,
    hasCi: true,
    issues: 3,
    // Open pages: #4, and #6 from a fork.
    pages: 2,
  },
  {
    owner: "acme",
    name: "billing-events",
    description: "Usage events from the metering pipeline to the ledger",
    visibility: "private",
    fixture: "edge-router",
    language: "TypeScript",
    stars: 2,
    issues: 11,
  },
  {
    owner: "acme",
    name: "status-page",
    description: "The public status page",
    visibility: "public",
    fixture: "edge-router",
    language: "TypeScript",
    stars: 31,
    forks: 4,
    archived: true,
  },
  {
    owner: "acme",
    name: "new-service",
    description: null,
    visibility: "private",
    fixture: null,
    language: null,
  },
  ...["ledger", "tide-tables", "harbour-ops"].map((name): Seed => ({
    owner: "tidewater",
    name,
    description: null,
    visibility: "private",
    fixture: null,
    language: null,
  })),
  {
    owner: "mara",
    name: "route-lab",
    description: "Experiments with weighted routing",
    visibility: "public",
    fixture: "edge-router",
    language: "TypeScript",
    stars: 7,
  },
  {
    owner: "mara",
    name: "infra",
    description: "Terraform for Acme's cloud accounts",
    visibility: "private",
    fixture: "infra",
    language: "HCL",
    parent: "acme/infra",
  },
  {
    owner: "jonas",
    name: "edge-router",
    description: "Routes requests at the edge by host and path prefix",
    visibility: "public",
    fixture: "edge-router",
    language: "TypeScript",
    parent: "acme/edge-router",
    stars: 1,
    starredByMe: true,
  },
];

let nextId = 1;

function makeRecord(seed: Seed): RepositoryRecord {
  const namespace = findNamespace(seed.owner);
  const id = `repo_${nextId++}`;
  const fixture = seed.fixture === null ? null : fixtureInstance(id, seed.fixture);
  const head = fixture ? fixture.commits[fixture.branches[fixture.defaultBranch]!] : undefined;
  const stars = new Set<string>();
  for (let i = 0; i < (seed.stars ?? 0); i++) stars.add(`stargazer_${i}`);
  if (seed.starredByMe === true) stars.add(me.id);
  const ref = { owner: namespace.slug, repo: seed.name };
  return {
    id,
    owner: {
      slug: namespace.slug,
      kind: namespace.kind,
      displayName: namespace.displayName,
      avatarUrl: namespace.avatarUrl,
    },
    ownerUserId: namespace.userId,
    name: seed.name,
    description: seed.description,
    visibility: seed.visibility,
    archived: seed.archived ?? false,
    isFork: seed.parent !== undefined,
    parent: null,
    defaultBranch: fixture?.defaultBranch ?? "main",
    primaryLanguage: seed.language,
    // The language bar of a repository the mock shows: its own language most, then two small ones.
    languages:
      seed.language === null || seed.language === undefined
        ? []
        : [
            { name: seed.language, bytes: 184_200 },
            ...(seed.language === "HCL" ? [] : [{ name: "HCL", bytes: 21_400 }]),
            { name: "Shell", bytes: 3_100 },
          ],
    topics: seed.topics ?? [],
    starCount: stars.size,
    forkCount: seed.forks ?? 0,
    openIssueCount: seed.issues ?? 0,
    openBranchCount: seed.pages ?? 0,
    sizeBytes: fixture ? Object.values(fixture.blobs).reduce((sum, blob) => sum + blob.size, 0) : 0,
    pushedAt: head?.committer.when ?? null,
    createdAt: daysAgo(seed.fixture === "infra" ? 51 : 36),
    updatedAt: head?.committer.when ?? daysAgo(2),
    homepageUrl: null,
    isEmpty: fixture === null,
    httpCloneUrl: httpCloneUrl(ref),
    sshCloneUrl: sshCloneUrl(ref),
    features: { issues: true },
    merge: {
      allowMergeCommit: true,
      allowSquash: true,
      allowRebase: true,
      defaultMethod: "merge",
      deleteBranchOnMerge: false,
    },
    branchCount: fixture ? Object.keys(fixture.branches).length : 0,
    tagCount: fixture ? Object.keys(fixture.tags).length : 0,
    hasCi: seed.hasCi ?? false,
    hasTerraform: seed.hasTerraform ?? false,
    fixture: seed.fixture,
    stars,
  };
}

export const repositories: RepositoryRecord[] = seeds.map(makeRecord);

for (const seed of seeds) {
  if (seed.parent === undefined) continue;
  const [owner, name] = seed.parent.split("/");
  const parent = repositories.find((r) => r.owner.slug === owner && r.name === name)!;
  const fork = repositories.find((r) => r.owner.slug === seed.owner && r.name === seed.name)!;
  fork.parent = {
    id: parent.id,
    owner: parent.owner.slug,
    name: parent.name,
    visibility: parent.visibility,
  };
}

/**
 * Branches the mock writes beside the scripted histories, before anything
 * reads them: one whose name has two slashes in `acme/infra`, one in a fork
 * of `acme/edge-router` that is proposed there, and one in `mara/infra` that
 * nobody has proposed yet.
 */
function seedBranches(): void {
  const named = (owner: string, name: string) =>
    repositories.find((repo) => repo.owner.slug === owner && repo.name === name)!;
  const jonas = FIXTURE_PEOPLE["jonas@acme.example"]!;
  const infra = fixtureInstance(named("acme", "infra").id, "infra");
  const main = infra.branches[infra.defaultBranch]!;
  const budget = "environments/staging/budget.tf";
  infra.branches["feature/budgets/staging-alarm"] = commitTexts(
    infra,
    main,
    {
      [budget]: textAt(infra, main, budget).replace(
        '  time_unit    = "MONTHLY"\n}',
        '  time_unit    = "MONTHLY"\n\n  notification {\n    comparison_operator        = "GREATER_THAN"\n    threshold                  = 80\n    threshold_type             = "PERCENTAGE"\n    notification_type          = "ACTUAL"\n    subscriber_email_addresses = ["infrastructure@acme.example"]\n  }\n}',
      ),
    },
    "staging: alarm at 80 percent of the budget",
    me,
  );

  const fork = fixtureInstance(named("jonas", "edge-router").id, "edge-router");
  const forkMain = fork.branches[fork.defaultBranch]!;
  const router = "src/router.ts";
  fork.branches["fix/lowercase-hosts"] = commitTexts(
    fork,
    forkMain,
    {
      [router]: textAt(fork, forkMain, router).replaceAll(
        "route.host !== url.host",
        "route.host.toLowerCase() !== url.host.toLowerCase()",
      ),
    },
    "Match hosts case-insensitively",
    jonas,
  );

  const maraInfra = fixtureInstance(named("mara", "infra").id, "infra");
  const maraMain = maraInfra.branches[maraInfra.defaultBranch]!;
  maraInfra.branches["docs/peering-notes"] = commitTexts(
    maraInfra,
    maraMain,
    {
      "docs/peering-notes.md":
        "# Peering notes\n\nEach environment's VPC peers with shared services. One route per private route table points at the peering connection.\n",
    },
    "docs: peering notes",
    me,
  );
}

seedBranches();

/** The viewer's access, as `repoAccess` would answer it. */
export function accessTo(repo: RepositoryRecord): "none" | "read" | "write" | "admin" {
  const namespace = findNamespace(repo.owner.slug);
  const member = isMember(namespace);
  if (!member) return repo.visibility === "public" ? "read" : "none";
  return "admin";
}

/** The repository at `owner/repo`, or the 404 a caller who cannot read it gets. */
export function findRepository(owner: string, name: string): RepositoryRecord {
  const repo = repositories.find(
    (r) =>
      r.owner.slug.toLowerCase() === owner.toLowerCase() &&
      r.name.toLowerCase() === name.toLowerCase(),
  );
  if (!repo || accessTo(repo) === "none") throw notFound("Repository not found");
  return repo;
}

/**
 * The repository a comparison's head is in: the base itself, or a repository
 * of the same fork network the caller can read. The mock's forks share their
 * parent's history, so a fork's branch is compared in the base's own objects.
 */
export function headRepositoryOf(
  base: RepositoryRecord,
  headRepository: string | undefined,
): RepositoryRecord {
  if (headRepository === undefined) return base;
  const [owner, name] = headRepository.split("/");
  const head = findRepository(owner ?? "", name ?? "");
  if (head === base) return base;
  const related =
    head.parent?.id === base.id ||
    base.parent?.id === head.id ||
    (head.parent !== null && head.parent.id === base.parent?.id);
  if (!related || head.fixture !== base.fixture) {
    throw mockError(422, "That repository is not a fork of this one");
  }
  return head;
}

/** The repository's Git history. A 422 `repository_empty` when nothing has been pushed. */
export function gitOf(repo: RepositoryRecord): GitFixture {
  if (repo.fixture === null) {
    throw mockError(422, "Nothing has been pushed to this repository", "repository_empty");
  }
  return fixtureInstance(repo.id, repo.fixture);
}

export function toSummary(repo: RepositoryRecord): RepositorySummary {
  const user = currentUser();
  return {
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    description: repo.description,
    visibility: repo.visibility,
    archived: repo.archived,
    isFork: repo.isFork,
    parent: repo.parent,
    defaultBranch: repo.defaultBranch,
    primaryLanguage: repo.primaryLanguage,
    topics: repo.topics,
    starCount: repo.stars.size,
    forkCount: repo.forkCount,
    openIssueCount: repo.openIssueCount,
    openBranchCount: repo.openBranchCount,
    sizeBytes: repo.sizeBytes,
    pushedAt: repo.pushedAt,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    viewerHasStarred: user !== null && repo.stars.has(user.id),
  };
}

export function toRepository(repo: RepositoryRecord): Repository {
  const user = currentUser();
  const access = accessTo(repo);
  const admin = access === "admin";
  const fixture = repo.fixture === null ? null : fixtureInstance(repo.id, repo.fixture);
  return {
    ...toSummary(repo),
    homepageUrl: repo.homepageUrl,
    isEmpty: repo.isEmpty,
    languages: repo.languages,
    httpCloneUrl: repo.httpCloneUrl,
    sshCloneUrl: repo.sshCloneUrl,
    features: repo.features,
    merge: repo.merge,
    branchCount: fixture ? Object.keys(fixture.branches).length : 0,
    tagCount: fixture ? Object.keys(fixture.tags).length : 0,
    hasCi: repo.hasCi,
    hasTerraform: repo.hasTerraform,
    viewer: {
      access: repo.archived || access === "none" ? "read" : access,
      canAdminister: admin,
      canPush: admin && !repo.archived,
      canTriage: admin && !repo.archived,
      canFork: user !== null && !repo.isEmpty,
      hasStarred: user !== null && repo.stars.has(user.id),
    },
  };
}

export function visibleRepositories(): RepositoryRecord[] {
  return repositories.filter((repo) => accessTo(repo) !== "none");
}

export function createRepository(seed: Seed): RepositoryRecord {
  const record = makeRecord(seed);
  repositories.unshift(record);
  return record;
}

export function removeRepository(repo: RepositoryRecord): void {
  const index = repositories.indexOf(repo);
  if (index >= 0) repositories.splice(index, 1);
}
