/** Facts for every card, as a lookup answers them, and the renderer's files read from disk. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { OgFacts, RepositoryFacts } from "../facts";
import type { RendererAssets } from "../render";

export const REPOSITORY: RepositoryFacts = {
  owner: "acme",
  ownerKind: "org",
  ownerAvatarUrl: null,
  name: "platform-infra",
  description:
    "Terraform for the platform team: networking, the Kubernetes clusters, and the staging and production databases.",
  defaultBranch: "main",
  languages: [
    { name: "HCL", bytes: 412_000 },
    { name: "TypeScript", bytes: 180_000 },
    { name: "Go", bytes: 64_000 },
    { name: "Shell", bytes: 22_000 },
    { name: "Dockerfile", bytes: 3_000 },
  ],
  stars: 1284,
  forks: 87,
  openIssues: 23,
  openBranches: 9,
  archived: false,
  issues: true,
};

export const FIXTURES: Readonly<Record<string, OgFacts | null>> = {
  site: null,
  repository: { kind: "repository", repository: REPOSITORY },
  "repository-bare": {
    kind: "repository",
    repository: {
      ...REPOSITORY,
      owner: "alice",
      ownerKind: "user",
      name: "dotfiles",
      description: null,
      languages: [],
      stars: 0,
      forks: 0,
      openIssues: 0,
      openBranches: 0,
    },
  },
  namespace: {
    kind: "namespace",
    slug: "acme",
    namespaceKind: "org",
    displayName: "Acme Corporation",
    description: "Infrastructure, tooling and the services behind acme.example.",
    avatarUrl: null,
    repositories: 42,
  },
  bot: {
    kind: "namespace",
    slug: "claude",
    namespaceKind: "bot",
    displayName: "Claude",
    description: null,
    avatarUrl: "/assets/bots/claude-icon.svg",
    repositories: null,
  },
  commit: {
    kind: "commit",
    repository: REPOSITORY,
    sha: "3f9c2a71be04d8a5c6e1f20b9d7a4c3e5f6a7b8c",
    summary: "Move the staging database to the new subnet group and widen its maintenance window",
    author: { name: "Alice Example", avatarUrl: null },
    authoredAt: "2026-11-20T14:03:00.000Z",
    filesChanged: 7,
    additions: 184,
    deletions: 39,
  },
  issue: {
    kind: "issue",
    repository: REPOSITORY,
    number: 412,
    title: "Staging budget alarm fires at 80 percent although spend is flat",
    state: "open",
    closedAs: null,
    comments: 14,
    author: { name: "Bob Builder", avatarUrl: null },
  },
  "issue-closed": {
    kind: "issue",
    repository: REPOSITORY,
    number: 87,
    title: "Rotate the deploy key",
    state: "closed",
    closedAs: "completed",
    comments: 2,
    author: null,
  },
  branch: {
    kind: "branch",
    repository: REPOSITORY,
    key: "claude/budget-alarm",
    title: "Raise the staging budget alarm to 90 percent and page only on a real jump",
    state: "open",
    headRef: "claude/budget-alarm",
    baseRef: "main",
    versions: 3,
    findings: { mustFix: 1, shouldFix: 2, note: 4 },
    ask: "The staging budget alarm keeps paging at 80 percent when nothing changed. Make it useful.",
    author: { name: "Alice Example", avatarUrl: null },
    agent: { name: "Claude Code", avatarUrl: "/assets/bots/claude-icon.svg" },
    commits: 6,
    additions: 212,
    deletions: 48,
  },
  "branch-merged": {
    kind: "branch",
    repository: REPOSITORY,
    key: "feature/vpc-endpoints",
    title: "Add VPC endpoints for S3 and DynamoDB",
    state: "merged",
    headRef: "feature/vpc-endpoints",
    baseRef: "main",
    versions: 1,
    findings: { mustFix: 0, shouldFix: 0, note: 0 },
    ask: null,
    author: { name: "Carol", avatarUrl: null },
    agent: null,
    commits: 2,
    additions: 64,
    deletions: 3,
  },
};

const require = createRequire(import.meta.url);

const bytes = (path: string): ArrayBuffer => {
  const data = readFileSync(path);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
};

const font = (name: string): string =>
  fileURLToPath(new URL(`../fonts/inter-${name}-normal.woff`, import.meta.url));

/** What `../assets.ts` gives the Worker, read from the same files. */
export async function nodeAssets(): Promise<RendererAssets> {
  const [yoga, resvg] = await Promise.all([
    WebAssembly.compile(bytes(require.resolve("satori/yoga.wasm"))),
    WebAssembly.compile(bytes(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))),
  ]);
  return {
    yoga,
    resvg,
    fonts: [
      { name: "Inter", weight: 400, data: bytes(font("latin-400")) },
      { name: "Inter", weight: 600, data: bytes(font("latin-600")) },
      { name: "Inter", weight: 700, data: bytes(font("latin-700")) },
      { name: "Inter", weight: 400, data: bytes(font("latin-ext-400")) },
      { name: "Inter", weight: 600, data: bytes(font("latin-ext-600")) },
      { name: "Inter", weight: 700, data: bytes(font("latin-ext-700")) },
    ],
  };
}

/** A bot's picture from the built UI's sources, as the Worker reads it from its assets. */
export const ownAsset = (path: string): Response => {
  const file = fileURLToPath(new URL(`../../../../web/public${path}`, import.meta.url));
  const type = path.endsWith(".svg") ? "image/svg+xml" : "image/png";
  return new Response(readFileSync(file), { headers: { "content-type": type } });
};
