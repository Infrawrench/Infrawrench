// @vitest-environment node
import { describe, expect, it } from "vitest";
import config from "../../../vite.config";

/** As Vite decides it: a key that starts with `^` is a regular expression over the URL, query included. */
const proxied = (url: string): boolean =>
  Object.keys((config as { server: { proxy: Record<string, unknown> } }).server.proxy).some(
    (key) => (key.startsWith("^") ? new RegExp(key).test(url) : url.startsWith(key)),
  );

describe("the dev server's proxy", () => {
  it("sends the Worker's own routes to the Worker", () => {
    for (const url of [
      "/api/session",
      "/auth/sign-in",
      "/acme/infra.git/info/refs?service=git-upload-pack",
      "/acme/infra.git/git-receive-pack",
      "/acme/infra/raw/0123/README.md",
      "/acme/infra/archive/main.zip",
      "/acme/infra/terraform/prod/state",
      "/acme/infra/terraform/prod/state/lock",
      // Terraform saves a state and unlocks with the lock's id in the query.
      "/acme/infra/terraform/prod/state?ID=7f3a",
    ]) {
      expect(proxied(url), url).toBe(true);
    }
  });

  it("keeps the UI's pages", () => {
    for (const url of [
      "/",
      "/acme/infra",
      "/acme/infra/tree/main/terraform",
      "/acme/infra/infrastructure/prod/state",
      "/acme/infra/blob/main/archive/notes.md",
    ]) {
      expect(proxied(url), url).toBe(false);
    }
  });
});
