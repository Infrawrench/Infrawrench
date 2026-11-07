import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { DockerHubClient } from "../client.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";
const ID = `${ACCOUNT}:dockerhub-repository:acme/api`;
const ROUTE = "/v2/namespaces/acme/repositories/api/immutabletags";

function edit(
  stored: { enabled: boolean; rules: string[] } | undefined,
  fields: Record<string, string>,
  answer: (body: unknown) => unknown = () => ({}),
) {
  const { http, calls } = makeHttp((call: Call) => {
    if (call.url.pathname === "/v2/auth/token") return { access_token: "jwt-1" };
    if (call.method === "PATCH") return answer(call.body);
    return {
      namespace: "acme",
      name: "api",
      ...(stored ? { immutable_tags_settings: stored } : {}),
    };
  });
  const c = hostClient(
    new DockerHubClient({ username: "alice", token: "dckr_pat_x", namespaces: "alice" }, {
      http,
    } as never),
  );
  return {
    done: c.updateResource("dockerhub-repository", ID, ACCOUNT, fields),
    patch: () => calls.find((x) => x.method === "PATCH" && x.url.pathname === ROUTE)?.body,
  };
}

describe("editing immutable tag rules", () => {
  it("sends an empty list when the rules are emptied, so the stored ones go", async () => {
    const { done, patch } = edit(
      { enabled: true, rules: ["^v"] },
      { immutableTagsRules: "" },
      () => ({ immutable_tags_settings: { enabled: true, rules: [] } }),
    );
    await done;
    expect(patch()).toEqual({ immutable_tags: true, immutable_tags_rules: [] });
  });

  it("fails when Docker Hub answers with the rules it was told to drop", async () => {
    const { done } = edit({ enabled: true, rules: ["^v"] }, { immutableTagsRules: "" }, () => ({
      immutable_tags_settings: { enabled: true, rules: ["^v"] },
    }));
    await expect(done).rejects.toThrow(/kept/);
  });

  it("accepts a catch-all in place of the rules it dropped", async () => {
    const { done } = edit({ enabled: true, rules: ["^v"] }, { immutableTagsRules: "" }, () => ({
      immutable_tags_settings: { enabled: true, rules: [".*"] },
    }));
    await expect(done).resolves.toBeDefined();
  });

  it("says nothing about rules when there are none, as Docker's own client does", async () => {
    const { done, patch } = edit({ enabled: true, rules: [] }, { immutableTags: "false" });
    await done;
    expect(patch()).toEqual({ immutable_tags: false });
  });

  it("does not clear anything when the form sends an empty field for no rules", async () => {
    const { done, patch } = edit(
      { enabled: false, rules: [] },
      { immutableTags: "true", immutableTagsRules: "" },
    );
    await done;
    expect(patch()).toEqual({ immutable_tags: true });
  });

  it("keeps the stored rules through a change of the switch", async () => {
    const { done, patch } = edit(
      { enabled: true, rules: ["^v", "^rel"] },
      { immutableTags: "off" },
    );
    await done;
    expect(patch()).toEqual({ immutable_tags: false, immutable_tags_rules: ["^v", "^rel"] });
  });

  it("leaves rules it was not told about alone when a read does not report them", async () => {
    const { done, patch } = edit(undefined, { immutableTags: "true" });
    await done;
    expect(patch()).toEqual({ immutable_tags: true });
  });

  it("keeps a comma that is part of a rule in that rule", async () => {
    const { done, patch } = edit(
      { enabled: true, rules: [] },
      { immutableTagsRules: String.raw`^v\d{1,3}$, ^rel-[a,b]$,(x,y)+, a\,b` },
    );
    await done;
    expect(patch()).toEqual({
      immutable_tags: true,
      immutable_tags_rules: [String.raw`^v\d{1,3}$`, "^rel-[a,b]$", "(x,y)+", String.raw`a\,b`],
    });
  });
});
