/**
 * Push mirrors (Settings > Mirrors): the rows and their last runs. The
 * pushing itself is the jobs queue's (`mirror/job.ts`); a handler writes the
 * row and sends a message.
 *
 * The credential goes in sealed and never comes out: no endpoint returns
 * it, and changing a mirror's address needs it entered again, so a stored
 * credential is only ever sent to the host it was entered for.
 */
import { HttpApiBuilder } from "effect/http-api";
import { GitApi, type Mirror, conflict, notFound, unprocessable } from "@infrawrench/git-contract";
import { siteOrigin } from "../../env";
import { enqueueJob } from "../../jobs/consumer";
import { DEFAULT_MIRROR_USERNAME, mirrorAddress } from "../../mirror/address";
import { patternProblem } from "../../mirror/refs";
import {
  MAX_MIRRORS,
  type MirrorRow,
  createMirror,
  deleteMirror,
  getMirror,
  listMirrors,
  requestMirrorSync,
  updateMirror,
} from "../../mirror/store";
import { type RepoCx, repoOp } from "../context";
import { iso, isoOrNull, peopleById } from "../views/repositories";

const mirrorViews = async (rows: readonly MirrorRow[]): Promise<Mirror[]> => {
  const person = await peopleById(rows.map((row) => row.createdByUserId));
  const now = Date.now();
  return rows.map((row) => {
    const pending = row.enabled && row.pendingGeneration > row.syncedGeneration;
    return {
      id: row.id,
      url: row.url,
      username: row.username,
      exclude: row.exclude,
      force: row.force,
      enabled: row.enabled,
      pending,
      running: row.leaseUntil !== null && row.leaseUntil.getTime() > now,
      lastStatus: row.lastStatus,
      lastError: row.lastStatus === "error" ? row.lastError : null,
      lastResult: row.lastResult,
      lastAttemptAt: isoOrNull(row.lastAttemptAt),
      lastSyncedAt: isoOrNull(row.lastSyncedAt),
      nextAttemptAt:
        pending && row.attempts > 0 && row.nextAttemptAt.getTime() > now
          ? iso(row.nextAttemptAt)
          : null,
      addedBy: person(row.createdByUserId),
      createdAt: iso(row.createdAt),
    };
  });
};

const view = async (row: MirrorRow): Promise<Mirror> => (await mirrorViews([row]))[0]!;

/** The address as a mirror may have it, or a 422 that says what is wrong with it. */
const addressOf = (cx: RepoCx, value: string): string => {
  const checked = mirrorAddress(value, { siteHosts: [new URL(siteOrigin(cx.env)).hostname] });
  if (!checked.ok) throw unprocessable(checked.problem);
  return checked.url;
};

const patternsOf = (patterns: readonly string[]): string[] => {
  const tidy = [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))];
  for (const pattern of tidy) {
    const problem = patternProblem(pattern);
    if (problem !== null) throw unprocessable(`${problem}: ${pattern}`);
  }
  return tidy;
};

/** A user name or a credential as it is sent: no surrounding space, nothing that breaks a header. */
const fieldOf = (value: string, what: string): string => {
  const text = value.trim();
  if (text === "" || /[\u0000-\u001f\u007f]/.test(text)) throw unprocessable(`Enter ${what}`);
  return text;
};

const usernameOf = (value: string): string => {
  const text = fieldOf(value, "the user name");
  if (text.includes(":")) throw unprocessable("The user name cannot have a colon in it");
  return text;
};

/** Sends the mirror's run. Without a queue the sweep takes it within two minutes. */
const send = (cx: RepoCx, mirrorId: string): void => {
  cx.background(enqueueJob(cx.env, { type: "mirror", mirrorId }));
};

export const MirrorsHandlers = HttpApiBuilder.group(GitApi, "mirrors", (handlers) =>
  handlers
    .handle(
      "list",
      repoOp(async (cx) => ({
        mirrors: await mirrorViews(await listMirrors(cx.repo.repository.id)),
      })),
    )
    .handle(
      "create",
      repoOp(async (cx, { payload }) => {
        const row = await createMirror(cx.repo.repository.id, {
          url: addressOf(cx, payload.url),
          username:
            payload.username === undefined ? DEFAULT_MIRROR_USERNAME : usernameOf(payload.username),
          credential: fieldOf(payload.credential, "the token"),
          exclude: patternsOf(payload.exclude ?? []),
          force: payload.force ?? true,
          createdByUserId: cx.userId,
        });
        if (row === "exists") throw conflict("This repository already mirrors to that address");
        if (row === "full") {
          throw conflict(`A repository can have ${MAX_MIRRORS} mirrors`);
        }
        send(cx, row.id);
        return view(row);
      }),
    )
    .handle(
      "update",
      repoOp(async (cx, { params, payload }) => {
        const repositoryId = cx.repo.repository.id;
        const current = await getMirror(repositoryId, params.mirrorId);
        if (!current) throw notFound("No such mirror");
        const url = payload.url === undefined ? undefined : addressOf(cx, payload.url);
        if (url !== undefined && url !== current.url && payload.credential === undefined) {
          throw unprocessable("Enter the token again to change the address");
        }
        const row = await updateMirror(repositoryId, current.id, {
          ...(url !== undefined ? { url } : {}),
          ...(payload.username !== undefined ? { username: usernameOf(payload.username) } : {}),
          ...(payload.credential !== undefined
            ? { credential: fieldOf(payload.credential, "the token") }
            : {}),
          ...(payload.exclude !== undefined ? { exclude: patternsOf(payload.exclude) } : {}),
          ...(payload.force !== undefined ? { force: payload.force } : {}),
          ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
        });
        if (row === null) throw notFound("No such mirror");
        if (row === "exists") throw conflict("This repository already mirrors to that address");
        if (row.enabled) send(cx, row.id);
        return view(row);
      }),
    )
    .handle(
      "delete",
      repoOp(async (cx, { params }) => {
        if (!(await deleteMirror(cx.repo.repository.id, params.mirrorId))) {
          throw notFound("No such mirror");
        }
        return { ok: true as const };
      }),
    )
    .handle(
      "sync",
      repoOp(async (cx, { params }) => {
        const repositoryId = cx.repo.repository.id;
        if (!(await requestMirrorSync(repositoryId, params.mirrorId))) {
          throw notFound("No such mirror");
        }
        const row = await getMirror(repositoryId, params.mirrorId);
        if (!row) throw notFound("No such mirror");
        if (row.enabled) send(cx, row.id);
        return view(row);
      }),
    ),
);
