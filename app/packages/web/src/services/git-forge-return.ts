/**
 * Where the app sends a browser back to on git.infrawrench.com once a
 * payment the forge started is over, one way or another: a short username
 * (`git-username-checkout.ts`) or a workspace (`git-workspace-checkout.ts`).
 */
import { gitBaseUrl } from "@infrawrench/server-core/ci/source";

/**
 * Whether `path` is a path on the forge and nothing else. A URL parser drops
 * tabs and newlines, which would turn `/<tab>/host` into another site, so
 * control characters are refused here and the origin is checked again once
 * the URL is built.
 */
const isForgePath = (path: string | null | undefined): path is string =>
  typeof path === "string" &&
  /^\/(?![/\\])/.test(path) &&
  !path.includes("\\") &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f-\u009f]/.test(path);

/**
 * A page on the forge, with `?<param>=<state>` saying why the browser is
 * back. `returnPath` was written by the forge, but it becomes a redirect:
 * only ever a path on that site, and `fallback` when it is anything else.
 */
export function gitForgeReturnUrl(input: {
  readonly returnPath: string | null | undefined;
  readonly fallback: string;
  readonly param: string;
  readonly state: string;
}): string {
  const forge = new URL(gitBaseUrl());
  let url = new URL(isForgePath(input.returnPath) ? input.returnPath : input.fallback, forge);
  if (url.origin !== forge.origin) url = new URL(input.fallback, forge);
  url.searchParams.set(input.param, input.state);
  return url.toString();
}

/** The app's own origin, for the URL Stripe sends the browser back to. */
export function appUrl(): string {
  return (process.env["APP_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
}
