/**
 * Credential hygiene: `/api/org/:orgId/credential-hygiene`, the handler.
 *
 * Gated on `audit:read` rather than a family of its own: everything here is
 * derived from the audit log and the credential tables, so the report is a
 * lens, not a new disclosure. Not cached: a stale governance report is one
 * people learn to distrust.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  MAX_HYGIENE_WINDOW_DAYS,
  MIN_HYGIENE_WINDOW_DAYS,
  buildHygieneReport,
} from "@infrawrench/server-core/hygiene/report";
import { badRequest, CredentialHygieneApi, HygieneReport } from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const CredentialHygieneHandlers = HttpApiBuilder.group(
  CredentialHygieneApi,
  "credentialHygiene",
  (handlers) =>
    handlers.handle("report", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const raw = query.windowDays;
        if (raw !== undefined) {
          const days = Number(raw);
          if (
            !Number.isInteger(days) ||
            days < MIN_HYGIENE_WINDOW_DAYS ||
            days > MAX_HYGIENE_WINDOW_DAYS
          ) {
            return yield* badRequest(
              `windowDays must be an integer between ${MIN_HYGIENE_WINDOW_DAYS} and ${MAX_HYGIENE_WINDOW_DAYS}`,
            );
          }
        }
        const report = yield* legacy(() =>
          buildHygieneReport(organizationId, {
            ...(raw !== undefined ? { windowDays: Number(raw) } : {}),
          }),
        );
        return yield* respond(HygieneReport)(report);
      }),
    ),
);

export const credentialHygieneDomain = makeDomain(
  "credentialHygiene",
  CredentialHygieneApi,
  CredentialHygieneHandlers,
);
