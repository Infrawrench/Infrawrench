import {
  GithubPermissionRequiredClientError,
  isGithubPermissionRequiredResponse,
  isSeatLimitResponse,
  PlanRequiredClientError,
  SeatLimitReachedClientError,
} from "@infrawrench/client-core";
import type { SettingsApi } from "@infrawrench/ui";
import { Option } from "effect";
import type { CloudHttpMethod, CloudHttpResponse } from "../../shared/rpc/groups/cloud-http";
import { serverErrorSentence } from "./cloud-client";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/**
 * Desktop implementation of the shared settings sections' transport: every
 * call rides the cloud transport (the `CloudHttp` RPC), whose main-process
 * end holds the session and allowlists the settings API surface
 * (`electron/cloud-allowlist.ts`, `SETTINGS_RULES`). Errors are rebuilt here
 * as the same typed classes the web fetch throws, so the shared sections
 * cannot tell the transports apart.
 */
function send(method: CloudHttpMethod, path: string, body?: unknown): Promise<CloudHttpResponse> {
  return runRpc(
    DesktopRpcClient.use((rpc) =>
      rpc.CloudHttp({
        method,
        url: path,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    ),
  );
}

function parseJson(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

async function request<T>(method: CloudHttpMethod, path: string, body?: unknown): Promise<T> {
  const { status, body: bodyText } = await send(method, path, body);

  if (status >= 200 && status < 300) {
    const value: unknown = bodyText ? JSON.parse(bodyText) : undefined;
    // `SettingsApi` is `get<T>(path)`: the sections name the answer's type
    // at a raw path with no endpoint definition, so the body is handed back
    // as the type they asked for, unchecked, exactly as the web fetch does.
    return value as T;
  }

  const parsed = parseJson(bodyText);
  if (status === 409 && isSeatLimitResponse(parsed)) {
    throw new SeatLimitReachedClientError(parsed);
  }
  if (status === 409 && isGithubPermissionRequiredResponse(parsed)) {
    throw new GithubPermissionRequiredClientError(parsed);
  }
  // The `{ error }` sentence of a JSON error body, else the body itself.
  const message = Option.getOrElse(serverErrorSentence(bodyText), () => bodyText);
  if (status === 402) {
    throw new PlanRequiredClientError(message);
  }
  throw new Error(message || `Cloud request failed: ${status} ${path}`);
}

/**
 * GET a settings endpoint whose body is a document, not a JSON payload.
 *
 * Same transport and same allowlist as {@link request}; it only skips the
 * parse. The one caller is the session-recording player: an asciicast is
 * newline-delimited JSON, so `JSON.parse` fails on its header line alone.
 */
export async function requestText(path: string): Promise<string> {
  const { status, body: bodyText } = await send("GET", path);
  if (status >= 200 && status < 300) return bodyText;
  const message = Option.getOrElse(serverErrorSentence(bodyText), () => bodyText);
  throw new Error(message || `Cloud request failed: ${status} ${path}`);
}

export function createDesktopSettingsApi(): SettingsApi {
  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    delete: <T>(path: string) => request<T>("DELETE", path),
  };
}
