/**
 * SSH host-key trust: `/api/org/:orgId/ssh-host-keys`, the endpoint
 * definitions. Listing pinned fingerprints, trusting a presented one after the
 * user consented (following a 409 `ssh_host_key_trust_required` from any SSH,
 * SFTP or tunnel route), and removing a pin.
 *
 * Never in the published document (the Hono routes were not either), so each
 * endpoint is excluded and answers with exactly what the route sent.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength, minLength, pattern } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { OrgIdParams, OrgParams } from "../../schemas/common";
import { SshHostKeyTrustRequired } from "../../schemas/ssh-host-key-trust";

export const TrustHostKeyInput = Schema.Struct({
  host: Schema.String.check(minLength(1), maxLength(253)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  fingerprint: Schema.String.check(
    pattern(/^SHA256:[A-Za-z0-9+/]+$/, {
      message: "fingerprint must be SHA256:<base64> (no padding)",
    }),
  ),
  /**
   * When answering a mismatch rather than an unknown host, the fingerprint
   * that was pinned, so the audit trail records the replacement.
   */
  previousFingerprint: Schema.optionalKey(Schema.String),
});

export class SshHostKeysGroup extends HttpApiGroup.make("sshHostKeys")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Unknown,
    })
      .annotate(RequiredPermission, "accounts:read")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("trust", "/trust", {
      params: OrgParams,
      payload: TrustHostKeyInput,
      success: Schema.Unknown,
      error: [BadRequest, SshHostKeyTrustRequired],
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(InvalidRequestMessage, "invalid_body")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Schema.Unknown,
      error: NotFound,
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Exclude, true),
  )
  .prefix("/api/org/:orgId/ssh-host-keys")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "SSH host keys") {}

export class SshHostKeysApi extends withApiDefaults(
  HttpApi.make("ssh-host-keys").add(SshHostKeysGroup),
) {}
