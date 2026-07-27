/**
 * Create handlers for DigitalOcean Gradient AI: agents, knowledge bases, model
 * routers, dedicated inference endpoints and agent API keys.
 */
import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { regionDisplay } from "../constants.js";
import { buildProjectField, type DoCreateArgs, type DoCreateContext } from "./shared.js";

/**
 * Build the create form for the types this module owns. Returns `null` when
 * `typeId` belongs to another module so the dispatcher can try the next one.
 */
export async function genaiGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "gen-ai-agent") {
    // GenAI agents need to be tied to a foundation model. Fetch the
    // available agent-usecase models so the user can pick one rather than
    // pasting a UUID. The regions list comes from the GenAI regions endpoint
    // (separate from /v2/regions, which only covers the classic IaaS
    // footprint — GenAI is only deployed in a subset).
    const [models, routers, regions, workspaces, projectField] = await Promise.all([
      ctx
        .fetch<{
          models?: Array<{
            uuid?: string;
            name?: string;
            provider?: { name?: string };
          }>;
        }>("/gen-ai/models?usecases=MODEL_USECASE_AGENT&per_page=200")
        .catch(() => ({ models: [] })),
      ctx
        .fetch<{
          model_routers?: Array<{ uuid?: string; name?: string }>;
        }>("/gen-ai/models/routers?per_page=200")
        .catch(() => ({ model_routers: [] })),
      ctx
        .fetch<{
          regions?: Array<{ region: string; serves_inference?: boolean }>;
        }>("/gen-ai/regions")
        .catch(() => ({ regions: [] })),
      ctx
        .fetch<{
          workspaces?: Array<{ uuid?: string; name?: string }>;
        }>("/gen-ai/workspaces")
        .catch(() => ({ workspaces: [] })),
      buildProjectField(ctx, parentResourceId),
    ]);
    const modelOptions = (models.models ?? []).map((m) => ({
      id: String(m.uuid ?? ""),
      label: `${String(m.name ?? "")}${m.provider?.name ? ` (${m.provider.name})` : ""}`,
    }));
    const routerOptions = (routers.model_routers ?? []).map((r) => ({
      id: String(r.uuid ?? ""),
      label: String(r.name ?? r.uuid ?? ""),
    }));
    const workspaceOptions = (workspaces.workspaces ?? []).map((w) => ({
      id: String(w.uuid ?? ""),
      label: String(w.name ?? w.uuid ?? ""),
    }));
    const regionOptions = (regions.regions ?? [])
      .filter((r) => r.serves_inference !== false)
      .map((r) => {
        const info = regionDisplay(r.region);
        return {
          id: r.region,
          label: r.region,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    // Toggle between a single foundation model and an Inference Router.
    // DO's API accepts `model_uuid` XOR `model_router_uuid` (mutually
    // exclusive — sending both is a 400), so we gate the two pickers
    // with showWhen and require at most one at create time.
    const hasRouters = routerOptions.length > 0;
    return {
      fields: [
        { key: "name", label: "Agent Name", kind: "text", required: true },
        ...projectField,
        {
          key: "workspaceUuid",
          label: "Workspace",
          kind: "select",
          required: false,
          options: workspaceOptions,
          ...(workspaceOptions[0] ? { defaultValue: workspaceOptions[0].id } : {}),
          description:
            workspaceOptions.length === 0
              ? "No workspaces in this team yet — leave empty to auto-create a 'default' workspace, or click '+ New workspace' to pick a name."
              : "Workspace this agent will belong to. Use '+ New workspace' to create another.",
          actions: [
            {
              id: "create-workspace",
              label: "+ New workspace",
              description: "Create a new GenAI workspace and attach this agent to it.",
              submitLabel: "Create workspace",
              formFields: [
                {
                  key: "name",
                  label: "Workspace Name",
                  kind: "text",
                  required: true,
                  placeholder: "default",
                },
                {
                  key: "description",
                  label: "Description",
                  kind: "text",
                  required: false,
                },
              ],
            },
          ],
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(regionOptions[0] ? { defaultValue: regionOptions[0].id } : {}),
        },
        {
          key: "modelSource",
          label: "Model Source",
          kind: "select",
          required: true,
          defaultValue: "model",
          options: [
            { id: "model", label: "Single foundation model" },
            {
              id: "router",
              label: hasRouters
                ? "Inference Router (auto-pick model per call)"
                : "Inference Router (none configured yet — create one first)",
            },
          ],
          description:
            "Pick one foundation model, or route requests through an Inference Router that " +
            "picks the right model per call based on prompt complexity.",
        },
        {
          key: "modelUuid",
          label: "Foundation Model",
          kind: "select",
          required: false,
          options: modelOptions,
          ...(modelOptions[0] ? { defaultValue: modelOptions[0].id } : {}),
          description: "Foundation model that powers the agent's responses.",
          showWhen: { fieldKey: "modelSource", fieldValue: "model" },
        },
        {
          key: "modelRouterUuid",
          label: "Inference Router",
          kind: "select",
          required: false,
          options: routerOptions,
          ...(routerOptions[0] ? { defaultValue: routerOptions[0].id } : {}),
          description:
            "Pick an existing Inference Router or create a new one inline. The router's policies and fallback models govern which underlying model serves each request.",
          showWhen: { fieldKey: "modelSource", fieldValue: "router" },
          actions: [
            {
              id: "create-inference-router",
              label: "+ New router",
              description: "Create a new Inference Router and attach it to this agent in one step.",
              submitLabel: "Create router",
              formFields: [
                {
                  key: "name",
                  label: "Router Name",
                  kind: "text",
                  required: true,
                  placeholder: "my-router",
                },
                {
                  key: "description",
                  label: "Description",
                  kind: "text",
                  required: false,
                },
                {
                  key: "fallbackModels",
                  label: "Fallback Models",
                  kind: "select",
                  required: false,
                  options: modelOptions,
                  description:
                    "Comma-separated list of fallback model UUIDs the router can use. Optional — the router can be configured fully later.",
                },
              ],
            },
          ],
        },
        {
          key: "instruction",
          label: "Instruction",
          kind: "text",
          required: false,
          multiline: true,
          description:
            "System prompt — guidance for the agent's behaviour and persona. Long-form supported.",
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
      ],
    };
  }

  if (typeId === "gen-ai-knowledge-base") {
    const [models, regions, projectField] = await Promise.all([
      ctx
        .fetch<{
          models?: Array<{ uuid?: string; name?: string }>;
        }>("/gen-ai/models?usecases=MODEL_USECASE_KNOWLEDGEBASE&per_page=200")
        .catch(() => ({ models: [] })),
      ctx
        .fetch<{
          regions?: Array<{ region: string; serves_inference?: boolean }>;
        }>("/gen-ai/regions")
        .catch(() => ({ regions: [] })),
      buildProjectField(ctx, parentResourceId),
    ]);
    const modelOptions = (models.models ?? []).map((m) => ({
      id: String(m.uuid ?? ""),
      label: String(m.name ?? ""),
    }));
    const regionOptions = (regions.regions ?? [])
      .filter((r) => r.serves_inference !== false)
      .map((r) => {
        const info = regionDisplay(r.region);
        return {
          id: r.region,
          label: r.region,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    return {
      fields: [
        { key: "name", label: "Knowledge Base Name", kind: "text", required: true },
        ...projectField,
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(regionOptions[0] ? { defaultValue: regionOptions[0].id } : {}),
        },
        {
          key: "embeddingModelUuid",
          label: "Embedding Model",
          kind: "select",
          required: true,
          options: modelOptions,
          ...(modelOptions[0] ? { defaultValue: modelOptions[0].id } : {}),
          description: "Embedding model used to vectorize indexed documents.",
        },
        {
          key: "tags",
          label: "Tags",
          kind: "string-list",
          required: false,
          placeholder: "tag",
          addLabel: "+ Add tag",
          description: "Tags for organisation.",
        },
      ],
    };
  }

  if (typeId === "gen-ai-model-router") {
    // No region picker — DO deploys routers to all regions and rejects any
    // explicit `regions`. Fallback/policy models must come from DO's router
    // presets (arbitrary serverless model UUIDs are rejected as "not found"),
    // so we offer a preset picker and pass its config through on create.
    const presetsRes = await ctx
      .fetch<{
        presets?: Array<{ slug?: string; display_name?: string; short_description?: string }>;
      }>("/gen-ai/models/routers/presets?per_page=200")
      .catch(() => ({ presets: [] }));
    const presetOptions = (presetsRes.presets ?? [])
      .filter((p) => p.slug)
      .map((p) => ({
        id: String(p.slug),
        label: p.display_name ? String(p.display_name) : String(p.slug),
      }));
    return {
      fields: [
        { key: "name", label: "Router Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: false },
        ...(presetOptions.length > 0
          ? [
              {
                key: "presetSlug",
                label: "Routing preset",
                kind: "select" as const,
                required: false,
                options: [{ id: "", label: "None — configure models later" }, ...presetOptions],
                defaultValue: presetOptions[0]?.id ?? "",
                description:
                  "Prefills the router with DigitalOcean's recommended models and routing policies. You can refine them later in the DO console.",
              },
            ]
          : []),
      ],
    };
  }

  if (typeId === "dedicated-inference") {
    // Pull both the size catalog (region+GPU+pricing) and the GPU model
    // config catalog (what model_id each accelerator can serve) so the
    // user can pick a region/size that's actually viable for their model.
    const [sizes, accelerators] = await Promise.all([
      ctx
        .fetch<{
          regions?: Array<{
            region: string;
            sizes?: Array<{ slug: string; gpu_count: number; price_monthly?: number }>;
          }>;
        }>("/dedicated-inferences/sizes")
        .catch(() => ({ regions: [] })),
      ctx
        .fetch<{
          accelerators?: Array<{ slug?: string; model_id?: string; name?: string }>;
        }>("/dedicated-inferences/accelerators")
        .catch(() => ({ accelerators: [] })),
    ]);
    const regionOptions = (sizes.regions ?? []).map((r) => {
      const info = regionDisplay(r.region);
      return {
        id: r.region,
        label: r.region,
        ...(info ? { location: info.location, flag: info.flag } : {}),
      };
    });
    const sizeOptions = (sizes.regions ?? []).flatMap((r) =>
      (r.sizes ?? []).map((s) => ({
        id: s.slug,
        label: s.price_monthly
          ? `${s.slug} (${s.gpu_count}× GPU, $${Math.round(s.price_monthly)}/mo)`
          : `${s.slug} (${s.gpu_count}× GPU)`,
      })),
    );
    const modelOptions = (accelerators.accelerators ?? []).map((a) => ({
      id: String(a.model_id ?? a.slug ?? ""),
      label: String(a.name ?? a.model_id ?? a.slug ?? ""),
    }));
    return {
      fields: [
        { key: "name", label: "Deployment Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(regionOptions[0] ? { defaultValue: regionOptions[0].id } : {}),
        },
        {
          key: "size",
          label: "GPU Size",
          kind: "select",
          required: true,
          options: sizeOptions,
          description: "Accelerator size — GPU count and monthly price.",
        },
        {
          key: "modelId",
          label: "Model",
          kind: "select",
          required: true,
          options: modelOptions,
          description: "Model deployed on this dedicated inference instance.",
        },
        {
          key: "enablePublicEndpoint",
          label: "Public Endpoint",
          kind: "select",
          required: true,
          defaultValue: "false",
          options: [
            { id: "true", label: "Public + VPC" },
            { id: "false", label: "VPC only" },
          ],
          description: "Expose a public HTTPS endpoint in addition to the private VPC FQDN.",
        },
        {
          key: "vpcUuid",
          label: "VPC",
          kind: "text",
          required: false,
          description: "Optional VPC UUID. Defaults to the region's default VPC when empty.",
        },
        {
          key: "huggingFaceToken",
          label: "Hugging Face Token",
          kind: "text",
          required: false,
          description: "Required only for gated Hugging Face models.",
        },
      ],
    };
  }

  if (typeId === "agent-api-key") {
    if (!parentResourceId) {
      const list = await ctx
        .fetch<{ agents?: Array<{ uuid?: string; name?: string }> }>("/gen-ai/agents?per_page=200")
        .catch(() => ({ agents: [] }));
      const options = (list.agents ?? []).map((a) => ({
        id: String(a.uuid ?? ""),
        label: String(a.name ?? a.uuid ?? ""),
      }));
      return {
        fields: [
          {
            key: "agentUuid",
            label: "Agent",
            kind: "select",
            required: true,
            options,
            ...(options[0] ? { defaultValue: options[0].id } : {}),
            description: "Agent this access key will authenticate against.",
          },
          { key: "name", label: "Key Name", kind: "text", required: true },
        ],
      };
    }
    return {
      fields: [{ key: "name", label: "Key Name", kind: "text", required: true }],
    };
  }

  return null;
}

/**
 * Create one of the types this module owns. Returns `null` when `typeId`
 * belongs to another module.
 */
export async function genaiCreateResource(args: DoCreateArgs): Promise<ResourceInstance | null> {
  const { ctx, typeId, accountId, fields, parentResourceId, parentExternalId } = args;
  if (typeId === "gen-ai-agent") {
    // `model_uuid` and `model_router_uuid` are mutually exclusive in DO's
    // API — the form's `modelSource` toggle decides which one we send.
    const useRouter = fields["modelSource"] === "router";
    const modelSourceFields: Record<string, unknown> = useRouter
      ? fields["modelRouterUuid"]
        ? { model_router_uuid: fields["modelRouterUuid"] }
        : {}
      : fields["modelUuid"]
        ? { model_uuid: fields["modelUuid"] }
        : {};
    if (Object.keys(modelSourceFields).length === 0) {
      throw new Error(
        useRouter
          ? "Pick an Inference Router (or switch the Model Source back to a foundation model)."
          : "Pick a Foundation Model (or switch the Model Source to an Inference Router).",
      );
    }

    // DO's GenAI plane scopes agents to a workspace. New accounts have no
    // workspaces — the DO console auto-creates one transparently. Match
    // that UX: if the user didn't pick (or there are none), look one up,
    // and create a "default" workspace if there are still none. The
    // workspace picker's inline-create FieldAction covers the case where
    // the user wants to pick a name explicitly.
    let workspaceUuid = String(fields["workspaceUuid"] ?? "").trim();
    if (!workspaceUuid) {
      const list = await ctx
        .fetch<{ workspaces?: Array<{ uuid?: string }> }>("/gen-ai/workspaces")
        .catch(() => ({ workspaces: [] }));
      workspaceUuid = String(list.workspaces?.[0]?.uuid ?? "");
      if (!workspaceUuid) {
        const created = await ctx.fetch<{ workspace: { uuid?: string } }>("/gen-ai/workspaces", {
          method: "POST",
          body: JSON.stringify({
            name: "default",
            description: "Auto-created by Infrawrench for first agent",
          }),
        });
        workspaceUuid = String(created.workspace?.uuid ?? "");
        if (!workspaceUuid) {
          throw new Error(
            "DigitalOcean did not return a workspace UUID after auto-creating the default workspace. Create one manually in the DO console under Agent Platform → Workspaces and try again.",
          );
        }
      }
    }

    const body: Record<string, unknown> = {
      name: fields["name"],
      ...modelSourceFields,
      region: fields["region"],
      workspace_uuid: workspaceUuid,
      ...(fields["instruction"] ? { instruction: fields["instruction"] } : {}),
      ...(fields["description"] ? { description: fields["description"] } : {}),
      ...(parentExternalId ? { project_id: parentExternalId } : {}),
    };
    const data = await ctx.fetch<{ agent: Record<string, unknown> }>("/gen-ai/agents", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const a = data.agent ?? {};
    const uuid = String(a["uuid"] ?? "");
    const deployment = a["deployment"] as Record<string, unknown> | undefined;
    const deploymentUrl = String(deployment?.["url"] ?? "");
    const respRouter = a["model_router"] as Record<string, unknown> | undefined;
    const respModel = a["model"] as Record<string, unknown> | undefined;
    const now = new Date().toISOString();
    return {
      id: `${accountId}:gen-ai-agent:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-agent",
      accountId,
      displayName: String(a["name"] ?? fields["name"]),
      fields: {
        name: String(a["name"] ?? fields["name"]),
        region: String(a["region"] ?? fields["region"] ?? ""),
        description: String(a["description"] ?? fields["description"] ?? ""),
        instruction: String(a["instruction"] ?? fields["instruction"] ?? ""),
        modelUuid: String(respModel?.["uuid"] ?? (useRouter ? "" : (fields["modelUuid"] ?? ""))),
        modelName: String(respModel?.["name"] ?? ""),
        modelRouterUuid: String(
          respRouter?.["uuid"] ?? (useRouter ? (fields["modelRouterUuid"] ?? "") : ""),
        ),
        modelRouterName: String(respRouter?.["name"] ?? ""),
        projectId: parentExternalId,
        temperature: 0,
        maxTokens: 0,
        k: 0,
        status: String(deployment?.["status"] ?? "provisioning"),
        knowledgeBaseCount: 0,
        deploymentUrl,
      },
      resolvedOutputs: deploymentUrl ? { deploymentUrl, agentEndpoint: deploymentUrl } : {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(a["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "gen-ai-knowledge-base") {
    const body: Record<string, unknown> = {
      name: fields["name"],
      region: fields["region"],
      embedding_model_uuid: fields["embeddingModelUuid"],
      ...(parentExternalId ? { project_id: parentExternalId } : {}),
      ...(fields["tags"]
        ? {
            tags: fields["tags"]
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          }
        : {}),
    };
    const data = await ctx.fetch<{ knowledge_base: Record<string, unknown> }>(
      "/gen-ai/knowledge_bases",
      { method: "POST", body: JSON.stringify(body) },
    );
    const kb = data.knowledge_base ?? {};
    const uuid = String(kb["uuid"] ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:gen-ai-knowledge-base:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-knowledge-base",
      accountId,
      displayName: String(kb["name"] ?? fields["name"]),
      fields: {
        name: String(kb["name"] ?? fields["name"]),
        region: String(kb["region"] ?? fields["region"] ?? ""),
        embeddingModelUuid: String(kb["embedding_model_uuid"] ?? fields["embeddingModelUuid"]),
        databaseId: String(kb["database_id"] ?? ""),
        projectId: String(kb["project_id"] ?? parentExternalId),
        isPublic: "no",
        lastIndexingStatus: "",
        dataSourceCount: 0,
        tags: String(fields["tags"] ?? ""),
      },
      resolvedOutputs: uuid
        ? { retrievalEndpoint: `https://kbaas.do-ai.run/v1/${uuid}/retrieve` }
        : {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(kb["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "gen-ai-model-router") {
    // `regions` is deprecated (omit). Models come from a chosen preset's
    // config — its fallback_models/policies use identifiers DO accepts;
    // passing raw serverless model UUIDs gets rejected as "model not found".
    const body: Record<string, unknown> = {
      name: fields["name"],
      ...(fields["description"] ? { description: fields["description"] } : {}),
    };
    const presetSlug = String(fields["presetSlug"] ?? "").trim();
    if (presetSlug) {
      const presetsRes = await ctx
        .fetch<{
          presets?: Array<{
            slug?: string;
            config?: { fallback_models?: unknown[]; policies?: unknown[] };
          }>;
        }>("/gen-ai/models/routers/presets?per_page=200")
        .catch(() => ({ presets: [] }));
      const preset = (presetsRes.presets ?? []).find((p) => p.slug === presetSlug);
      const cfg = preset?.config;
      if (Array.isArray(cfg?.fallback_models) && cfg.fallback_models.length > 0) {
        body["fallback_models"] = cfg.fallback_models;
      }
      if (Array.isArray(cfg?.policies) && cfg.policies.length > 0) {
        body["policies"] = cfg.policies;
      }
    }
    const data = await ctx.fetch<{ model_router: Record<string, unknown> }>(
      "/gen-ai/models/routers",
      { method: "POST", body: JSON.stringify(body) },
    );
    const r = data.model_router ?? {};
    const uuid = String(r["uuid"] ?? "");
    const now = new Date().toISOString();
    const respConfig = r["config"] as
      | { policies?: unknown[]; fallback_models?: unknown[] }
      | undefined;
    const respFallback = Array.isArray(respConfig?.fallback_models)
      ? (respConfig.fallback_models as string[])
      : [];
    return {
      id: `${accountId}:gen-ai-model-router:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-model-router",
      accountId,
      displayName: String(r["name"] ?? fields["name"]),
      fields: {
        name: String(r["name"] ?? fields["name"]),
        description: String(r["description"] ?? fields["description"] ?? ""),
        regions: "all",
        fallbackModels: respFallback.join(","),
        policyCount: Array.isArray(respConfig?.policies) ? respConfig.policies.length : 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(r["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "dedicated-inference") {
    const body: Record<string, unknown> = {
      spec: {
        name: fields["name"],
        region: fields["region"],
        enable_public_endpoint: fields["enablePublicEndpoint"] === "true",
        ...(fields["vpcUuid"] ? { vpc: { uuid: fields["vpcUuid"] } } : {}),
        model_deployments: [
          {
            model_id: fields["modelId"],
            size: fields["size"],
          },
        ],
      },
      ...(fields["huggingFaceToken"]
        ? { access_tokens: { hugging_face_token: fields["huggingFaceToken"] } }
        : {}),
    };
    // POST returns 202 Accepted with the provisioning record — same shape
    // as GET /dedicated-inferences/{id} but with status `provisioning`.
    const data = await ctx.fetch<{ dedicated_inference: Record<string, unknown> }>(
      "/dedicated-inferences",
      { method: "POST", body: JSON.stringify(body) },
    );
    const d = data.dedicated_inference ?? {};
    const id = String(d["id"] ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:dedicated-inference:${id}`,
      pluginId: "digitalocean",
      resourceTypeId: "dedicated-inference",
      accountId,
      displayName: String(fields["name"]),
      fields: {
        name: String(fields["name"]),
        region: String(d["region"] ?? fields["region"] ?? ""),
        vpcUuid: String(d["vpc_uuid"] ?? fields["vpcUuid"] ?? ""),
        enablePublicEndpoint: fields["enablePublicEndpoint"] === "true" ? "yes" : "no",
        modelCount: 1,
        modelSummary: String(fields["modelId"] ?? ""),
        publicEndpoint: "",
        privateEndpoint: "",
        status: String(d["status"] ?? "provisioning"),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: id,
      createdAt: String(d["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "agent-api-key") {
    // Resolve the parent agent uuid: from parentResourceId when opened
    // from the agent detail page, otherwise from the form field.
    const agentUuid = parentResourceId
      ? parentResourceId.split(":").slice(2).join(":")
      : String(fields["agentUuid"] ?? "");
    if (!agentUuid) throw new Error("Agent UUID is required.");
    // The agent-API-key create response nests everything (including the
    // one-shot secret) inside `api_key_info`. Older/model-key endpoints
    // return a top-level `secret_key`, so read both for resilience.
    const data = await ctx.fetch<{
      api_key_info?: Record<string, unknown>;
      secret_key?: string;
    }>(`/gen-ai/agents/${agentUuid}/api_keys`, {
      method: "POST",
      body: JSON.stringify({ name: fields["name"] }),
    });
    const info = data.api_key_info ?? {};
    const secret = String(info["secret_key"] ?? data.secret_key ?? "");
    const keyUuid = String(info["uuid"] ?? "");
    const externalId = `${agentUuid}/${keyUuid}`;
    const now = new Date().toISOString();
    return {
      id: `${accountId}:agent-api-key:${externalId}`,
      pluginId: "digitalocean",
      resourceTypeId: "agent-api-key",
      accountId,
      displayName: String(info["name"] ?? fields["name"]),
      fields: {
        name: String(info["name"] ?? fields["name"]),
        createdBy: String(info["created_by"] ?? ""),
      },
      resolvedOutputs: secret ? { secretKey: secret } : {},
      secretStates: secret
        ? [
            {
              fieldKey: "secretKey",
              resolution: { kind: "plaintext", value: secret },
            },
          ]
        : [],
      externalId,
      parentResourceId: `${accountId}:gen-ai-agent:${agentUuid}`,
      createdAt: String(info["created_at"] ?? now),
      updatedAt: now,
    };
  }

  return null;
}
