/**
 * The mock's T3 Code state: the signed-in person's environments and the
 * threads each one would list. Only the `t3` handlers write it. Two are on
 * T3 Connect addresses (`prod-<16 hex>.<zone>`, the shape the contract's
 * `t3-connect.ts` checks; the zone is made up) and one on a typed address.
 */
import type { T3Environment, T3Thread } from "@infrawrench/git-contract";
import type { Mutable } from "./define";

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
const daysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString();

/** How long a sign-in lasts, as T3 Code has it. */
export const T3_SIGN_IN_DAYS = 30;

export const t3Environments: Mutable<T3Environment>[] = [
  {
    id: "t3env_studio",
    label: "Studio",
    baseUrl: "https://prod-4f1c09ab72de3a65.t3coderelay.com",
    status: "connected",
    scopes: ["orchestration:read", "orchestration:operate"],
    tokenExpiresAt: daysFromNow(22),
    lastError: null,
    lastUsedAt: hoursAgo(3),
    createdAt: hoursAgo(8 * 24),
    updatedAt: hoursAgo(3),
  },
  {
    id: "t3env_laptop",
    label: "Laptop",
    baseUrl: "https://prod-b8e2d4017c96f3a0.t3coderelay.com",
    status: "error",
    scopes: ["orchestration:read"],
    tokenExpiresAt: null,
    lastError: "The environment did not accept this site's sign-in. Sign in to it again.",
    lastUsedAt: hoursAgo(31 * 24),
    createdAt: hoursAgo(40 * 24),
    updatedAt: hoursAgo(26),
  },
  {
    id: "t3env_build",
    label: "Build box",
    baseUrl: "https://build.acme.example",
    status: "pending",
    scopes: [],
    tokenExpiresAt: null,
    lastError: null,
    lastUsedAt: null,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  },
];

export const t3Threads: Record<string, T3Thread[]> = {
  t3env_studio: [
    {
      id: "t3thread_peering",
      title: "Peer the staging and shared VPCs",
      projectId: "t3project_infra",
      projectName: "acme/infra",
      updatedAt: hoursAgo(2),
    },
    {
      id: "t3thread_backups",
      title: "Nightly database backups",
      projectId: "t3project_infra",
      projectName: "acme/infra",
      updatedAt: hoursAgo(30),
    },
    {
      id: "t3thread_router",
      title: "Retry budget for the edge router",
      projectId: "t3project_router",
      projectName: "acme/edge-router",
      updatedAt: hoursAgo(5 * 24),
    },
  ],
};

let made = 0;
export const newT3Id = (): string => `t3env_${Date.now().toString(36)}${++made}`;

export const signInT3 = (environment: Mutable<T3Environment>): void => {
  const now = new Date().toISOString();
  environment.status = "connected";
  environment.scopes = ["orchestration:read", "orchestration:operate"];
  environment.tokenExpiresAt = daysFromNow(T3_SIGN_IN_DAYS);
  environment.lastError = null;
  environment.updatedAt = now;
};
