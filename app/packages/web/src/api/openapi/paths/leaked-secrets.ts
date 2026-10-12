import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const TAG = "Leaked credentials";

export function registerLeakedSecretPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const LeakStatus = z.enum(["open", "rotated", "dismissed", "resolved"]).openapi({
    description:
      "`open` needs rotating; `rotated` was rotated through Infrawrench or detected because the " +
      "stored value changed; `dismissed` was accepted as not a risk; `resolved` was closed on the " +
      "scanner by someone else before it was rotated here.",
  });

  const LeakedSecret = strict({
    id: Uuid,
    status: LeakStatus,
    scannerAccountId: Uuid.describe("The scanner account (GitHub, GitLab) the finding came from."),
    scannerAccountName: z.string(),
    scannerPluginId: z.string(),
    tokenType: z
      .string()
      .describe("The scanner's identifier for the token type.")
      .openapi({ example: "github_personal_access_token" }),
    tokenTypeLabel: z.string(),
    ownerPluginId: z.string().nullable().describe("The plugin that issues this kind of token."),
    ownerPluginName: z.string().nullable(),
    secretHint: z
      .string()
      .nullable()
      .describe(
        "At most the first and last four characters. The secret itself is never stored or returned.",
      ),
    repository: z.string().nullable(),
    path: z.string().nullable(),
    line: z.number().int().nullable(),
    commitSha: z.string().nullable(),
    url: z.string().nullable().describe("The finding on the scanner."),
    upstreamState: z.enum(["open", "resolved"]),
    upstreamResolution: z.string().nullable(),
    validity: z.enum(["active", "inactive", "unknown"]).nullable(),
    publiclyLeaked: z.boolean(),
    detectedAt: IsoDateTime,
    firstSeenAt: IsoDateTime,
    matchKind: z.enum(["account", "secret-field", "output", "none"]).openapi({
      description:
        "What the leak was matched to: an account credential, a secret stored on a resource, a " +
        "resource output other resources reference, or nothing Infrawrench holds.",
    }),
    matchConfidence: z.enum(["fingerprint", "token-type", "none"]).openapi({
      description:
        "`fingerprint`: the leaked value equals a stored one (compared by keyed hash, never by " +
        "value). `token-type`: the scanner withheld the value, so only the token's issuer is known.",
    }),
    matchedAccountId: z.string().nullable(),
    matchedAccountName: z.string().nullable(),
    matchedResourceId: z.string().nullable(),
    matchedResourceName: z.string().nullable(),
    matchedResourceTypeId: z.string().nullable(),
    matchedPluginId: z.string().nullable(),
    matchedFieldKey: z.string().nullable(),
    candidateAccountIds: z
      .array(z.string())
      .describe("Accounts it may belong to when a token-type match is ambiguous."),
    rotation: strict({
      mode: z.enum(["reissue", "replace", "account", "manual"]).openapi({
        description:
          "`reissue`: one call rotates it. `replace`: send the new value. `account`: rotate it at " +
          "the provider and update the account; the change is detected. `manual`: rotate it at " +
          "the provider and mark it rotated.",
      }),
      manageUrl: z.string().nullable().describe("The provider's own key management page."),
    }),
    rotatedAt: IsoDateTime.nullable(),
    rotatedBy: z.string().nullable(),
    rotationMethod: z.enum(["reissued", "replaced", "detected", "manual"]).nullable(),
    dismissedReason: z.enum(["false-positive", "wont-fix", "used-in-tests"]).nullable(),
    dismissedComment: z.string().nullable(),
    dismissedAt: IsoDateTime.nullable(),
    dismissedBy: z.string().nullable(),
    upstreamResolvedAt: IsoDateTime.nullable(),
    upstreamResolveError: z.string().nullable(),
    canResolveUpstream: z.boolean(),
  }).openapi("LeakedSecret");

  const LeakedSecretScanner = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: z.string(),
    label: z.string(),
    canResolve: z.boolean(),
    returnsSecretValue: z.boolean(),
    lastScannedAt: IsoDateTime.nullable(),
    lastError: z.string().nullable(),
    lastCount: z.number().int().nullable(),
  }).openapi("LeakedSecretScanner");

  const LeakedSecretList = strict({
    leaks: z.array(LeakedSecret).describe("Open first, newest first within a status. At most 500."),
    counts: strict({
      open: z.number().int(),
      rotated: z.number().int(),
      dismissed: z.number().int(),
      resolved: z.number().int(),
    }),
    scanners: z.array(LeakedSecretScanner),
    generatedAt: IsoDateTime,
  }).openapi("LeakedSecretList");

  const LeakResponse = strict({ leak: LeakedSecret }).openapi("LeakedSecretResponse");
  const IdParams = OrgIdParam.extend({ id: Uuid });
  const ResolveUpstream = z
    .boolean()
    .optional()
    .describe("Close the finding on the scanner afterwards, when it can. Defaults to true.");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/leaked-secrets",
    tags: [TAG],
    summary: "List leaked credentials",
    description:
      "Secrets a scanner account (GitHub secret scanning, GitLab secret detection) found committed " +
      "to code, attributed to the account or stored secret they belong to. Read from the last scan; " +
      "no provider call is made.",
    request: {
      params: OrgIdParam,
      query: strict({
        status: LeakStatus.optional(),
        accountId: z
          .string()
          .optional()
          .describe("Only leaks matched to, or possibly belonging to, this account."),
      }),
    },
    responses: {
      200: {
        description: "Leaks and scanners",
        content: { "application/json": { schema: LeakedSecretList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/leaked-secrets/scan",
    tags: [TAG],
    summary: "Scan every scanner account now",
    description:
      "Reads every scanner account's findings now instead of waiting for the next 30-minute scan.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Scan totals",
        content: {
          "application/json": {
            schema: strict({
              scanned: z.number().int(),
              newLeaks: z.number().int(),
              errors: z.number().int(),
            }).openapi("LeakedSecretScanResult"),
          },
        },
      },
    },
  });

  const action = (
    path: string,
    summary: string,
    description: string,
    body?: ReturnType<typeof strict>,
  ) =>
    registry.registerPath({
      method: "post",
      path: `/api/org/{orgId}/leaked-secrets/{id}/${path}`,
      tags: [TAG],
      summary,
      description,
      request: {
        params: IdParams,
        ...(body ? { body: { content: { "application/json": { schema: body } } } } : {}),
      },
      responses: {
        200: {
          description: "The updated leak",
          content: { "application/json": { schema: LeakResponse } },
        },
        400: ErrorResponses[400],
        404: ErrorResponses[404],
        409: ErrorResponses[409],
      },
    });

  action(
    "rotate",
    "Rotate a leaked credential",
    "For `reissue` leaks the provider mints a new value and every output reference consuming it " +
      "is updated at once; for `replace` leaks send the new `value`, which the provider receives " +
      "first when it can. Refused with 409 when the stored value still equals the leaked one " +
      "afterwards. Records the rotation, raises `secret.rotated` and closes the finding upstream " +
      "as revoked unless `resolveUpstream` is false.",
    strict({
      value: z.string().optional().describe("The new value, for a `replace` rotation."),
      resolveUpstream: ResolveUpstream,
    }).openapi("LeakedSecretRotate"),
  );
  action(
    "mark-rotated",
    "Record a rotation done at the provider",
    "For an account credential, the account must have been updated first: the request is refused " +
      "with 409 while the stored credential still equals the leaked one.",
    strict({ resolveUpstream: ResolveUpstream }).openapi("LeakedSecretMarkRotated"),
  );
  action(
    "dismiss",
    "Dismiss a leaked credential",
    "Accept the finding as not a risk. Closes it upstream with the matching reason unless " +
      "`resolveUpstream` is false.",
    strict({
      reason: z.enum(["false-positive", "wont-fix", "used-in-tests"]),
      comment: z.string().max(500).optional(),
      resolveUpstream: ResolveUpstream,
    }).openapi("LeakedSecretDismiss"),
  );
  action(
    "reopen",
    "Reopen a leaked credential",
    "Undo a dismissal or a rotation recorded by mistake. Does not reopen the finding on the scanner.",
  );
}
