/**
 * The moment view as an agent surface — `what_changed`.
 *
 * Mirrors `GET /moment`: same union service, same per-feed permission
 * gating. The declared permission is the endpoint's floor (`resources:read`);
 * the handler then resolves the caller's full effective grants so feeds
 * needing more (costs, workflows, deployments, audit, freezes) are omitted
 * per-feed exactly as the HTTP route omits them.
 */
import { z } from "zod";
import { computeMoment, parseMomentTimestamp } from "../services/moment";
import { effectiveToolPermissions } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

export function momentTools(): ToolDefinition[] {
  return [
    {
      name: "what_changed",
      title: "What changed around a timestamp",
      description:
        "Everything the platform knows happened around a timestamp, merged chronologically: " +
        "resource changes (with sleep/wake schedule attribution), provider status incidents " +
        "overlapping the window, cost anomalies, workflow runs, deployments, audit-log " +
        "entries, change freezes, and drift/expiry alert deliveries. Feeds you lack " +
        "permission for are reported as omitted; a failing feed is reported as errored " +
        "without losing the rest. Events inside a provider incident's span can be " +
        "correlated via the returned incident list.",
      inputSchema: {
        at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 centre timestamp, e.g. 2026-08-03T03:14:00Z. A timestamp without an " +
              "offset is interpreted as UTC. Defaults to now.",
          ),
        window_minutes: z
          .number()
          .int()
          .min(1)
          .max(4320)
          .optional()
          .describe("Half-window in minutes (the ± around `at`). Default 60, max 4320 (±3 days)."),
      },
      risk: "read",
      // Mirrors `GET /moment` — the union's floor; per-feed gating happens in
      // the service against the caller's full effective permissions.
      permission: "resources:read",
      handler: async (input, auth) => {
        const { at: atRaw, window_minutes: windowMinutes } = input as {
          at?: string;
          window_minutes?: number;
        };
        let at: Date | undefined;
        if (atRaw !== undefined) {
          // Shared with `GET /moment` — offset-less timestamps are pinned to
          // UTC so the result doesn't depend on the server's local zone.
          const parsed = parseMomentTimestamp(atRaw);
          if (parsed === null) {
            return err(`Invalid 'at' timestamp: ${atRaw}`);
          }
          at = parsed;
        }
        const permissions = await effectiveToolPermissions(auth);
        return ok(
          await computeMoment(auth.organizationId, {
            at,
            windowMinutes,
            permissions,
          }),
        );
      },
    },
  ];
}
