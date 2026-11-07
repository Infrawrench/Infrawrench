/**
 * Create handlers for DigitalOcean Gradient AI: agents, knowledge bases, model
 * routers, dedicated inference endpoints and agent API keys.
 */
import {
  type ApiListItem,
  type CreateResourceConfig,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import { idSegment, PICKER } from "../api.js";
import type { DoResponse } from "../api.js";
import type { operations } from "../api-types.gen.js";
import { regionDisplay } from "../constants.js";
import { vpcOptions } from "./services.js";
import { buildProjectField, type DoCreateArgs, type DoCreateContext } from "./shared.js";

type DoRouterPreset = ApiListItem<operations["genai_list_model_router_presets"], "presets">;

/** The region's default VPC, for what requires one when the user left the choice to it. */
async function defaultVpcIn(ctx: DoCreateContext, region: string): Promise<string> {
  const vpcs = await ctx.api.getAll("/vpcs", "vpcs", PICKER);
  const uuid = vpcs.find((v) => v.default === true && v.region === region)?.id;
  if (!uuid) throw new Error(`Choose a VPC: DigitalOcean reports no default VPC in ${region}.`);
  return uuid;
}

/** The document says a model's provider is an enum string, which has no `name` (#414). */
function providerName(provider: string | { name?: string } | undefined): string | undefined {
  return typeof provider === "object" ? provider.name : undefined;
}

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
    // footprint: GenAI is only deployed in a subset).
    const [models, routers, regions, workspaces, projectField] = await Promise.all([
      ctx.api
        .getAll("/gen-ai/models", "models", {
          ...PICKER,
          query: { usecases: ["MODEL_USECASE_AGENT"] },
        })
        .catch(() => []),
      ctx.api.getAll("/gen-ai/models/routers", "model_routers", PICKER).catch(() => []),
      ctx.api.get("/gen-ai/regions").catch(() => ({ regions: [] })),
      ctx.api.get("/gen-ai/workspaces").catch(() => ({ workspaces: [] })),
      buildProjectField(ctx, parentResourceId),
    ]);
    const modelOptions = models.map((m) => ({
      id: String(m.uuid ?? ""),
      label: `${String(m.name ?? "")}${providerName(m.provider) ? ` (${providerName(m.provider)})` : ""}`,
    }));
    const routerOptions = routers.map((r) => ({
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
    // exclusive: sending both is a 400), so we gate the two pickers
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
              ? "No workspaces yet. Leave empty to create a 'default' workspace, or click '+ New workspace'."
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
                : "Inference Router (none configured yet, create one first)",
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
          description: "Pick an existing Inference Router or create a new one inline.",
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
                  description: "Comma-separated fallback model UUIDs. Optional; can be set later.",
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
          description: "System prompt: guidance for the agent's behaviour and persona.",
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
      ctx.api
        .getAll("/gen-ai/models", "models", {
          ...PICKER,
          query: { usecases: ["MODEL_USECASE_KNOWLEDGEBASE"] },
        })
        .catch(() => []),
      ctx.api.get("/gen-ai/regions").catch(() => ({ regions: [] })),
      buildProjectField(ctx, parentResourceId),
    ]);
    const modelOptions = models.map((m) => ({
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
    // No region picker: DO deploys routers to all regions and rejects any
    // explicit `regions`. Fallback/policy models must come from DO's router
    // presets (arbitrary serverless model UUIDs are rejected as "not found"),
    // so we offer a preset picker and pass its config through on create.
    const presets = await ctx.api
      .getAll("/gen-ai/models/routers/presets", "presets", PICKER)
      .catch(() => []);
    const presetOptions = presets
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
                options: [{ id: "", label: "None (configure models later)" }, ...presetOptions],
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
    // config catalog (which GPU slugs each model can run on) so the user can
    // pick a region/size that's actually viable for their model. A failure here
    // propagates: its scope hint says more than a form of empty pickers would.
    const [sizes, gpuModels, vpcs] = await Promise.all([
      ctx.api.get("/dedicated-inferences/sizes"),
      ctx.api.get("/dedicated-inferences/gpu-model-config"),
      vpcOptions(ctx),
    ]);
    const sizeRows = sizes.sizes ?? [];
    const regionSlugs = new Set([
      ...(sizes.enabled_regions ?? []),
      ...sizeRows.map((s) => s.region ?? "").filter(Boolean),
    ]);
    const regionOptions = [...regionSlugs].map((region) => {
      const info = regionDisplay(region);
      return {
        id: region,
        label: region,
        ...(info ? { location: info.location, flag: info.flag } : {}),
      };
    });
    // The price goes in `description`, not the label: the picker gives the label a
    // single line, and the price is the part that would get cut off. The catalog has a
    // row per region and GPU, so dedupe, or a size lists once per region that offers it,
    // with colliding option ids.
    const seenSizeSlugs = new Set<string>();
    const sizeOptions = sizeRows.flatMap((s) => {
      const slug = s.gpu_slug;
      if (!slug || seenSizeSlugs.has(slug)) return [];
      seenSizeSlugs.add(slug);
      const currency = s.currency && s.currency !== "USD" ? ` ${s.currency}` : "";
      return [
        {
          id: slug,
          label: slug,
          ...(s.price_per_hour ? { description: `$${s.price_per_hour}/hr${currency}` } : {}),
        },
      ];
    });
    const modelOptions = (gpuModels.gpu_model_configs ?? []).flatMap((m) => {
      if (!m.model_slug) return [];
      const parts = [
        ...(m.gpu_slugs?.length ? [`Runs on ${m.gpu_slugs.join(", ")}`] : []),
        ...(m.is_gated_model ? ["Gated: needs a Hugging Face token"] : []),
      ];
      return [
        {
          id: m.model_slug,
          label: m.model_name ?? m.model_slug,
          ...(parts.length > 0 ? { description: parts.join(". ") } : {}),
        },
      ];
    });
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
          description: "Accelerator size and hourly price. It has to be one the model runs on.",
        },
        {
          key: "scale",
          label: "GPU Count",
          kind: "number",
          required: false,
          defaultValue: "1",
          description: "How many of this GPU size to run the model on.",
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
          kind: "select",
          required: false,
          options: vpcs,
          description: "Has to be in the chosen region. Defaults to that region's default VPC.",
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
      const agents = await ctx.api.getAll("/gen-ai/agents", "agents", PICKER).catch(() => []);
      const options = agents.map((a) => ({
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
    // API: the form's `modelSource` toggle decides which one we send.
    const useRouter = fields["modelSource"] === "router";
    const modelSourceFields: { model_router_uuid?: string; model_uuid?: string } = useRouter
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
    // workspaces: the DO console auto-creates one transparently. Match
    // that UX: if the user didn't pick (or there are none), look one up,
    // and create a "default" workspace if there are still none. The
    // workspace picker's inline-create FieldAction covers the case where
    // the user wants to pick a name explicitly.
    let workspaceUuid = String(fields["workspaceUuid"] ?? "").trim();
    if (!workspaceUuid) {
      const list = await ctx.api.get("/gen-ai/workspaces").catch(() => ({ workspaces: [] }));
      workspaceUuid = String(list.workspaces?.[0]?.uuid ?? "");
      if (!workspaceUuid) {
        const created = await ctx.api.post("/gen-ai/workspaces", {
          body: {
            name: "default",
            description: "Auto-created by Infrawrench for first agent",
          },
        });
        workspaceUuid = String(created.workspace?.uuid ?? "");
        if (!workspaceUuid) {
          throw new Error(
            "DigitalOcean returned no workspace UUID. Create a workspace in the DO console (Agent Platform, Workspaces) and try again.",
          );
        }
      }
    }

    const data = await ctx.api.post("/gen-ai/agents", {
      body: {
        name: fields["name"],
        ...modelSourceFields,
        region: fields["region"],
        workspace_uuid: workspaceUuid,
        ...(fields["instruction"] ? { instruction: fields["instruction"] } : {}),
        ...(fields["description"] ? { description: fields["description"] } : {}),
        ...(parentExternalId ? { project_id: parentExternalId } : {}),
      },
    });
    const a = data.agent ?? {};
    const uuid = String(a.uuid ?? "");
    const deployment = a.deployment;
    const deploymentUrl = String(deployment?.url ?? "");
    const respRouter = a.model_router;
    const respModel = a.model;
    const now = new Date().toISOString();
    return {
      id: `${accountId}:gen-ai-agent:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-agent",
      accountId,
      displayName: String(a.name ?? fields["name"]),
      fields: {
        name: String(a.name ?? fields["name"]),
        region: String(a.region ?? fields["region"] ?? ""),
        description: String(a.description ?? fields["description"] ?? ""),
        instruction: String(a.instruction ?? fields["instruction"] ?? ""),
        modelUuid: String(respModel?.uuid ?? (useRouter ? "" : (fields["modelUuid"] ?? ""))),
        modelName: String(respModel?.name ?? ""),
        modelRouterUuid: String(
          respRouter?.uuid ?? (useRouter ? (fields["modelRouterUuid"] ?? "") : ""),
        ),
        modelRouterName: String(respRouter?.name ?? ""),
        projectId: parentExternalId,
        temperature: 0,
        maxTokens: 0,
        k: 0,
        status: String(deployment?.status ?? "provisioning"),
        knowledgeBaseCount: 0,
        knowledgeBaseUuids: "",
        deploymentUrl,
      },
      resolvedOutputs: deploymentUrl ? { deploymentUrl, agentEndpoint: deploymentUrl } : {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(a.created_at ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "gen-ai-knowledge-base") {
    const data = await ctx.api.post("/gen-ai/knowledge_bases", {
      body: {
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
      },
    });
    const kb = data.knowledge_base ?? {};
    const uuid = String(kb.uuid ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:gen-ai-knowledge-base:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-knowledge-base",
      accountId,
      displayName: String(kb.name ?? fields["name"]),
      fields: {
        name: String(kb.name ?? fields["name"]),
        region: String(kb.region ?? fields["region"] ?? ""),
        embeddingModelUuid: String(kb.embedding_model_uuid ?? fields["embeddingModelUuid"]),
        databaseId: String(kb.database_id ?? ""),
        projectId: String(kb.project_id ?? parentExternalId),
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
      createdAt: String(kb.created_at ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "gen-ai-model-router") {
    // `regions` is deprecated (omit). Models come from a chosen preset's
    // config: its fallback_models/policies use identifiers DO accepts;
    // passing raw serverless model UUIDs gets rejected as "model not found".
    const presetSlug = String(fields["presetSlug"] ?? "").trim();
    let cfg: DoRouterPreset["config"];
    if (presetSlug) {
      const presets = await ctx.api
        .getAll("/gen-ai/models/routers/presets", "presets", PICKER)
        .catch(() => []);
      const preset = presets.find((p: DoRouterPreset) => p.slug === presetSlug);
      cfg = preset?.config;
    }
    const data = await ctx.api.post("/gen-ai/models/routers", {
      body: {
        name: fields["name"],
        ...(fields["description"] ? { description: fields["description"] } : {}),
        ...(Array.isArray(cfg?.fallback_models) && cfg.fallback_models.length > 0
          ? { fallback_models: cfg.fallback_models }
          : {}),
        ...(Array.isArray(cfg?.policies) && cfg.policies.length > 0
          ? { policies: cfg.policies }
          : {}),
      },
    });
    const r = data.model_router ?? {};
    const uuid = String(r.uuid ?? "");
    const now = new Date().toISOString();
    const respConfig = r.config;
    const respFallback = Array.isArray(respConfig?.fallback_models)
      ? respConfig.fallback_models
      : [];
    return {
      id: `${accountId}:gen-ai-model-router:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-model-router",
      accountId,
      displayName: String(r.name ?? fields["name"]),
      fields: {
        name: String(r.name ?? fields["name"]),
        description: String(r.description ?? fields["description"] ?? ""),
        regions: "all",
        fallbackModels: respFallback.join(","),
        policyCount: Array.isArray(respConfig?.policies) ? respConfig.policies.length : 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(r.created_at ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "dedicated-inference") {
    // POST returns 202 Accepted with the provisioning record: same shape
    // as GET /dedicated-inferences/{id} but with status `provisioning`.
    const name = String(fields["name"] ?? "");
    const region = String(fields["region"] ?? "");
    // The document requires a VPC, and the form lets the region's default stand.
    const vpcUuid = fields["vpcUuid"] || (await defaultVpcIn(ctx, region));
    const data = await ctx.api.post("/dedicated-inferences", {
      body: {
        spec: {
          version: 1,
          name,
          region,
          enable_public_endpoint: fields["enablePublicEndpoint"] === "true",
          vpc: { uuid: vpcUuid },
          model_deployments: [
            {
              model_slug: String(fields["modelId"] ?? ""),
              model_provider: "hugging_face",
              accelerators: [
                {
                  scale: Number(fields["scale"]) || 1,
                  // The only type the document names.
                  type: "prefill_decode",
                  accelerator_slug: String(fields["size"] ?? ""),
                },
              ],
            },
          ],
        },
        ...(fields["huggingFaceToken"]
          ? { access_tokens: { hugging_face_token: fields["huggingFaceToken"] } }
          : {}),
      },
    });
    const d = data.dedicated_inference ?? {};
    const id = String(d.id ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:dedicated-inference:${id}`,
      pluginId: "digitalocean",
      resourceTypeId: "dedicated-inference",
      accountId,
      displayName: String(fields["name"]),
      fields: {
        name: String(fields["name"]),
        region: String(d.region ?? fields["region"] ?? ""),
        vpcUuid: String(d.vpc_uuid ?? vpcUuid),
        enablePublicEndpoint: fields["enablePublicEndpoint"] === "true" ? "yes" : "no",
        modelCount: 1,
        modelSummary: String(fields["modelId"] ?? ""),
        publicEndpoint: "",
        privateEndpoint: "",
        status: String(d.status ?? "provisioning"),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: id,
      createdAt: String(d.created_at ?? now),
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
    const data: DoResponse<"genai_create_agent_api_key"> & { secret_key?: string } =
      await ctx.api.post(`/gen-ai/agents/${idSegment(agentUuid)}/api_keys`, {
        body: { name: fields["name"] },
      });
    const info = data.api_key_info ?? {};
    const secret = String(info.secret_key ?? data.secret_key ?? "");
    const keyUuid = String(info.uuid ?? "");
    const externalId = `${agentUuid}/${keyUuid}`;
    const now = new Date().toISOString();
    return {
      id: `${accountId}:agent-api-key:${externalId}`,
      pluginId: "digitalocean",
      resourceTypeId: "agent-api-key",
      accountId,
      displayName: String(info.name ?? fields["name"]),
      fields: {
        name: String(info.name ?? fields["name"]),
        createdBy: String(info.created_by ?? ""),
        agentUuid,
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
      createdAt: String(info.created_at ?? now),
      updatedAt: now,
    };
  }

  return null;
}
