import type { SshConfig } from "@infrawrench/plugin-base";
import type { KeySource } from "../../lib/ssh-key-source";

export type { SshConfig };

export interface SqliteResourceRow {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  external_id: string;
  fields_json: string;
}

export interface CloudCtx {
  orgId: string;
  pluginId: string;
  resourceTypeId: string;
  parentResourceId?: string;
}

export interface QuickSshConnection {
  username: string;
  privateKey: string;
  keySource: KeySource;
}
