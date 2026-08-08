import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime, Ok } from "../common";
import type { BuildContext } from "../context";

const SessionRecordingStatus = z.enum(["recording", "complete", "truncated", "abandoned"]).openapi({
  description:
    "`recording` (live), `complete` (closed cleanly), `truncated` (hit the per-session " +
    "capture ceiling — the tape is a genuine partial and says so), or `abandoned` (the " +
    "server handling the session went away before it could close the row).",
});

export function registerSessionRecordingPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const SessionRecording = strict({
    id: Uuid,
    userId: z
      .string()
      .nullable()
      .describe("Who opened the session; null when the socket authenticated with an API key."),
    userName: z
      .string()
      .nullable()
      .describe(
        "Display-name snapshot taken at record time, so a departed member still reads as one.",
      ),
    accountId: Uuid.nullable(),
    resourceId: z.string().nullable(),
    host: z.string().describe("Final hop, as dialled."),
    port: z.number().int(),
    username: z.string(),
    hopCount: z
      .number()
      .int()
      .describe("1 for a direct session; higher when it jumped through bastions."),
    cols: z.number().int(),
    rows: z.number().int(),
    hasInput: z
      .boolean()
      .describe("True when the cast also contains keystrokes (the org opted into input capture)."),
    status: SessionRecordingStatus,
    outputBytes: z.number().int().describe("Terminal bytes captured, before compression."),
    eventCount: z.number().int(),
    startedAt: IsoDateTime,
    endedAt: IsoDateTime.nullable(),
    durationMs: z.number().int().nullable(),
  }).openapi("SessionRecording");

  const SessionRecordingUsage = strict({
    recordingCount: z.number().int(),
    storedBytes: z.number().int().describe("Compressed size actually stored."),
    capturedBytes: z.number().int(),
    oldestStartedAt: IsoDateTime.nullable(),
  }).openapi("SessionRecordingUsage");

  const SessionRecordingSettings = strict({
    enabled: z.boolean(),
    captureInput: z
      .boolean()
      .describe(
        "Also record keystrokes. Separate from `enabled` because it captures input at prompts " +
          "the remote host chose not to echo — a sudo password, a pasted token — which is a " +
          "materially different promise to the people being recorded.",
      ),
    retentionDays: z.number().int().min(1).max(3650),
    usage: SessionRecordingUsage,
  }).openapi("SessionRecordingSettings");

  const SessionRecordingSettingsUpdate = strict({
    enabled: z.boolean().optional(),
    captureInput: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
  }).openapi("SessionRecordingSettingsUpdate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/session-recordings",
    tags: ["Session recordings"],
    summary: "List recorded SSH sessions",
    description:
      "Recorded sessions, newest first. Only SSH opened through the cloud is recorded — those " +
      "sessions are already proxied by the server, so recording tees a stream it holds rather " +
      "than requiring an agent on the host. A desktop session that dials a host directly never " +
      "reaches the server and cannot appear here.",
    request: {
      params: OrgIdParam,
      query: strict({
        status: SessionRecordingStatus.optional(),
        userId: z.string().optional(),
        resourceId: z.string().optional(),
        accountId: Uuid.optional(),
        since: IsoDateTime.optional().describe("Inclusive lower bound on `startedAt`."),
        until: IsoDateTime.optional().describe("Exclusive upper bound on `startedAt`."),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: "The organization's recordings",
        content: { "application/json": { schema: z.array(SessionRecording) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/session-recordings/settings",
    tags: ["Session recordings"],
    summary: "Get the recording policy",
    description:
      "The organization's recording policy plus what it currently stores. Usage rides along " +
      "with the policy because the only question anyone asks about retention is what it costs.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Policy and storage usage",
        content: { "application/json": { schema: SessionRecordingSettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/session-recordings/settings",
    tags: ["Session recordings"],
    summary: "Update the recording policy",
    description:
      "Partial update — omitted fields keep their current value. Recording is opt-in and off " +
      "by default. Audit-logged with the before/after policy.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SessionRecordingSettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The updated policy",
        content: { "application/json": { schema: SessionRecordingSettings } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/session-recordings/{recordingId}",
    tags: ["Session recordings"],
    summary: "Get one recording's metadata",
    request: { params: OrgIdParam.extend({ recordingId: Uuid }) },
    responses: {
      200: {
        description: "The recording",
        content: { "application/json": { schema: SessionRecording } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/session-recordings/{recordingId}/cast",
    tags: ["Session recordings"],
    summary: "Download a recording as an asciicast",
    description:
      "The session as an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) " +
      "document: a JSON header line followed by one `[time, code, data]` event per line. " +
      "Deliberately somebody else's format — the same bytes play in `asciinema play` and in " +
      "the reference web player, so a recording is useful to an auditor who has never seen " +
      "this product. `?download=1` returns it as an attachment. **Every fetch is " +
      "audit-logged**, including this one: an investigator has to be able to answer who has " +
      "watched a given tape.",
    request: {
      params: OrgIdParam.extend({ recordingId: Uuid }),
      query: strict({
        download: z.enum(["1"]).optional().describe("Force an attachment disposition."),
      }),
    },
    responses: {
      200: {
        description: "The asciicast document",
        content: { "text/plain": { schema: z.string() } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/session-recordings/{recordingId}",
    tags: ["Session recordings"],
    summary: "Delete a recording",
    description: "Removes the recording and its stored chunks. Audit-logged.",
    request: { params: OrgIdParam.extend({ recordingId: Uuid }) },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
