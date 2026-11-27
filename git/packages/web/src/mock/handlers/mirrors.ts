/**
 * Settings > Mirrors in the mock. Nothing is pushed anywhere: a mirror that
 * is owed a run is shown pushing on the next read of the list and in sync on
 * the one after, which is what the page's polling does.
 */
import type { Mirror } from "@infrawrench/git-contract";
import { conflict, defineMockHandlers, notFound, unprocessable, type Mutable } from "../define";
import { findRepository, requireUser, type RepositoryRecord } from "../db";
import { daysAgo, newId, person } from "../settings-data";

type MirrorRecord = Mutable<Mirror>;

const store = new Map<string, MirrorRecord[]>();

const seed = (repo: RepositoryRecord): MirrorRecord[] =>
  `${repo.owner.slug}/${repo.name}` === "acme/infra"
    ? [
        {
          id: "mir_1",
          url: "https://github.com/acme-example/infra.git",
          username: "x-access-token",
          exclude: ["dependabot/**"],
          force: true,
          enabled: true,
          pending: false,
          running: false,
          lastStatus: "ok",
          lastError: null,
          lastResult: {
            created: 0,
            updated: 1,
            deleted: 0,
            refused: [],
            refs: ["refs/heads/main"],
          },
          lastAttemptAt: daysAgo(0),
          lastSyncedAt: daysAgo(0),
          nextAttemptAt: null,
          addedBy: person("mara"),
          createdAt: daysAgo(30),
        },
      ]
    : [];

const mirrorsOf = (repo: RepositoryRecord): MirrorRecord[] => {
  let found = store.get(repo.id);
  if (!found) store.set(repo.id, (found = seed(repo)));
  return found;
};

const find = (repo: RepositoryRecord, mirrorId: string): MirrorRecord => {
  const mirror = mirrorsOf(repo).find((candidate) => candidate.id === mirrorId);
  if (!mirror) throw notFound("No such mirror");
  return mirror;
};

const addressOf = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw unprocessable("That is not an address");
  }
  if (url.protocol !== "https:") {
    throw unprocessable("A mirror pushes over HTTPS: the address starts with https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw unprocessable(
      "Leave the user and the token out of the address: they go in the fields below",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

/** What the next read of the list shows for a mirror that is owed a run. */
const advance = (mirror: MirrorRecord): void => {
  if (!mirror.enabled) return;
  const now = new Date().toISOString();
  if (mirror.running) {
    mirror.running = false;
    mirror.pending = false;
    mirror.lastStatus = "ok";
    mirror.lastError = null;
    mirror.lastSyncedAt = now;
    mirror.lastResult ??= { created: 3, updated: 0, deleted: 0, refused: [], refs: [] };
  } else if (mirror.pending) {
    mirror.running = true;
    mirror.lastAttemptAt = now;
  }
};

export default defineMockHandlers({
  mirrors: {
    list: ({ params }) => {
      const mirrors = mirrorsOf(findRepository(params.owner, params.repo));
      const answer = structuredClone(mirrors);
      mirrors.forEach(advance);
      return { mirrors: answer };
    },
    create: ({ params, payload }) => {
      const mirrors = mirrorsOf(findRepository(params.owner, params.repo));
      const addedBy = requireUser();
      const url = addressOf(payload.url);
      if (mirrors.some((mirror) => mirror.url === url)) {
        throw conflict("This repository already mirrors to that address");
      }
      const created: MirrorRecord = {
        id: newId("mir"),
        url,
        username: payload.username ?? "x-access-token",
        exclude: [...(payload.exclude ?? [])],
        force: payload.force ?? true,
        enabled: true,
        pending: true,
        running: false,
        lastStatus: null,
        lastError: null,
        lastResult: null,
        lastAttemptAt: null,
        lastSyncedAt: null,
        nextAttemptAt: null,
        addedBy,
        createdAt: new Date().toISOString(),
      };
      mirrors.push(created);
      return created;
    },
    update: ({ params, payload }) => {
      const mirror = find(findRepository(params.owner, params.repo), params.mirrorId);
      if (payload.url !== undefined) {
        const url = addressOf(payload.url);
        if (url !== mirror.url && payload.credential === undefined) {
          throw unprocessable("Enter the token again to change the address");
        }
        mirror.url = url;
      }
      if (payload.username !== undefined) mirror.username = payload.username;
      if (payload.exclude !== undefined) mirror.exclude = [...payload.exclude];
      if (payload.force !== undefined) mirror.force = payload.force;
      if (payload.enabled !== undefined) mirror.enabled = payload.enabled;
      mirror.pending = mirror.enabled;
      return mirror;
    },
    delete: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      find(repo, params.mirrorId);
      store.set(
        repo.id,
        mirrorsOf(repo).filter((mirror) => mirror.id !== params.mirrorId),
      );
      return { ok: true as const };
    },
    sync: ({ params }) => {
      const mirror = find(findRepository(params.owner, params.repo), params.mirrorId);
      mirror.pending = mirror.enabled;
      return mirror;
    },
  },
});
