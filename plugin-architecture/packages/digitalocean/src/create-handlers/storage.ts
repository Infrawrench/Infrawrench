/** Create handlers for DigitalOcean Spaces buckets, block volumes and NFS shares. */
import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { signedS3Fetch } from "@infrawrench/plugin-base";
import { SPACES_REGIONS, regionDisplay } from "../constants.js";
import { buildProjectField, type DoCreateArgs, type DoCreateContext } from "./shared.js";

/**
 * Build the create form for the types this module owns. Returns `null` when
 * `typeId` belongs to another module so the dispatcher can try the next one.
 */
export async function storageGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "spaces-bucket") {
    const [regionsData, projectField] = await Promise.all([
      ctx.fetch<{ regions: Array<{ slug: string; name: string; available: boolean }> }>("/regions"),
      buildProjectField(ctx, parentResourceId),
    ]);
    const spacesRegions = regionsData.regions
      .filter((r) => r.available)
      .filter((r) => SPACES_REGIONS.includes(r.slug))
      .map((r) => {
        const info = regionDisplay(r.slug);
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });

    return {
      fields: [
        {
          key: "name",
          label: "Bucket Name",
          kind: "text",
          required: true,
          description: "Globally unique bucket name (lowercase, hyphens, 3-63 characters)",
        },
        ...projectField,
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: spacesRegions,
          ...(spacesRegions[0] ? { defaultValue: spacesRegions[0].id } : {}),
        },
      ],
    };
  }

  if (typeId === "volume") {
    const [regionsData, projectField] = await Promise.all([
      ctx.fetch<{ regions: Array<{ slug: string; name: string; available: boolean }> }>("/regions"),
      buildProjectField(ctx, parentResourceId),
    ]);
    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = regionDisplay(r.slug);
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    return {
      fields: [
        { key: "name", label: "Volume Name", kind: "text", required: true },
        ...projectField,
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(regions[0] ? { defaultValue: regions[0].id } : {}),
        },
        {
          key: "sizeGb",
          label: "Size",
          kind: "disk-slider",
          required: true,
          minGb: 1,
          maxGb: 16384,
          defaultGb: 100,
          stepGb: 1,
        },
        {
          key: "filesystemType",
          label: "Filesystem",
          kind: "select",
          required: false,
          defaultValue: "ext4",
          options: [
            { id: "ext4", label: "ext4" },
            { id: "xfs", label: "xfs" },
            { id: "", label: "None (unformatted)" },
          ],
        },
      ],
    };
  }

  if (typeId === "nfs-share") {
    // NFS shares are pinned to a VPC. List both regions (only some are
    // NFS-eligible — DO returns 422 from create otherwise, surfaced as the
    // host error) and the account's VPCs so the user can pick.
    const [regionsData, vpcsData, projectField] = await Promise.all([
      ctx.fetch<{
        regions: Array<{ slug: string; name: string; available: boolean }>;
      }>("/regions"),
      ctx
        .fetch<{ vpcs: Array<{ id: string; name: string; region: string }> }>("/vpcs?per_page=200")
        .catch(() => ({ vpcs: [] as Array<{ id: string; name: string; region: string }> })),
      buildProjectField(ctx, parentResourceId),
    ]);
    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = regionDisplay(r.slug);
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    const vpcOptions = vpcsData.vpcs.map((v) => ({
      id: v.id,
      label: `${v.name} (${v.region})`,
    }));
    return {
      fields: [
        { key: "name", label: "Share Name", kind: "text", required: true },
        ...projectField,
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(regions[0] ? { defaultValue: regions[0].id } : {}),
          description:
            "Only some DO regions host NFS. The create call will 422 in unsupported regions.",
        },
        {
          key: "sizeGib",
          label: "Size",
          kind: "disk-slider",
          required: true,
          minGb: 50,
          maxGb: 16000,
          defaultGb: 50,
          stepGb: 50,
          description: "Minimum 50 GiB; max 16,000 GiB.",
        },
        {
          key: "performanceTier",
          label: "Performance Tier",
          kind: "select",
          required: true,
          defaultValue: "standard",
          options: [
            { id: "standard", label: "Standard ($0.15 / GiB-mo)" },
            { id: "high-performance", label: "High Performance ($0.30 / GiB-mo, GPU-tuned)" },
          ],
        },
        {
          key: "vpcId",
          label: "VPC",
          kind: "select",
          required: true,
          options: vpcOptions,
          ...(vpcOptions[0] ? { defaultValue: vpcOptions[0].id } : {}),
          description:
            "Shares are reachable only from droplets/DOKS nodes in this VPC. Multiple VPCs can be added after creation via the DO console.",
        },
      ],
    };
  }

  return null;
}

/**
 * Create one of the types this module owns. Returns `null` when `typeId`
 * belongs to another module.
 */
export async function storageCreateResource(args: DoCreateArgs): Promise<ResourceInstance | null> {
  const {
    ctx,
    typeId,
    accountId,
    fields,
    credentialUpdatesRef,
    effectiveParentId,
    assignToProjectIfNeeded,
  } = args;
  if (typeId === "spaces-bucket") {
    // Spaces buckets are created via the S3-compatible API — DO's REST API
    // (/v2/spaces/...) only exposes access-key CRUD, no bucket operations
    // (verified in digitalocean/openapi/spaces/). The S3 PUT needs a pair
    // of Spaces keys distinct from the API token; modelled as
    // `spacesAccessKeyId` / `spacesSecretAccessKey` on the account.
    //
    // When the pair is missing we mint an account-wide key via POST
    // /spaces/keys (PAT scope: spaces_keys:create) and return it via
    // `credentialUpdates` so the host persists it. A freshly-minted key
    // takes a few seconds to propagate to DO's S3 auth backend, so after
    // minting we probe with a cheap authenticated call (ListAllMyBuckets
    // GET against the regional endpoint) before the bucket PUT, then
    // retry the PUT on transient 403 in case propagation finishes mid-
    // flight.
    let accessKeyId = ctx.credentials["spacesAccessKeyId"] as string | undefined;
    let secretAccessKey = ctx.credentials["spacesSecretAccessKey"] as string | undefined;
    let mintedCredentialUpdates: Record<string, string> | undefined;
    let keyJustMinted = false;
    if (!accessKeyId || !secretAccessKey) {
      const name = `infrawrench-spaces-${Date.now().toString(36)}`;
      // POST /spaces/keys with NO grants (or grants: []) mints a "No Grant
      // Key" — DO's spec for an unauthorized key with zero permissions,
      // which is what was producing the AccessDenied response on the
      // bucket PUT. The correct shape for an account-wide full-access
      // key (the equivalent of the legacy console-generated "Spaces
      // access key") is a single grant with empty bucket + "fullaccess".
      const mintResp = await ctx
        .fetch<{
          key?: { access_key?: string; secret_key?: string };
        }>("/spaces/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            grants: [{ bucket: "", permission: "fullaccess" }],
          }),
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `DigitalOcean plugin: couldn't auto-generate Spaces access keys via POST /spaces/keys (${message}). ` +
              "Make sure the API token has the spaces_keys:create scope, or generate a key manually in the DO console (API > Spaces Keys) and edit this account.",
          );
        });
      const minted = mintResp.key;
      if (!minted?.access_key || !minted?.secret_key) {
        throw new Error(
          "DigitalOcean plugin: POST /spaces/keys returned no key. Generate one in the DO console (API > Spaces Keys) and edit this account.",
        );
      }
      accessKeyId = minted.access_key;
      secretAccessKey = minted.secret_key;
      mintedCredentialUpdates = {
        spacesAccessKeyId: accessKeyId,
        spacesSecretAccessKey: secretAccessKey,
      };
      keyJustMinted = true;
    }

    const bucketName = fields["name"];
    if (!bucketName) throw new Error("Bucket name is required");
    const region = fields["region"] ?? "nyc3";
    const host = `${bucketName}.${region}.digitaloceanspaces.com`;
    const endpoint = `https://${host}`;

    // Wait for a freshly-minted key to propagate. ListAllMyBuckets is the
    // cheapest authenticated probe — it doesn't require any pre-existing
    // bucket and returns 200 with an empty body on a brand-new account.
    if (keyJustMinted) {
      const regionalEndpoint = `https://${region}.digitaloceanspaces.com/`;
      const maxAttempts = 15;
      let ready = false;
      for (let i = 0; i < maxAttempts; i++) {
        const probe = await signedS3Fetch({
          accessKey: accessKeyId,
          secretKey: secretAccessKey,
          region,
          method: "GET",
          url: regionalEndpoint,
        }).catch(() => null);
        if (probe && probe.ok) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!ready) {
        throw new Error(
          "DigitalOcean plugin: auto-generated Spaces key isn't usable yet (still propagating after 30s). " +
            "The key has been saved on your account — retry the bucket create in a minute, or paste an existing Spaces key in the DO console (API > Spaces Keys) and edit this account.",
        );
      }
    }

    // Retry the bucket PUT on transient 403 — propagation can finish a
    // beat after the probe succeeds, especially if the user's account
    // has never used Spaces before.
    const tryPut = async (
      access: string,
      secret: string,
      attempts: number,
    ): Promise<{ ok: true } | { ok: false; status: number; text: string }> => {
      for (let i = 0; i < attempts; i++) {
        const r = await signedS3Fetch({
          accessKey: access,
          secretKey: secret,
          region,
          method: "PUT",
          url: `${endpoint}/`,
        });
        if (r.ok) return { ok: true };
        if (r.status !== 403 || i === attempts - 1) {
          return { ok: false, status: r.status, text: await r.text() };
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return { ok: false, status: 0, text: "no attempts" };
    };
    let putResult = await tryPut(accessKeyId, secretAccessKey, keyJustMinted ? 4 : 1);

    // Recovery for the previous "no grant key" leak: an earlier version
    // of this handler minted account-wide keys without the
    // `[{ bucket: "", permission: "fullaccess" }]` grant, producing a
    // valid key with zero permissions. Those keys are still saved on
    // affected accounts and will 403 every Spaces call. If a stored
    // (i.e. not-just-minted) key 403s on bucket creation, mint a
    // fresh full-access one, surface the replacement via
    // `credentialUpdates`, and retry once.
    if (!putResult.ok && putResult.status === 403 && !keyJustMinted) {
      const name = `infrawrench-spaces-${Date.now().toString(36)}`;
      const mintResp = await ctx
        .fetch<{
          key?: { access_key?: string; secret_key?: string };
        }>("/spaces/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            grants: [{ bucket: "", permission: "fullaccess" }],
          }),
        })
        .catch(() => null);
      const replacement = mintResp?.key;
      if (replacement?.access_key && replacement?.secret_key) {
        accessKeyId = replacement.access_key;
        secretAccessKey = replacement.secret_key;
        mintedCredentialUpdates = {
          spacesAccessKeyId: accessKeyId,
          spacesSecretAccessKey: secretAccessKey,
        };
        // Wait for the replacement key to propagate, same as the
        // first-time mint path.
        const regionalEndpoint = `https://${region}.digitaloceanspaces.com/`;
        for (let i = 0; i < 15; i++) {
          const probe = await signedS3Fetch({
            accessKey: accessKeyId,
            secretKey: secretAccessKey,
            region,
            method: "GET",
            url: regionalEndpoint,
          }).catch(() => null);
          if (probe && probe.ok) break;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        putResult = await tryPut(accessKeyId, secretAccessKey, 4);
      }
    }

    if (!putResult.ok) {
      throw new Error(
        `Spaces S3 API error ${putResult.status} creating bucket "${bucketName}": ${putResult.text}`,
      );
    }

    await assignToProjectIfNeeded(`do:space:${bucketName}`);
    const resource: ResourceInstance = {
      id: `${accountId}:spaces-bucket:${bucketName}`,
      pluginId: "digitalocean",
      resourceTypeId: "spaces-bucket",
      accountId,
      displayName: String(bucketName),
      fields: {
        name: String(bucketName),
        region,
        accessControl: "private",
      },
      resolvedOutputs: {
        endpoint,
      },
      secretStates: [],
      externalId: String(bucketName),
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Forward the minted credentials to the wrapping `doCreateResource`
    // so the host can persist them on the account. Returning a bare
    // ResourceInstance from this branch alone loses them.
    if (mintedCredentialUpdates) {
      credentialUpdatesRef.value = mintedCredentialUpdates;
    }
    return resource;
  }

  if (typeId === "volume") {
    const body: Record<string, unknown> = {
      name: fields["name"],
      region: fields["region"],
      size_gigabytes: Number(fields["sizeGb"] ?? 100),
      ...(fields["filesystemType"] ? { filesystem_type: fields["filesystemType"] } : {}),
    };
    const data = await ctx.fetch<{ volume: Record<string, unknown> }>("/volumes", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const v = data.volume;
    const now = new Date().toISOString();
    await assignToProjectIfNeeded(`do:volume:${String(v["id"] ?? "")}`);
    return {
      id: `${accountId}:volume:${String(v["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "volume",
      accountId,
      displayName: String(v["name"] ?? fields["name"]),
      fields: {
        name: String(v["name"] ?? fields["name"]),
        region: String((v["region"] as Record<string, unknown>)?.["slug"] ?? fields["region"]),
        sizeGb: Number(v["size_gigabytes"] ?? fields["sizeGb"] ?? 0),
        filesystemType: String(v["filesystem_type"] ?? ""),
        dropletIds: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(v["id"] ?? ""),
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
      createdAt: String(v["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "nfs-share") {
    const region = fields["region"] ?? "";
    const body: Record<string, unknown> = {
      name: fields["name"],
      region,
      size_gib: Number(fields["sizeGib"] ?? 50),
      vpc_ids: fields["vpcId"] ? [fields["vpcId"]] : [],
      performance_tier: fields["performanceTier"] ?? "standard",
    };
    const data = await ctx.fetch<{ nfs: Record<string, unknown> }>("/nfs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const s = data.nfs ?? {};
    const now = new Date().toISOString();
    const externalId = `${region}/${String(s["id"] ?? "")}`;
    return {
      id: `${accountId}:nfs-share:${externalId}`,
      pluginId: "digitalocean",
      resourceTypeId: "nfs-share",
      accountId,
      displayName: String(s["name"] ?? fields["name"]),
      fields: {
        name: String(s["name"] ?? fields["name"]),
        region,
        sizeGib: Number(s["size_gib"] ?? fields["sizeGib"] ?? 0),
        performanceTier: String(s["performance_tier"] ?? fields["performanceTier"] ?? "standard"),
        vpcIds: Array.isArray(s["vpc_ids"])
          ? (s["vpc_ids"] as string[]).join(",")
          : (fields["vpcId"] ?? ""),
        mountTarget: "",
        status: String(s["status"] ?? "creating"),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
      createdAt: String(s["created_at"] ?? now),
      updatedAt: now,
    };
  }

  return null;
}
