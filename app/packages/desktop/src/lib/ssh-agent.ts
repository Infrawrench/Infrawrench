export const PAGEANT_SENTINEL = "__pageant__";
export const ONEPASSWORD_SENTINEL = "__1password__";
/**
 * A cloud-held org key: the main process authenticates through a remote
 * signing agent backed by Infrawrench Cloud. Must match the main-process
 * constant in `electron/ssh-agent.ts`.
 */
export const CLOUD_KEY_SENTINEL = "__infrawrench_cloud_key__";
