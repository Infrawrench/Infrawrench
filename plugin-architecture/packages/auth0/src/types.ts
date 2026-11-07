/** Auth0 Management API shapes, from the generated types. A row can come from a list or from a single read or write. */
import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";

type Answer<Op extends keyof operations> = ApiResponse<operations[Op]>;

export type A0TenantSettings = Answer<"tenant_settings_route">;

export type A0Branding = Answer<"get_branding">;

export type A0Client =
  | ApiListItem<operations["get_clients"], "clients">
  | Answer<"get_clients_by_id">
  | Answer<"post_clients">
  | Answer<"patch_clients_by_id">;

export type A0ResourceServer =
  | ApiListItem<operations["get_resource-servers"], "resource_servers">
  | Answer<"get_resource-servers_by_id">
  | Answer<"post_resource-servers">
  | Answer<"patch_resource-servers_by_id">;

/** The document leaves `enabled_clients` off a list row, and has it on the others. */
export type A0Connection = (
  | ApiListItem<operations["get_connections"], "connections">
  | Answer<"get_connections_by_id">
  | Answer<"post_connections">
  | Answer<"patch_connections_by_id">
) & { enabled_clients?: string[] };

export type A0EnabledClient = Answer<"get_connection_clients">["clients"][number];

export type A0User =
  | ApiListItem<operations["get_users"], "users">
  | Answer<"get_users_by_id">
  | Answer<"post_users">
  | Answer<"patch_users_by_id">;

export type A0Role =
  | ApiListItem<operations["get_roles"], "roles">
  | ApiListItem<operations["get_user_roles"], "roles">
  | Answer<"get_roles_by_id">
  | Answer<"post_roles">;

export type A0Organization =
  | ApiListItem<operations["get_organizations"], "organizations">
  | Answer<"get_organizations_by_id">
  | Answer<"post_organizations">
  | Answer<"patch_organizations_by_id">;

export type A0Action =
  ApiListItem<operations["get_actions"], "actions"> | Answer<"get_action"> | Answer<"post_action">;

export type A0LogStream =
  | Answer<"get_log-streams">[number]
  | Answer<"get_log-streams_by_id">
  | Answer<"post_log-streams">
  | Answer<"patch_log-streams_by_id">;

/** The document leaves `origin_domain_name` off the answer to a create or an update. */
export type A0CustomDomain = (
  | ApiListItem<operations["get_custom-domains"], "custom_domains">
  | ApiListItem<operations["get_custom-domains"], null>
  | Answer<"get_custom-domains_by_id">
  | Answer<"post_custom-domains">
  | Answer<"patch_custom-domains_by_id">
) & { origin_domain_name?: string };

export type A0Log = Answer<"get_logs">[number];
