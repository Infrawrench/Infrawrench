import yaml from "js-yaml";
import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { GCP_REGIONS, CLOUD_BUILD_REGIONS } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const cloudBuildCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "cloud-build-trigger": async (ctx, parentResourceId) => {
    const p = ctx.project;
    const inlineYamlDefault = `steps:\n  - name: gcr.io/cloud-builders/docker\n    args: ['build', '-t', 'gcr.io/$PROJECT_ID/example:$SHORT_SHA', '.']\n`;

    // Fetch all Cloud Build 2nd-gen connected repos across the regions where
    // they're commonly created. Each region's connections + repositories
    // calls happen in parallel; failures are silent (region might have no
    // connections, or the API isn't enabled there).
    const connectedRepoOptions: Array<{ id: string; label: string }> = [];
    await Promise.all([
      // 2nd-gen connected repositories — preferred path on new projects.
      ...CLOUD_BUILD_REGIONS.map(async (loc) => {
        try {
          const conns = await ctx.paginate<Record<string, unknown>>(
            `https://cloudbuild.googleapis.com/v2/projects/${p}/locations/${loc}/connections`,
            "connections",
          );
          await Promise.all(
            conns.map(async (conn) => {
              const connFullName = String(conn["name"] ?? "");
              const connShort = connFullName.split("/").pop() ?? "";
              if (!connShort) return;
              const repoListUrl = `https://cloudbuild.googleapis.com/v2/projects/${p}/locations/${loc}/connections/${connShort}/repositories`;
              try {
                const repos = await ctx.paginate<Record<string, unknown>>(
                  repoListUrl,
                  "repositories",
                );
                for (const r of repos) {
                  const rName = String(r["name"] ?? "");
                  const rShort = rName.split("/").pop() ?? "";
                  if (!rShort || !rName.startsWith("projects/")) continue;
                  connectedRepoOptions.push({
                    id: rName,
                    label: `${connShort}/${rShort} (2nd gen, ${loc})`,
                  });
                }
              } catch {
                /* connection has no linked repos or list call failed */
              }
              // Also offer linkable (visible-but-not-yet-linked) repos. The
              // create handler auto-links them on submit. Wrapped in `link:`
              // so the handler knows to do the link step first.
              try {
                const fetchUrl = `https://cloudbuild.googleapis.com/v2/projects/${p}/locations/${loc}/connections/${connShort}:fetchLinkableRepositories`;
                const fetched = await ctx.get<{
                  repositories?: Array<{ name?: string; remoteUri?: string }>;
                }>(fetchUrl);
                for (const lr of fetched.repositories ?? []) {
                  const remote = String(lr.remoteUri ?? "");
                  if (!remote) continue;
                  // Strip any trailing .git for the human label.
                  const niceName =
                    remote.replace(/^https?:\/\/(?:[^/]+\/)?/, "").replace(/\.git$/, "") || remote;
                  connectedRepoOptions.push({
                    id: `link:${connFullName}|${remote}`,
                    label: `${niceName} (link via ${connShort}, ${loc})`,
                  });
                }
              } catch {
                /* fetchLinkableRepositories not supported / connection not OAuth-style */
              }
            }),
          );
        } catch {
          /* region has no Cloud Build connections / API disabled */
        }
      }),
      // 1st-gen Cloud Source Repositories — surfaced with a `csr:` prefix
      // so the create handler knows to use triggerTemplate (legacy path)
      // rather than sourceToBuild + gitFileSource. CSR is deprecated for
      // new projects but still works where it's enabled.
      (async () => {
        try {
          const repos = await ctx.paginate<Record<string, unknown>>(
            `https://sourcerepo.googleapis.com/v1/projects/${p}/repos`,
            "repos",
          );
          for (const r of repos) {
            const rName = String(r["name"] ?? "");
            const rShort = rName.split("/").pop() ?? "";
            if (!rShort) continue;
            connectedRepoOptions.push({
              id: `csr:${rShort}`,
              label: `${rShort} (Cloud Source Repos)`,
            });
          }
        } catch {
          /* CSR API not enabled or project has no CSR repos */
        }
      })(),
    ]);
    connectedRepoOptions.sort((a, b) => a.label.localeCompare(b.label));

    // If the project has no connected repos, the field stays a text input
    // (so the user can paste a custom path) — the description tells them
    // where to set up a connection in Console.
    const repoFieldBase: Omit<CreateFieldConfig, "showWhen"> =
      connectedRepoOptions.length > 0
        ? {
            key: "repository",
            label: "Repository (2nd gen)",
            kind: "select",
            required: false,
            options: connectedRepoOptions,
            description:
              "Pick from your connected Cloud Build repos. Manage connections at console.cloud.google.com/cloud-build/repositories/2nd-gen.",
          }
        : {
            key: "repository",
            label: "Repository (2nd gen)",
            kind: "text",
            required: false,
            placeholder: "projects/PROJECT/locations/REGION/connections/CONN/repositories/REPO",
            description:
              "No 2nd-gen Cloud Build connections found in this project. Connect a repo at console.cloud.google.com/cloud-build/repositories/2nd-gen, or paste a full resource path.",
          };
    // CSR (1st-gen Cloud Source Repositories) doesn't support pull-request
    // triggers — the Cloud Build API rejects the combo. Filter those entries
    // out of the PR variant of the picker so users can't pick an incompatible
    // repo. Other event types keep the full list (incl. CSR).
    const nonCsrRepoOptions = connectedRepoOptions.filter((o) => !o.id.startsWith("csr:"));
    const repoField = (
      eventValue: string,
      overrides?: Partial<CreateFieldConfig>,
    ): CreateFieldConfig => {
      const base: Omit<CreateFieldConfig, "showWhen"> = { ...repoFieldBase };
      if (eventValue === "pull-request" && Array.isArray(base.options)) {
        base.options = nonCsrRepoOptions;
      }
      return {
        ...base,
        ...overrides,
        showWhen: { fieldKey: "eventType", fieldValue: eventValue },
      };
    };

    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "Must be unique within the project's region.",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: [{ id: "global", label: "global", location: "Multi-region" }, ...GCP_REGIONS],
          defaultValue: "global",
        },
        { key: "description", label: "Description", kind: "text", required: false },
        {
          key: "tags",
          label: "Tags",
          kind: "text",
          required: false,
          description: "Comma-separated tags.",
        },
        {
          key: "eventType",
          label: "Event",
          kind: "select",
          required: true,
          defaultValue: "manual",
          options: [
            { id: "push-branch", label: "Push to a branch" },
            { id: "push-tag", label: "Push new tag" },
            { id: "pull-request", label: "Pull request" },
            { id: "manual", label: "Manual invocation" },
            { id: "pubsub", label: "Pub/Sub message" },
            { id: "webhook", label: "Webhook event" },
          ],
        },
        repoField("push-branch", { required: true }),
        repoField("push-tag", { required: true }),
        repoField("pull-request", { required: true }),
        repoField("manual", {
          label: "Repository (optional, 2nd gen)",
          description:
            "If set, manual builds check out this repo to read the build config. Required when Config location = Repository.",
        }),
        {
          key: "manualRef",
          label: "Manual build ref",
          kind: "text",
          required: false,
          defaultValue: "refs/heads/main",
          description: "Git ref Cloud Build checks out when running manually.",
          showWhen: { fieldKey: "eventType", fieldValue: "manual" },
        },
        {
          key: "branchPattern",
          label: "Branch (regex)",
          kind: "text",
          required: false,
          defaultValue: "^main$",
          description: 'RE2 regex matched against branch names. Use ".*" to match all.',
          showWhen: { fieldKey: "eventType", fieldValue: "push-branch" },
        },
        {
          key: "tagPattern",
          label: "Tag (regex)",
          kind: "text",
          required: false,
          defaultValue: "^v.*",
          description: "RE2 regex matched against tag names.",
          showWhen: { fieldKey: "eventType", fieldValue: "push-tag" },
        },
        {
          key: "branchPattern",
          label: "Base branch (regex)",
          kind: "text",
          required: false,
          defaultValue: "^main$",
          description: "RE2 regex matched against the PR base branch.",
          showWhen: { fieldKey: "eventType", fieldValue: "pull-request" },
        },
        {
          key: "prComment",
          label: "Comment control",
          kind: "select",
          required: false,
          defaultValue: "COMMENTS_DISABLED",
          options: [
            { id: "COMMENTS_DISABLED", label: "Build immediately" },
            {
              id: "COMMENTS_ENABLED",
              label: 'Require "/gcbrun" comment from owner/collaborator',
            },
            {
              id: "COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY",
              label: 'Require "/gcbrun" only for external contributors',
            },
          ],
          showWhen: { fieldKey: "eventType", fieldValue: "pull-request" },
        },
        {
          key: "pubsubTopic",
          label: "Pub/Sub topic",
          kind: "resource-picker",
          required: true,
          showWhen: { fieldKey: "eventType", fieldValue: "pubsub" },
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "pubsub-topic", outputKey: "topicName" },
          ],
        },
        // configType: only push-style events (push-branch / push-tag /
        // pull-request) support synthetic inline `build` blocks (yaml inline,
        // dockerfile, buildpacks). Manual / pubsub / webhook triggers must
        // read their build config from a repo, so they don't see this field —
        // the handler defaults to "yaml" + "repository" when configType is
        // unset on submit.
        {
          key: "configType",
          label: "Configuration type",
          kind: "select",
          required: true,
          defaultValue: "yaml",
          options: [
            { id: "yaml", label: "Cloud Build configuration file (yaml or json)" },
            { id: "dockerfile", label: "Dockerfile" },
            { id: "buildpacks", label: "Buildpacks" },
          ],
          showWhen: {
            fieldKey: "eventType",
            fieldValues: ["push-branch", "push-tag", "pull-request"],
          },
        },
        // configLocation: only meaningful for push events with yaml. For
        // non-push events configType is hidden (and unset on submit), so the
        // showWhen below evaluates false → field hidden, handler falls back
        // to reading the build config from the repo (filename below).
        {
          key: "configLocation",
          label: "Config location",
          kind: "select",
          required: true,
          defaultValue: "repository",
          options: [
            { id: "repository", label: "Repository — read from source" },
            { id: "inline", label: "Inline — write YAML below" },
          ],
          showWhen: { fieldKey: "configType", fieldValue: "yaml" },
        },
        // filename — push event variant: only when reading from repo.
        {
          key: "filename",
          label: "Config file location",
          kind: "text",
          required: false,
          defaultValue: "cloudbuild.yaml",
          description: "Path within the repo (e.g. cloudbuild.yaml).",
          showWhen: { fieldKey: "configLocation", fieldValue: "repository" },
        },
        // filename — non-push event variant: always shown for manual /
        // pubsub / webhook (those triggers always read their build config
        // from the repo). Same key + default so form state stays consistent.
        {
          key: "filename",
          label: "Config file location",
          kind: "text",
          required: false,
          defaultValue: "cloudbuild.yaml",
          description: "Path within the repo (e.g. cloudbuild.yaml).",
          showWhen: {
            fieldKey: "eventType",
            fieldValues: ["manual", "pubsub", "webhook"],
          },
        },
        {
          key: "inlineConfig",
          label: "Inline build config",
          kind: "code",
          codeLanguage: "yaml",
          required: false,
          defaultValue: inlineYamlDefault,
          description: "YAML body of the build config — written into the trigger directly.",
          showWhen: { fieldKey: "configLocation", fieldValue: "inline" },
        },
        {
          key: "dockerfilePath",
          label: "Dockerfile path",
          kind: "text",
          required: false,
          defaultValue: "Dockerfile",
          description: "Path to the Dockerfile within the repo.",
          showWhen: { fieldKey: "configType", fieldValue: "dockerfile" },
        },
        {
          key: "dockerfileImage",
          label: "Image name",
          kind: "text",
          required: false,
          defaultValue: "gcr.io/$PROJECT_ID/$REPO_NAME:$COMMIT_SHA",
          description: "Tag for the resulting image. Substitutions are supported.",
          showWhen: { fieldKey: "configType", fieldValue: "dockerfile" },
        },
        {
          key: "buildpacksImage",
          label: "Image name",
          kind: "text",
          required: false,
          defaultValue: "gcr.io/$PROJECT_ID/$REPO_NAME:$COMMIT_SHA",
          showWhen: { fieldKey: "configType", fieldValue: "buildpacks" },
        },
        {
          key: "buildpacksDir",
          label: "Source directory",
          kind: "text",
          required: false,
          defaultValue: ".",
          description: "Directory inside the repo to build with Buildpacks.",
          showWhen: { fieldKey: "configType", fieldValue: "buildpacks" },
        },
        {
          key: "substitutions",
          label: "Substitution variables",
          kind: "key-value-list",
          required: false,
          description:
            "User-defined substitutions — keys must start with an underscore (e.g. _MY_VAR).",
          entryKeyLabel: "Key",
          entryKeyPlaceholder: "_MY_VAR",
          entryValueLabel: "Value",
          entryValueDefault: "literal",
          entryValueOptions: [{ id: "literal", label: "Value" }],
          addLabel: "+ Add variable",
        },
        {
          key: "requireApproval",
          label: "Approval",
          kind: "select",
          required: false,
          defaultValue: "no",
          options: [
            { id: "no", label: "Build runs immediately" },
            { id: "yes", label: "Require approval before build executes" },
          ],
        },
        {
          key: "serviceAccount",
          label: "Service account",
          kind: "resource-picker",
          required: true,
          description:
            "User-managed SA the build runs as. Cloud Build began requiring this for new projects in mid-2024 — without it the API returns a silent INVALID_ARGUMENT.",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "gcp-service-account", outputKey: "email" },
          ],
        },
        {
          key: "disabled",
          label: "Disabled",
          kind: "select",
          required: false,
          defaultValue: "no",
          options: [
            { id: "no", label: "Enabled — runs on event" },
            { id: "yes", label: "Disabled — won't run automatically" },
          ],
        },
      ],
    };
  },
};

export const cloudBuildCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "cloud-build-trigger": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const region = fields["region"] || "global";
    const description = fields["description"] ?? "";
    const tagsCsv = fields["tags"] ?? "";
    const eventType = fields["eventType"] ?? "manual";
    const repository = fields["repository"]?.trim() ?? "";
    const manualRef = fields["manualRef"]?.trim() || "refs/heads/main";
    const branchPattern = fields["branchPattern"]?.trim() ?? "";
    const tagPattern = fields["tagPattern"]?.trim() ?? "";
    const prComment = fields["prComment"]?.trim() ?? "";
    const pubsubTopic = fields["pubsubTopic"]?.trim() ?? "";
    const configType = fields["configType"] ?? "yaml";
    const configLocation = fields["configLocation"] ?? "repository";
    const filename = fields["filename"] ?? "cloudbuild.yaml";
    const inlineConfig = fields["inlineConfig"] ?? "";
    const dockerfilePath = fields["dockerfilePath"] ?? "Dockerfile";
    const dockerfileImage = fields["dockerfileImage"] ?? "";
    const buildpacksImage = fields["buildpacksImage"] ?? "";
    const buildpacksDir = fields["buildpacksDir"] ?? ".";
    const substitutionsRaw = fields["substitutions"] ?? "";
    const requireApproval = fields["requireApproval"] === "yes";
    const serviceAccount = fields["serviceAccount"]?.trim() ?? "";
    const disabled = fields["disabled"] === "yes";

    const tok = await ctx.token();

    // Resolve `link:<connection>|<remoteUri>` options into a real repo path
    // by linking the repo first (idempotent — Cloud Build returns the
    // existing record if it's already linked). Ignored for CSR shortcuts
    // and for repository fields that already point at a repo.
    let resolvedRepository = repository;
    if (repository.startsWith("link:")) {
      const rest = repository.slice("link:".length);
      const sepIdx = rest.indexOf("|");
      if (sepIdx <= 0) {
        throw new Error(`Malformed link option: ${repository}`);
      }
      const connectionPath = rest.slice(0, sepIdx);
      const remoteUri = rest.slice(sepIdx + 1);
      // Synthesise a stable repo id from the remote URI.
      const repoId = remoteUri
        .replace(/^https?:\/\//, "")
        .replace(/\.git$/, "")
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .toLowerCase()
        .slice(0, 63)
        .replace(/^-+|-+$/g, "");
      const linkUrl = `https://cloudbuild.googleapis.com/v2/${connectionPath}/repositories?repositoryId=${encodeURIComponent(repoId)}`;
      const linkRes = await fetch(linkUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${connectionPath}/repositories/${repoId}`,
          remoteUri,
        }),
      });
      if (!linkRes.ok && linkRes.status !== 409) {
        // 409 = already linked; treat as success.
        throw new Error(`Failed to link repository: ${linkRes.status} ${await linkRes.text()}`);
      }
      resolvedRepository = `${connectionPath}/repositories/${repoId}`;
    }

    // Reject paths that point at a connection rather than a repository —
    // a common copy-paste mistake.
    if (
      resolvedRepository.startsWith("projects/") &&
      !resolvedRepository.includes("/repositories/")
    ) {
      throw new Error(
        `"${resolvedRepository}" is a connection path, not a repository path. Link a repo to that connection in console.cloud.google.com/cloud-build/repositories/2nd-gen, or pick a "(link via …)" option from the dropdown.`,
      );
    }

    const body: Record<string, unknown> = { name };
    if (description) body["description"] = description;
    if (tagsCsv) {
      body["tags"] = tagsCsv
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (disabled) body["disabled"] = true;

    // The repository field carries either a 2nd-gen path ("projects/...")
    // or a 1st-gen Cloud Source Repos shortcut ("csr:<repo-name>"). Decode
    // once so the event/build branches don't repeat the parsing.
    const isCsrRepo = resolvedRepository.startsWith("csr:");
    const csrRepoName = isCsrRepo ? resolvedRepository.slice(4) : "";

    // Event configuration
    if (eventType === "push-branch") {
      if (!repository) throw new Error("Repository is required for branch-push triggers");
      if (isCsrRepo) {
        body["triggerTemplate"] = {
          projectId: p,
          repoName: csrRepoName,
          branchName: branchPattern || ".*",
        };
      } else {
        body["repositoryEventConfig"] = {
          repository: resolvedRepository,
          push: { branch: branchPattern || ".*" },
        };
      }
    } else if (eventType === "push-tag") {
      if (!repository) throw new Error("Repository is required for tag-push triggers");
      if (isCsrRepo) {
        body["triggerTemplate"] = {
          projectId: p,
          repoName: csrRepoName,
          tagName: tagPattern || ".*",
        };
      } else {
        body["repositoryEventConfig"] = {
          repository: resolvedRepository,
          push: { tag: tagPattern || ".*" },
        };
      }
    } else if (eventType === "pull-request") {
      if (!repository) throw new Error("Repository is required for pull-request triggers");
      // CSR doesn't support PR triggers — the form filters csr: entries out
      // of the pull-request repository picker, so isCsrRepo is unreachable
      // here unless the user manually pasted a `csr:` value into a free-text
      // repo field. Still validate defensively.
      if (isCsrRepo) {
        throw new Error(
          "Pull-request triggers aren't supported with Cloud Source Repositories. Use a 2nd-gen connected repo (GitHub/Bitbucket/GitLab).",
        );
      }
      const pr: Record<string, unknown> = { branch: branchPattern || ".*" };
      if (prComment) pr["commentControl"] = prComment;
      body["repositoryEventConfig"] = { repository: resolvedRepository, pullRequest: pr };
    } else if (eventType === "pubsub") {
      if (!pubsubTopic) throw new Error("Pub/Sub topic is required for pubsub triggers");
      const topic = pubsubTopic.startsWith("projects/")
        ? pubsubTopic
        : `projects/${p}/topics/${pubsubTopic}`;
      body["pubsubConfig"] = { topic };
    } else if (eventType === "webhook") {
      body["webhookConfig"] = { state: "ENABLED" };
    }
    // Manual / Pub/Sub / Webhook triggers don't get their source from an
    // event — Cloud Build requires an explicit sourceToBuild + gitFileSource
    // pointing at a connected repo. Inline builds aren't supported on
    // these trigger types (see cloud.google.com/build/docs/automate-builds-pubsub-events).
    if (eventType === "manual" || eventType === "pubsub" || eventType === "webhook") {
      if (!repository) {
        throw new Error(
          `Cloud Build ${eventType} triggers need a source repository — they don't support inline builds. Either:\n` +
            `  • Connect a 2nd-gen repo at console.cloud.google.com/cloud-build/repositories/2nd-gen, or\n` +
            `  • Create a Cloud Source Repos repo (gcloud source repos create <name>).\n` +
            `Then reopen this form to pick it.`,
        );
      }
      const ref = eventType === "manual" ? manualRef : "refs/heads/main";
      if (isCsrRepo) {
        // 1st-gen path uses triggerTemplate even for non-event triggers; the
        // sourceToBuild field is unused by Cloud Build for CSR-backed
        // pubsub/webhook/manual triggers.
        body["triggerTemplate"] = {
          projectId: p,
          repoName: csrRepoName,
          branchName: ref.replace(/^refs\/heads\//, ""),
        };
      } else {
        body["sourceToBuild"] = { repository: resolvedRepository, ref };
      }
    }

    // Build configuration
    const isPushEvent =
      eventType === "push-branch" || eventType === "push-tag" || eventType === "pull-request";
    if (configType === "yaml" && configLocation === "repository") {
      // Push events get their source (and so the filename's resolution
      // context) from the event itself. Manual / Pub/Sub / Webhook need an
      // explicit gitFileSource pointing at the same repo we set as
      // sourceToBuild — but ONLY for 2nd-gen connected repos. CSR (1st-gen)
      // triggers resolve `filename` against the triggerTemplate repo.
      if (!isPushEvent && !isCsrRepo) {
        if (!repository) {
          throw new Error("A repository is required to read the build config from.");
        }
        body["gitFileSource"] = {
          path: filename,
          repository: resolvedRepository,
          revision: eventType === "manual" ? manualRef : "refs/heads/main",
        };
      } else {
        body["filename"] = filename;
      }
    } else if (configType === "yaml" && configLocation === "inline") {
      // The form hides the inline option for non-push events (configType +
      // configLocation are gated on eventType ∈ push-*), so this branch is
      // only reachable for push-branch / push-tag / pull-request.
      // Cloud Build's REST API accepts an inline `build` JSON object. We
      // parse the user's YAML (or JSON) into a JS object and submit that.
      let parsed: unknown;
      try {
        parsed = yaml.load(inlineConfig);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Inline build config is not valid YAML/JSON: ${msg}`);
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Inline build config must be a YAML mapping with steps: [...]");
      }
      body["build"] = parsed;
    } else if (configType === "dockerfile") {
      // Build a synthetic build with a docker step.
      body["build"] = {
        steps: [
          {
            name: "gcr.io/cloud-builders/docker",
            args: ["build", "-t", dockerfileImage, "-f", dockerfilePath, "."],
          },
        ],
        ...(dockerfileImage ? { images: [dockerfileImage] } : {}),
      };
    } else if (configType === "buildpacks") {
      body["build"] = {
        steps: [
          {
            name: "gcr.io/k8s-skaffold/pack",
            entrypoint: "pack",
            args: [
              "build",
              buildpacksImage,
              "--builder",
              "gcr.io/buildpacks/builder:v1",
              "--path",
              buildpacksDir,
            ],
          },
        ],
        ...(buildpacksImage ? { images: [buildpacksImage] } : {}),
      };
    }

    // Substitutions: the key-value-list field stores a JSON string of
    // {key, value} pairs.
    if (substitutionsRaw) {
      try {
        const arr = JSON.parse(substitutionsRaw) as Array<Record<string, string>>;
        const subs: Record<string, string> = {};
        for (const row of arr) {
          const k = String(row["key"] ?? "");
          const v = String(row["value"] ?? "");
          if (k) subs[k] = v;
        }
        if (Object.keys(subs).length > 0) body["substitutions"] = subs;
      } catch {
        /* ignore malformed substitution rows */
      }
    }

    if (requireApproval) {
      body["approvalConfig"] = { approvalRequired: true };
    }
    if (serviceAccount) {
      const sa = serviceAccount.includes("@")
        ? serviceAccount
        : `${serviceAccount}@${p}.iam.gserviceaccount.com`;
      body["serviceAccount"] = `projects/${p}/serviceAccounts/${sa}`;
      // When a user-specified service account is set AND we're sending an
      // inline `build`, Cloud Build requires an explicit logging option —
      // otherwise it returns INVALID_ARGUMENT. Set CLOUD_LOGGING_ONLY by
      // default; users can override by editing the inline YAML themselves.
      const inlineBuild = body["build"] as Record<string, unknown> | undefined;
      if (inlineBuild) {
        const opts = (inlineBuild["options"] as Record<string, unknown> | undefined) ?? {};
        if (!opts["logging"]) opts["logging"] = "CLOUD_LOGGING_ONLY";
        inlineBuild["options"] = opts;
      }
    }

    // Cloud Build Triggers v1 supports both global and regional endpoints.
    // Regional uses `/v1/projects/{p}/locations/{region}/triggers`; global
    // uses the project-only path.
    const url =
      region === "global"
        ? `https://cloudbuild.googleapis.com/v1/projects/${p}/triggers`
        : `https://cloudbuild.googleapis.com/v1/projects/${p}/locations/${region}/triggers`;
    const bodyJson = JSON.stringify(body);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: bodyJson,
    });
    if (!res.ok) {
      const errText = await res.text();
      // Cloud Build's INVALID_ARGUMENT message is generic; include the
      // request body so the user can spot the field the API didn't like.
      throw new Error(
        `Cloud Build Trigger create failed (${res.status}): ${errText}\n\nRequest body sent:\n${bodyJson}`,
      );
    }
    const result = (await res.json()) as Record<string, unknown>;
    const triggerId = String(result["id"] ?? "");
    const now = new Date().toISOString();
    const triggerTypeLabel =
      eventType === "manual"
        ? "Manual"
        : eventType === "webhook"
          ? "Webhook"
          : eventType === "pubsub"
            ? "Pub/Sub"
            : eventType === "pull-request"
              ? "Pull request"
              : eventType === "push-tag"
                ? "Push tag"
                : "Push branch";
    // externalId encodes the region so the lister/detail/delete code can
    // hit the right regional endpoint. Must match the shape produced by
    // listCloudBuildTriggers in resource-listers/devops.ts.
    const externalId = `${region}/${triggerId}`;
    return {
      id: ctx.id(accountId, "cloud-build-trigger", externalId),
      pluginId: "gcp",
      resourceTypeId: "cloud-build-trigger",
      accountId,
      displayName: name,
      fields: {
        name,
        description,
        disabled,
        triggerType: triggerTypeLabel,
        repoName: repository,
        branchName: branchPattern || tagPattern,
        filename: configLocation === "repository" ? filename : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  },
};
