/**
 * Vulnerabilities: `/api/org/:orgId/vulnerabilities`, the handlers.
 *
 * The feed is the stored scanner findings joined to the synced resources that
 * run them, assembled in server-core (`vulnerabilities/feed.ts`) so the API,
 * the alert pass and the scorecard/compliance helpers share one computation.
 * The read makes no provider API calls: the poller collects findings.
 * Dismissals and settings changes are audited.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { MAX_VULNERABILITY_RESOURCE_IDS, scopeVulnerabilityFeed } from "@infrawrench/client-core";
import { listVulnerabilities } from "@infrawrench/server-core/vulnerabilities/feed";
import {
  dismissVulnerability,
  MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH,
  restoreVulnerability,
} from "@infrawrench/server-core/vulnerabilities/dismissals";
import {
  getVulnerabilitySettings,
  toVulnerabilitySettingsWire,
  updateVulnerabilitySettings,
  type VulnerabilitySettingsPatch,
} from "@infrawrench/server-core/vulnerabilities/settings";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fireAndForget, legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  VulnerabilitiesApi,
  VulnerabilityDismissal,
  VulnerabilityListResponse,
  VulnerabilitySettings,
} from "./api";

const VulnerabilitiesHandlers = HttpApiBuilder.group(
  VulnerabilitiesApi,
  "vulnerabilities",
  (handlers) =>
    handlers
      /**
       * Every open finding, joined to what runs it and to the services those
       * resources belong to. `?serviceId=` and `?resourceId=` (repeatable)
       * narrow it to findings running there, with the counts recomputed.
       */
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          const serviceId = query.serviceId?.trim() || undefined;
          const resourceIds = [
            ...new Set((query.resourceId ?? []).map((s) => s.trim()).filter(Boolean)),
          ];
          if (resourceIds.length > MAX_VULNERABILITY_RESOURCE_IDS) {
            return yield* badRequest(
              `Ask about at most ${MAX_VULNERABILITY_RESOURCE_IDS} resources at a time`,
            );
          }
          const { organizationId } = yield* OrgPrincipal;
          const feed = yield* legacy(() =>
            listVulnerabilities(organizationId, { withServices: true }),
          );
          return yield* respond(VulnerabilityListResponse)(
            scopeVulnerabilityFeed(feed, { serviceId, resourceIds }),
          );
        }),
      )
      /** Accept an advisory for one artifact (or `*`). Idempotent. */
      .handleRaw("dismiss", ({ request }) =>
        Effect.gen(function* () {
          const read = yield* readObjectBody(request);
          if (!read.ok) return yield* badRequest(read.error);
          const body = read.body;
          const advisoryId = body["advisoryId"];
          const artifactKey = body["artifactKey"];
          const reason = body["reason"];
          if (!Predicate.isString(advisoryId) || advisoryId.trim() === "") {
            return yield* badRequest("advisoryId is required");
          }
          if (!Predicate.isString(artifactKey) || artifactKey.trim() === "") {
            return yield* badRequest("artifactKey is required");
          }
          if (reason !== undefined && reason !== null && !Predicate.isString(reason)) {
            return yield* badRequest("reason must be a string");
          }
          if (
            Predicate.isString(reason) &&
            reason.length > MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH
          ) {
            return yield* badRequest(
              `reason must be at most ${MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH} characters`,
            );
          }

          const { organizationId, session } = yield* OrgPrincipal;
          const userId = session.userId;
          const dismissal = yield* legacy(() =>
            dismissVulnerability(organizationId, {
              advisoryId,
              artifactKey,
              reason: reason ?? null,
              userId: userId ?? null,
            }),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId,
              action: "vulnerability.dismissed",
              entityType: "vulnerability",
              entityId: dismissal.advisoryId,
              metadata: { artifactKey: dismissal.artifactKey, reason: dismissal.reason },
            }),
          );
          return yield* respond(VulnerabilityDismissal)({
            advisoryId: dismissal.advisoryId,
            artifactKey: dismissal.artifactKey,
            dismissedAt: dismissal.dismissedAt,
            dismissedBy: dismissal.dismissedBy,
            reason: dismissal.reason,
          });
        }),
      )
      /** Undo a dismissal. The key is in the query string because artifact keys carry slashes and colons. */
      .handle("restore", ({ query }) =>
        Effect.gen(function* () {
          const { advisoryId, artifactKey } = query;
          if (!advisoryId) return yield* badRequest("advisoryId is required");
          if (!artifactKey) return yield* badRequest("artifactKey is required");

          const { organizationId, session } = yield* OrgPrincipal;
          const removed = yield* legacy(() =>
            restoreVulnerability(organizationId, advisoryId, artifactKey),
          );
          if (!removed) return yield* notFound("That vulnerability is not dismissed");
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "vulnerability.restored",
              entityType: "vulnerability",
              entityId: advisoryId.trim().toUpperCase(),
              metadata: { artifactKey },
            }),
          );
        }),
      )
      .handle("getSettings", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const settings = yield* legacy(() => getVulnerabilitySettings(organizationId));
          return yield* respond(VulnerabilitySettings)(toVulnerabilitySettingsWire(settings));
        }),
      )
      /** `lastNotifiedAt` is the poller's claim and not writable. */
      .handleRaw("updateSettings", ({ request }) =>
        Effect.gen(function* () {
          const read = yield* readObjectBody(request);
          if (!read.ok) return yield* badRequest(read.error);
          const body = read.body;
          const patch: VulnerabilitySettingsPatch = {};
          for (const key of ["alertsEnabled", "runningOnly"] as const) {
            const value = body[key];
            if (value === undefined) continue;
            if (!Predicate.isBoolean(value)) return yield* badRequest(`${key} must be a boolean`);
            patch[key] = value;
          }
          const minSeverity = body["minSeverity"];
          if (minSeverity !== undefined) {
            if (minSeverity !== "critical" && minSeverity !== "high") {
              return yield* badRequest('minSeverity must be "critical" or "high"');
            }
            patch.minSeverity = minSeverity;
          }
          if (Object.keys(patch).length === 0) return yield* badRequest("No settings supplied");

          const { organizationId, session } = yield* OrgPrincipal;
          const saved = yield* legacy(() => updateVulnerabilitySettings(organizationId, patch));
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "vulnerability.settings.updated",
              entityType: "organization",
              entityId: organizationId,
              metadata: { ...patch },
            }),
          );
          return yield* respond(VulnerabilitySettings)(toVulnerabilitySettingsWire(saved));
        }),
      ),
);

export const vulnerabilitiesDomain = makeDomain(
  "vulnerabilities",
  VulnerabilitiesApi,
  VulnerabilitiesHandlers,
);
