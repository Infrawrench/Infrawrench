import { type T3Environment, t3ConnectOrigin } from "@infrawrench/git-contract";
import type { BadgeTone } from "../../components/Badge";

/** How the browser came back from signing in (`?t3=`), as the callback writes it. */
export type T3Outcome = "connected" | "failed";

export const outcomeOf = (value: unknown): T3Outcome | undefined =>
  value === "connected" || value === "failed" ? value : undefined;

/**
 * Whether what was typed can be an environment's address at all. The server
 * decides for good (it also refuses private addresses); this only keeps the
 * button off until there is something to send, and names the one mistake
 * everybody makes first.
 */
export const addressProblem = (typed: string): "empty" | "localhost" | "not-https" | null => {
  const value = typed.trim();
  if (value === "") return "empty";
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return "empty";
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\./.test(host)
  ) {
    return "localhost";
  }
  return url.protocol === "https:" ? null : "not-https";
};

/**
 * Whether what was pasted can be an environment's T3 Connect address (the
 * MCP URL T3 Code copies). The rule is the contract's, which the server
 * applies too; localhost is named first here as well.
 */
export const connectProblem = (
  pasted: string,
): "empty" | "localhost" | "not-https" | "not-t3-connect" | null => {
  if (addressProblem(pasted) === "localhost") return "localhost";
  const found = t3ConnectOrigin(pasted);
  return "problem" in found ? found.problem : null;
};

export interface EnvironmentState {
  readonly label: string;
  readonly tone: BadgeTone;
  /** What the sign-in button says, or null when there is nothing to do. */
  readonly action: "Sign in" | "Sign in again" | null;
}

/** An environment's state as the list shows it. A sign-in that has run out reads as one that ended. */
export const environmentState = (
  environment: Pick<T3Environment, "status" | "tokenExpiresAt">,
  now: number = Date.now(),
): EnvironmentState => {
  if (environment.status === "pending") {
    return { label: "Not signed in", tone: "neutral", action: "Sign in" };
  }
  const expired =
    environment.tokenExpiresAt !== null && Date.parse(environment.tokenExpiresAt) <= now;
  if (environment.status === "error" || expired) {
    return { label: "Sign-in ended", tone: "danger", action: "Sign in again" };
  }
  return { label: "Connected", tone: "success", action: null };
};
