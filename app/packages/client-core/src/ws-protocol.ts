/**
 * Typed frames for the cloud WebSocket gateway (`/api/ws`), transcribed from
 * the dispatch switch in `web/server.ts`. All frames are JSON text; terminal
 * payloads are base64 strings inside JSON (`data` fields).
 *
 * Connect flow: `POST /api/org/:orgId/ws-token` → `wss://host/api/ws?token=…`
 * (token is single-use and expires in ~30s — mint immediately before dialing).
 */

/* ------------------------------ client → server --------------------------- */

export interface SshOpenFrame {
  type: "ssh:open";
  accountId: string;
  resourceId?: string;
  /** Managed-key SSH: org key + explicit host/user instead of account creds. */
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
  connectThroughAccountId?: string;
  agentForward?: boolean;
  cols?: number;
  rows?: number;
}

export interface SshDataFrame {
  type: "ssh:data";
  /** base64 payload */
  data: string;
}

export interface SshResizeFrame {
  type: "ssh:resize";
  cols: number;
  rows: number;
}

export interface SqlQueryFrame {
  type: "sql:query";
  accountId: string;
  sql: string;
}

export interface K8sExecOpenFrame {
  type: "k8s:exec:open";
  accountId: string;
  resourceId: string;
  peerPluginId: string;
  namespace?: string;
  podName: string;
  containerName?: string;
  cols?: number;
  rows?: number;
}

export interface K8sExecDataFrame {
  type: "k8s:exec:data";
  data: string;
}

export interface K9sOpenFrame {
  type: "k9s:open";
  accountId: string;
  resourceId: string;
  peerPluginId: string;
  namespace?: string;
  cols?: number;
  rows?: number;
}

export interface K9sDataFrame {
  type: "k9s:data";
  data: string;
}

export interface K9sResizeFrame {
  type: "k9s:resize";
  cols: number;
  rows: number;
}

export interface K8sPfOpenFrame {
  type: "k8s:pf:open";
  accountId: string;
  resourceId: string;
  peerPluginId: string;
  namespace?: string;
  resourceType: string;
  resourceName: string;
  remotePort: number;
}

export interface K8sPfDataFrame {
  type: "k8s:pf:data";
  data: string;
}

export interface K8sPfCloseFrame {
  type: "k8s:pf:close";
}

export interface WorkflowRunFrame {
  type: "workflow:run";
  workflowId: string;
}

export interface WorkflowControlFrame {
  type: "workflow:continue" | "workflow:step" | "workflow:stop";
}

export interface WorkflowPromptResponseFrame {
  type: "workflow:prompt:response";
  value: unknown;
}

export type ClientFrame =
  | SshOpenFrame
  | SshDataFrame
  | SshResizeFrame
  | SqlQueryFrame
  | K8sExecOpenFrame
  | K8sExecDataFrame
  | K9sOpenFrame
  | K9sDataFrame
  | K9sResizeFrame
  | K8sPfOpenFrame
  | K8sPfDataFrame
  | K8sPfCloseFrame
  | WorkflowRunFrame
  | WorkflowControlFrame
  | WorkflowPromptResponseFrame;

/* ------------------------------ server → client --------------------------- */

/** Terminal output/status frames share this shape per protocol prefix. */
export interface ServerDataFrame {
  type: "ssh:data" | "k8s:exec:data" | "k9s:data" | "k8s:pf:data";
  data: string;
}

export interface ServerStatusFrame {
  type:
    | "ssh:ready"
    | "ssh:close"
    | "ssh:error"
    | "k8s:exec:ready"
    | "k8s:exec:close"
    | "k8s:exec:error"
    | "k9s:ready"
    | "k9s:close"
    | "k9s:error"
    | "k8s:pf:ready"
    | "k8s:pf:close"
    | "k8s:pf:error"
    | "sql:result"
    | "sql:error";
  error?: string;
  [key: string]: unknown;
}

export type ServerFrame =
  | ServerDataFrame
  | ServerStatusFrame
  | { type: string; [k: string]: unknown };
