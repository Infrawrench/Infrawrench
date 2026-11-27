/**
 * The model a T3 Code thread runs: reading an environment's providers and
 * models, the choice when nobody made one, and a launch that is refused for
 * want of a model and sent again. Against the fake environment
 * (`helpers/fake-t3.ts`) over the real MCP client. No database.
 */
import { describe, expect, it } from "vitest";
import { type FakeT3, fakeT3 } from "../../__tests__/helpers/fake-t3";
import { T3Error, makeT3Http } from "../http";
import { McpClient } from "../mcp";
import { choiceName, choiceOf, pickModel, providersOf, selectionOf, wantsModel } from "../models";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  pkceChallenge,
  randomToken,
  registerClient,
} from "../oauth";
import { type WorkToStart, launchThread, modelsOf } from "../work";

const SITE = ["git.example.test"];
const SITE_ORIGIN = "https://git.example.test";
const REDIRECT = `${SITE_ORIGIN}/auth/t3/callback`;

/** A client of the fake, signed in the way the forge signs in. */
const clientOf = async (t3: FakeT3): Promise<McpClient> => {
  const http = makeT3Http({ fetch: t3.fetch, siteHosts: SITE });
  const found = await discover(http, t3.origin, SITE);
  const client = await registerClient(http, found.endpoints, { redirectUri: REDIRECT });
  const verifier = randomToken();
  const url = authorizeUrl(found.endpoints, {
    clientId: client.clientId,
    redirectUri: REDIRECT,
    state: "state-1",
    challenge: await pkceChallenge(verifier),
    resource: found.resource,
    scopes: found.scopes,
  });
  const tokens = await exchangeCode(http, found.endpoints, client, {
    code: t3.approve(url).code,
    redirectUri: REDIRECT,
    verifier,
    resource: found.resource,
  });
  return new McpClient({ http, url: `${t3.origin}/mcp`, token: async () => tokens.accessToken });
};

const work: WorkToStart = {
  repository: { owner: "acme", name: "api" },
  pullRequestId: "pull-1",
  key: "work-add-rate-limits",
  title: "Add rate limits",
  ask: "Add rate limits\n\nPer key, 100 a minute.",
  branch: "work/add-rate-limits",
  baseRef: "main",
};

const withProject = (t3: FakeT3, defaultModelSelection?: Record<string, unknown>): string => {
  t3.projects.push({
    id: "p1",
    title: "acme/api",
    workspaceRoot: "/w/api",
    remoteUrl: "https://git.example.test/acme/api.git",
    ...(defaultModelSelection === undefined ? {} : { defaultModelSelection }),
  });
  return "p1";
};

const launches = (t3: FakeT3) => t3.calls.filter((call) => call.tool === "t3_thread_launch");

describe("reading an environment's models", () => {
  it("lists the providers that can run a thread, with each model's reasoning levels", () => {
    const t3 = fakeT3();
    expect(providersOf({ providers: t3.providers })).toEqual([
      {
        id: "codex",
        name: "Codex",
        models: [
          {
            id: "gpt-6-astra",
            label: "GPT-6 Astra",
            reasoning: {
              optionId: "reasoningEffort",
              levels: ["low", "medium", "high"],
              default: "medium",
            },
          },
        ],
      },
      {
        id: "claudeAgent",
        name: "Claude",
        models: [
          {
            id: "claude-opus-5-5",
            label: "Claude Opus 5.5",
            reasoning: {
              optionId: "effort",
              levels: ["low", "medium", "high", "xhigh"],
              default: "high",
            },
          },
          { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", reasoning: null },
        ],
      },
    ]);
  });

  it("reads whatever a version answers without failing", () => {
    expect(providersOf(null)).toEqual([]);
    expect(providersOf({ providers: "none" })).toEqual([]);
    expect(
      providersOf({
        providers: [
          null,
          { providerInstanceId: "empty", models: [] },
          { models: [{ id: "nameless" }] },
          {
            providerInstanceId: "bare",
            driverKind: "pi",
            displayName: null,
            // No label: it only restated the id. A boolean option is not a level.
            models: [
              { id: "default", options: [{ id: "thinking", values: [false, true] }] },
              { id: 7 },
              { id: "odd", options: [{ id: "effort", values: [true, "max"], default: "gone" }] },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "bare",
        name: "pi",
        models: [
          { id: "default", label: "default", reasoning: null },
          {
            id: "odd",
            label: "odd",
            reasoning: { optionId: "effort", levels: ["max"], default: null },
          },
        ],
      },
    ]);
  });

  it("reads a model selection in either shape T3 Code has written it", () => {
    expect(
      choiceOf({
        instanceId: "codex",
        model: "gpt-6-astra",
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "high" },
        ],
      }),
    ).toEqual({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoning: { optionId: "reasoningEffort", level: "high" },
    });
    expect(choiceOf({ provider: "claudeAgent", model: "m", options: { effort: "low" } })).toEqual({
      providerId: "claudeAgent",
      model: "m",
      reasoning: { optionId: "effort", level: "low" },
    });
    expect(choiceOf({ instanceId: "codex", model: "m" })).toEqual({
      providerId: "codex",
      model: "m",
    });
    expect(choiceOf(null)).toBeNull();
    expect(choiceOf({ instanceId: "codex" })).toBeNull();
  });

  it("writes a choice as T3 Code's modelSelection", () => {
    expect(selectionOf({ providerId: "codex", model: "m" })).toEqual({
      instanceId: "codex",
      model: "m",
    });
    expect(
      selectionOf({
        providerId: "claudeAgent",
        model: "m",
        reasoning: { optionId: "effort", level: "xhigh" },
      }),
    ).toEqual({
      instanceId: "claudeAgent",
      model: "m",
      options: [{ id: "effort", value: "xhigh" }],
    });
  });

  it("names a choice with the environment's names", () => {
    const providers = providersOf({ providers: fakeT3().providers });
    expect(choiceName({ providerId: "codex", model: "gpt-6-astra" }, providers)).toBe(
      "Codex, GPT-6 Astra",
    );
    // The model already says whose it is.
    expect(choiceName({ providerId: "claudeAgent", model: "claude-opus-5-5" }, providers)).toBe(
      "Claude Opus 5.5",
    );
    expect(choiceName({ providerId: "gone", model: "m" }, providers)).toBe("gone, m");
  });
});

describe("choosing a model when nobody did", () => {
  it("prefers a Claude model, at the model's own reasoning level", () => {
    expect(pickModel({ providers: fakeT3().providers })).toEqual({
      providerId: "claudeAgent",
      model: "claude-opus-5-5",
      reasoning: { optionId: "effort", level: "high" },
    });
  });

  it("takes the first provider's first model when there is no Claude", () => {
    const providers = fakeT3().providers.filter((each) => each.driverKind !== "claudeAgent");
    expect(pickModel({ providers })).toEqual({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoning: { optionId: "reasoningEffort", level: "medium" },
    });
  });

  it("takes what the environment says it would inherit, when it says", () => {
    expect(
      pickModel({
        inheritedProviderInstanceId: "codex",
        inheritedModel: "gpt-6-astra",
        inheritedOptions: [{ id: "reasoningEffort", value: "low" }],
        providers: fakeT3().providers,
      }),
    ).toEqual({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoning: { optionId: "reasoningEffort", level: "low" },
    });
    // A provider that cannot run is not inherited.
    expect(
      pickModel({
        inheritedProviderInstanceId: "cursor",
        inheritedModel: "auto",
        providers: fakeT3().providers,
      }),
    ).toMatchObject({ providerId: "claudeAgent" });
  });

  it("picks nothing where nothing can run", () => {
    expect(pickModel({ providers: [] })).toBeNull();
    expect(pickModel(null)).toBeNull();
  });

  it("knows T3 Code's refusal for want of a model", () => {
    expect(
      wantsModel(
        "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
      ),
    ).toBe(true);
    expect(
      wantsModel("Project p1 has no default model, so this caller cannot pick one for it."),
    ).toBe(true);
    expect(wantsModel("The worktree could not be made.")).toBe(false);
  });
});

describe("the model picker's list", () => {
  it("answers the default of the repository's project", async () => {
    const t3 = fakeT3();
    const client = await clientOf(t3);
    expect((await modelsOf(client, work.repository, SITE_ORIGIN)).default).toBeNull();
    withProject(t3, {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "xhigh" }],
    });
    const models = await modelsOf(client, work.repository, SITE_ORIGIN);
    expect(models.default).toEqual({
      providerId: "claudeAgent",
      model: "claude-opus-5-5",
      reasoning: { optionId: "effort", level: "xhigh" },
    });
    expect(models.providers.map((each) => each.id)).toEqual(["codex", "claudeAgent"]);
    // Another repository's project is not this one's default.
    expect(
      (await modelsOf(client, { owner: "acme", name: "other" }, SITE_ORIGIN)).default,
    ).toBeNull();
    expect((await modelsOf(client, null, SITE_ORIGIN)).default).toBeNull();
  });

  it("keeps a default the short list left out, and drops one that cannot run", async () => {
    const t3 = fakeT3();
    const client = await clientOf(t3);
    withProject(t3, { instanceId: "codex", model: "gpt-5.6-sol" });
    const models = await modelsOf(client, work.repository, SITE_ORIGIN);
    expect(models.default).toEqual({ providerId: "codex", model: "gpt-5.6-sol" });
    expect(models.providers[0]!.models.map((each) => each.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-6-astra",
    ]);

    t3.projects[0]!.defaultModelSelection = { instanceId: "cursor", model: "auto" };
    expect((await modelsOf(client, work.repository, SITE_ORIGIN)).default).toBeNull();
  });

  it("stands the model's own level in for one the model does not list", async () => {
    const t3 = fakeT3();
    const client = await clientOf(t3);
    withProject(t3, {
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "ultra" }],
    });
    expect((await modelsOf(client, work.repository, SITE_ORIGIN)).default).toEqual({
      providerId: "codex",
      model: "gpt-6-astra",
      reasoning: { optionId: "reasoningEffort", level: "medium" },
    });
  });
});

describe("launching a thread", () => {
  it("sends the model the person chose", async () => {
    const t3 = fakeT3();
    t3.requireModel = true;
    const client = await clientOf(t3);
    const started = await launchThread(
      client,
      withProject(t3),
      {
        ...work,
        model: {
          providerId: "codex",
          model: "gpt-6-astra",
          reasoning: { optionId: "reasoningEffort", level: "high" },
        },
      },
      SITE_ORIGIN,
    );
    expect(launches(t3)).toHaveLength(1);
    expect(launches(t3)[0]!.args["modelSelection"]).toEqual({
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(started.model).toEqual({
      providerId: "codex",
      modelId: "gpt-6-astra",
      name: "Codex, GPT-6 Astra",
      reasoningLevel: "high",
      picked: false,
    });
  });

  it("runs the project's default when nobody chose, and says which model that was", async () => {
    const t3 = fakeT3();
    t3.requireModel = true;
    const client = await clientOf(t3);
    const projectId = withProject(t3, { instanceId: "claudeAgent", model: "claude-haiku-5-5" });
    const started = await launchThread(client, projectId, work, SITE_ORIGIN);
    expect(launches(t3)).toHaveLength(1);
    expect(launches(t3)[0]!.args["modelSelection"]).toBeUndefined();
    expect(started.model).toEqual({
      providerId: "claudeAgent",
      modelId: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      reasoningLevel: null,
      picked: false,
    });
  });

  it("picks a model and launches again when the project has no default", async () => {
    const t3 = fakeT3();
    t3.requireModel = true;
    const client = await clientOf(t3);
    const started = await launchThread(client, withProject(t3), work, SITE_ORIGIN);
    expect(t3.calls.map((call) => call.tool)).toEqual([
      "t3_thread_launch",
      "orchestrator_capabilities",
      "t3_thread_launch",
    ]);
    const [refused, retried] = launches(t3);
    expect(refused!.args["modelSelection"]).toBeUndefined();
    expect(retried!.args["modelSelection"]).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    // The same key both times: whichever try made the thread, a later one finds it.
    expect(retried!.args["clientRequestId"]).toBe("infrawrench-git:work:pull-1");
    expect(refused!.args["clientRequestId"]).toBe(retried!.args["clientRequestId"]);
    expect(t3.threads).toHaveLength(1);
    expect(started).toMatchObject({
      threadId: t3.threads[0]!.threadId,
      model: {
        providerId: "claudeAgent",
        modelId: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        reasoningLevel: "high",
        picked: true,
      },
    });
  });

  it("finds the first try's thread when asked again, with that thread's model", async () => {
    const t3 = fakeT3();
    t3.requireModel = true;
    const client = await clientOf(t3);
    const projectId = withProject(t3);
    const first = await launchThread(client, projectId, work, SITE_ORIGIN);
    // Try again, choosing another model: the thread exists, and keeps the model it has.
    const again = await launchThread(
      client,
      projectId,
      { ...work, model: { providerId: "codex", model: "gpt-6-astra" } },
      SITE_ORIGIN,
    );
    expect(t3.threads).toHaveLength(1);
    expect(again.threadId).toBe(first.threadId);
    expect(again.model).toMatchObject({ modelId: "claude-opus-5-5", picked: false });
  });

  it("passes T3 Code's sentence on when there is nothing to pick, or the refusal is another", async () => {
    const t3 = fakeT3();
    t3.requireModel = true;
    const client = await clientOf(t3);
    const projectId = withProject(t3);
    t3.providers.length = 0;
    await expect(launchThread(client, projectId, work, SITE_ORIGIN)).rejects.toThrow(
      "Pass modelSelection: the project has no default model.",
    );

    const other = fakeT3();
    const otherClient = await clientOf(other);
    other.failNext["t3_thread_launch"] = "The worktree could not be made.";
    const refusal = await launchThread(otherClient, withProject(other), work, SITE_ORIGIN).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(T3Error);
    expect((refusal as T3Error).message).toBe("The worktree could not be made.");
    // Not sent again: only a refusal for want of a model is.
    expect(launches(other)).toHaveLength(1);
    expect(other.threads).toHaveLength(0);
  });

  it("refuses a model the environment does not have, in its words", async () => {
    const t3 = fakeT3();
    const client = await clientOf(t3);
    await expect(
      launchThread(
        client,
        withProject(t3),
        { ...work, model: { providerId: "codex", model: "gone" } },
        SITE_ORIGIN,
      ),
    ).rejects.toThrow("Model gone is not advertised.");
    expect(launches(t3)).toHaveLength(1);
  });

  it("starts the thread even when the names cannot be read", async () => {
    const t3 = fakeT3();
    const client = await clientOf(t3);
    const projectId = withProject(t3, { instanceId: "codex", model: "gpt-6-astra" });
    t3.failNext["orchestrator_capabilities"] = "Unable to read server settings.";
    const started = await launchThread(client, projectId, work, SITE_ORIGIN);
    expect(started.model).toMatchObject({ name: "codex, gpt-6-astra", picked: false });
  });
});
