/**
 * Sleep/wake schedule tools — list the org's schedules (next transitions +
 * projected savings) and create new ones. Same permission split as the HTTP
 * routes: reads ride `resources:read`, creation is `resources:write` (a
 * schedule is a standing instruction to invoke the same lifecycle actions
 * that permission gates on `/resources/invoke-action`).
 */
import { z } from "zod";
import { listSchedules, previewSchedule } from "@infrawrench/server-core/schedules/feed";
import { ScheduleInputError, createScheduleRecord } from "@infrawrench/server-core/schedules/store";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

const timingShape = {
  daysOfWeek: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .describe("ISO weekdays the resource is worked on: 1 = Monday … 7 = Sunday."),
  stopTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .describe('Wall-clock 24-hour "HH:MM" at which the resource is stopped, e.g. "19:00".'),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .describe('Wall-clock 24-hour "HH:MM" at which the resource is started, e.g. "08:00".'),
  timezone: z
    .string()
    .describe('IANA timezone the times are computed in (DST-safe), e.g. "Europe/London".'),
};

export function scheduleTools(): ToolDefinition[] {
  return [
    {
      name: "list_schedules",
      title: "List sleep/wake schedules",
      description:
        "Every sleep/wake schedule in the organization: the weekly off/on window, next due " +
        "transition, last run outcome (including freeze skips and failures), and the " +
        "projected monthly saving computed from trailing per-resource spend. Purely a read.",
      inputSchema: {},
      risk: "read",
      permission: "resources:read",
      handler: async (_input, auth) => {
        const feed = await listSchedules(auth.organizationId);
        return ok(feed);
      },
    },
    {
      name: "create_schedule",
      title: "Create sleep/wake schedule",
      description:
        "Attach an off-at/on-at weekly window to a resource whose type declares lifecycle " +
        "start/stop actions (e.g. EC2/RDS instances, GCE instances, Azure VMs, droplets, " +
        "Hetzner/Scaleway servers, Fly machines, Neon endpoints). The poller then stops and " +
        "starts the resource on that window. One schedule per resource. Returns the created " +
        "schedule plus a savings preview. Audit-logged.",
      inputSchema: {
        resourceId: z.string().describe("Infrawrench resource id to schedule."),
        accountId: z.string().describe("The account the resource belongs to."),
        ...timingShape,
      },
      risk: "write",
      permission: "resources:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "resources:write");
        if (denied) return denied;
        const request = {
          resourceId: String(input["resourceId"] ?? ""),
          accountId: String(input["accountId"] ?? ""),
          daysOfWeek: (input["daysOfWeek"] as number[]) ?? [],
          stopTime: String(input["stopTime"] ?? ""),
          startTime: String(input["startTime"] ?? ""),
          timezone: String(input["timezone"] ?? ""),
        };
        try {
          const created = await createScheduleRecord(auth.organizationId, request, auth.userId);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "resource_schedule.create",
            entityType: "resource_schedule",
            entityId: created.id,
            metadata: {
              resourceId: created.resourceId,
              pluginId: created.pluginId,
              resourceTypeId: created.resourceTypeId,
              source: auth.source,
            },
          });
          const preview = await previewSchedule(auth.organizationId, request).catch(() => null);
          return ok({ schedule: created, preview });
        } catch (e) {
          if (e instanceof ScheduleInputError) return err(e.message);
          return err(e instanceof Error ? e.message : "Failed to create schedule");
        }
      },
    },
  ];
}
