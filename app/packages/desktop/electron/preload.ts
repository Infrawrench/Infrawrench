// Typed preload bridge. The renderer can only invoke channels in INVOKE_CHANNELS
// and only listen to events in EVENT_LITERALS / EVENT_PREFIXES — there is no
// path for a compromised renderer to pass an arbitrary channel name through.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Must stay in sync with the ipcMain.handle(...) calls in the electron/ dir.
const INVOKE_CHANNELS = [
  // app shell
  "set_pings_active",
  "show_notification",
  "show_open_dialog",
  "show_save_dialog",
  "open_external_url",
  "update_install_now",
  // credential helpers — each channel binds plaintext to a specific row + field via AAD
  "account_get_credentials",
  "account_save_credentials",
  "account_create",
  "ssh_key_get_private_key",
  "ssh_key_save_private_key",
  "ssh_tunnel_config_get_private_key",
  "ssh_tunnel_config_encrypt_private_key",
  "secret_field_decrypt",
  "secret_field_encrypt",
  // sql.js local desktop DB (renderer-bundled SQL strings only)
  "db_select",
  "db_execute",
  // workflows — the QuickJS sandbox runs in main; host capabilities are served
  // back from the renderer (see electron/workflow-host.ts + lib/workflow-runner)
  "workflow_run",
  "workflow_host_reply",
  // plugin drivers
  "plugin_sql_query",
  "plugin_sql_execute",
  "plugin_kv_command",
  "plugin_docker_command",
  "plugin_k8s_command",
  "storage_download_batch",
  // ssh
  "ssh_open_tunnel",
  "ssh_close_tunnel",
  "ssh_get_active_tunnels",
  "ssh_exec_command",
  "ssh_shell_spawn",
  "ssh_shell_write",
  "ssh_shell_resize",
  "ssh_shell_kill",
  "ssh_list_system_keys",
  "ssh_read_system_key",
  "ssh_check_pageant",
  "ssh_check_1password",
  "ssh_list_1password_keys",
  "ssh_host_key_decide",
  // sftp
  "sftp_list",
  "sftp_mkdir",
  "sftp_delete",
  "sftp_upload",
  "sftp_download",
  // k8s
  "k8s_exec_spawn",
  "k8s_exec_write",
  "k8s_exec_resize",
  "k8s_exec_kill",
  "k9s_check",
  "k9s_spawn",
  "k9s_write",
  "k9s_resize",
  "k9s_kill",
  "k8s_pf_start",
  "k8s_pf_stop",
  "k8s_pf_list",
  "k8s_pf_cloud_start",
  "k8s_pf_cloud_stop",
  "k8s_api_request",
  // cloud
  "cloud_auth_start",
  "cloud_auth_status",
  "cloud_auth_logout",
  "cloud_auth_get_token",
  "cloud_auth_get_ws_token",
  "cloud_auth_orgs",
  "cloud_get_url",
  "cloud_sync_now",
  "cloud_sync_status",
  "cloud_list_accounts",
  "cloud_get_account_detail",
  "cloud_create_account",
  "cloud_delete_account",
  "cloud_rename_account",
  "cloud_get_account_credentials",
  "cloud_update_account_credentials",
  "cloud_sync_account_type",
  "cloud_list_account_resources",
  "cloud_get_resource_detail",
  "cloud_describe_resource",
  "cloud_create_resource",
  "cloud_update_resource",
  "cloud_delete_resource",
  "cloud_get_create_config",
  "cloud_get_create_pricing",
  "cloud_get_create_cost_estimate",
  "cloud_connect_templates",
  "cloud_invoke_action",
  "cloud_fetch_metrics",
  "cloud_get_logs",
  "cloud_get_manifest",
  "cloud_apply_manifest",
  "cloud_import_yaml",
  "cloud_export_credential",
  "cloud_secret_export",
  "cloud_env_deploy",
  "cloud_load_picker_resources",
  "cloud_tunnel_ssh_attach",
  "cloud_list_ssh_keys",
  "cloud_pin_resource",
  "cloud_unpin_resource",
  "cloud_get_pin",
  "cloud_probe_pins",
  "cloud_reorder_pins",
  "cloud_list_dashboards",
  "cloud_get_dashboard",
  "cloud_create_dashboard",
  "cloud_delete_dashboard",
  "cloud_rename_dashboard",
  "cloud_list_artifacts",
  "cloud_fetch_peer_panes",
  "cloud_access_secret_version",
  "cloud_add_secret_version",
  "cloud_list_secret_versions",
  "cloud_modify_secret_version",
  "cloud_sql_query",
  "cloud_sql_execute",
  "cloud_sql_estimate",
  "cloud_kv_command",
  "cloud_kv_browser_list",
  "cloud_kv_browser_get",
  "cloud_kv_browser_put",
  "cloud_kv_browser_delete",
  "cloud_nosql_command",
  "cloud_docker_command",
  "cloud_sftp_list",
  "cloud_sftp_mkdir",
  "cloud_sftp_delete",
  "cloud_sftp_upload",
  "cloud_sftp_download",
  "cloud_ssh_tunnel_create_account",
  "cloud_ssh_tunnel_exec",
  "cloud_ssh_keys_list",
  "cloud_ssh_keys_create",
  "cloud_ssh_keys_delete",
] as const;

const INVOKE_SET = new Set<string>(INVOKE_CHANNELS);

const EVENT_LITERALS = new Set<string>([
  "cloud_auth_error",
  "storage_download_progress",
  "ssh_host_key_prompt",
  "update_available_prompt",
  // main asks the renderer to serve a workflow host capability mid-run
  "workflow_host_call",
]);

const EVENT_PREFIXES: readonly string[] = [
  "ssh_shell_data_",
  "ssh_shell_exit_",
  "k8s_exec_data_",
  "k8s_exec_exit_",
  "k9s_data_",
  "k9s_exit_",
  "k8s_pf_exit_",
  "k8s_pf_cloud_exit_",
];

function isAllowedEventChannel(channel: string): boolean {
  if (EVENT_LITERALS.has(channel)) return true;
  return EVENT_PREFIXES.some((p) => channel.startsWith(p));
}

// Each method has the channel baked in via closure so the renderer cannot
// invoke a channel name it didn't already have a method for.
const invokeMap: Record<string, (args?: unknown) => Promise<unknown>> = {};
for (const ch of INVOKE_CHANNELS) {
  invokeMap[ch] = (args?: unknown) => ipcRenderer.invoke(ch, args);
}

contextBridge.exposeInMainWorld("electronAPI", {
  ...invokeMap,

  on(channel: string, callback: (...args: unknown[]) => void): void {
    if (!isAllowedEventChannel(channel)) {
      throw new Error(`electronAPI.on: refused unknown channel "${channel}"`);
    }
    ipcRenderer.on(channel, (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args));
  },

  offAll(channel: string): void {
    if (!isAllowedEventChannel(channel)) return;
    ipcRenderer.removeAllListeners(channel);
  },
});

export type {};
