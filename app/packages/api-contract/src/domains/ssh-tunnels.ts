/**
 * SSH tunnels: `/api/org/:orgId/ssh-tunnels`, the endpoint definitions.
 * Creating an account whose traffic rides an SSH tunnel, opening and closing
 * tunnels (held in this process: the routes are on the session gateway), and
 * running a command over an admin-configured SSH host.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { Ok, OrgParams, Uuid } from "../http/schemas/common";
import { SshHostKeyTrustRequired } from "../http/schemas/ssh-host-key-trust";

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const SshTunnelCreateAccountRequest = Schema.Struct({
  sshHost: Schema.String,
  sshPort: Port,
  sshUser: Schema.String,
  sshKeyId: Uuid,
  remoteHost: Schema.String,
  remotePort: Port,
  pluginId: Schema.String,
  displayName: Schema.String,
  credentials: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "SshTunnelCreateAccountRequest" });

export const SshTunnelCreateAccountResponse = Schema.Struct({ accountId: Uuid }).annotate({
  identifier: "SshTunnelCreateAccountResponse",
});

export const ActiveTunnel = Schema.Struct({
  localPort: Schema.Int,
  sshHost: Schema.String,
  remotePort: Schema.Int,
}).annotate({ identifier: "ActiveTunnel" });

export const OpenedTunnel = Schema.Struct({ tunnelId: Schema.String, localPort: Schema.Int });

export const SshExecRequest = Schema.Struct({
  sshHost: Schema.String,
  sshPort: Port,
  sshUser: Schema.String,
  sshKeyId: Uuid,
  command: Schema.String,
}).annotate({ identifier: "SshExecRequest" });

export const SshExecResponse = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.optionalKey(Schema.String),
  code: Schema.Int,
}).annotate({ identifier: "SshExecResponse" });

export class SshTunnelsGroup extends HttpApiGroup.make("sshTunnels")
  .add(
    HttpApiEndpoint.post("createAccount", "/create-account", {
      params: OrgParams,
      payload: SshTunnelCreateAccountRequest,
      success: SshTunnelCreateAccountResponse,
      error: [BadRequest, NotFound, SshHostKeyTrustRequired],
    })
      .annotate(RequiredPermission, "accounts:write")
      .annotate(OpenApi.Summary, "Create an account whose traffic is tunneled over SSH")
      .annotate(OpenApi.Description, "Verifies the SSH connection works before persisting.")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.post("open", "/open", {
      params: OrgParams,
      payload: Schema.Struct({ accountId: Uuid }),
      success: OpenedTunnel,
      error: [BadRequest, NotFound, SshHostKeyTrustRequired],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Re-open the tunnel for an existing account")
      .annotate(SuccessDescription, "Tunnel info"),
    HttpApiEndpoint.post("close", "/close", {
      params: OrgParams,
      payload: Schema.Struct({ tunnelId: Schema.String }),
      success: Ok,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Close a tunnel by id")
      .annotate(SuccessDescription, "Closed"),
    HttpApiEndpoint.get("active", "/active", {
      params: OrgParams,
      success: Schema.Record(Schema.String, ActiveTunnel),
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "List active tunnels for this org")
      .annotate(SuccessDescription, "Map of tunnelId → info"),
    HttpApiEndpoint.post("exec", "/exec", {
      params: OrgParams,
      payload: SshExecRequest,
      success: SshExecResponse,
      error: [BadRequest, Forbidden, NotFound, SshHostKeyTrustRequired],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Run a command over SSH using an org SSH key")
      .annotate(SuccessDescription, "Exec result"),
  )
  .prefix("/api/org/:orgId/ssh-tunnels")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "SSH tunnels") {}

export class SshTunnelsApi extends withApiDefaults(
  HttpApi.make("ssh-tunnels").add(SshTunnelsGroup),
) {}
