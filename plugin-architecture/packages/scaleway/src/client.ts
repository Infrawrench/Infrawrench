import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SizeOption,
  ImageOption,
  ResourceStatus,
  ResourceTypeDefinition,
  DashboardStat,
} from "@infrawrench/plugin-base";
import { labeledFieldItems, signedS3Fetch } from "@infrawrench/plugin-base";
import type { Client, Region, Zone } from "@scaleway/sdk-client";
import { createClient } from "@scaleway/sdk-client";
import { Instancev1 } from "@scaleway/sdk-instance";
import { K8Sv1 } from "@scaleway/sdk-k8s";
import { Rdbv1 } from "@scaleway/sdk-rdb";
import { Blockv1 } from "@scaleway/sdk-block";

/**
 * Scaleway plugin client.
 * Created per account (per secret key) by the host.
 *
 * Control-plane calls go through the official per-API Scaleway SDKs
 * (@scaleway/sdk-instance, -k8s, -rdb, -block). Object Storage is
 * S3-compatible and uses a hand-rolled SigV4 path below — the SDK does
 * not cover Object Storage.
 */
export class ScalewayClient implements PluginClient {
  private readonly secretKey: string;
  private readonly accessKey: string;
  private readonly defaultProjectId: string;
  private readonly resourceTypes: ResourceTypeDefinition[];

  // Lazily-initialised SDK client. We avoid eager creation because Scaleway's
  // assertValidSettings rejects non-UUID project IDs / secrets used in tests.
  private sdkClient: Client | undefined;

  private static readonly DEFAULT_REGION: Region = "fr-par";
  private static readonly DEFAULT_ZONE: Zone = "fr-par-1";

  private static readonly ZONE_INFO: Record<
    string,
    { region: string; location: string; flag: string }
  > = {
    "fr-par-1": { region: "fr-par", location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "fr-par-2": { region: "fr-par", location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "fr-par-3": { region: "fr-par", location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "nl-ams-1": {
      region: "nl-ams",
      location: "Amsterdam, Netherlands",
      flag: "\u{1F1F3}\u{1F1F1}",
    },
    "nl-ams-2": {
      region: "nl-ams",
      location: "Amsterdam, Netherlands",
      flag: "\u{1F1F3}\u{1F1F1}",
    },
    "nl-ams-3": {
      region: "nl-ams",
      location: "Amsterdam, Netherlands",
      flag: "\u{1F1F3}\u{1F1F1}",
    },
    "pl-waw-1": { region: "pl-waw", location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
    "pl-waw-2": { region: "pl-waw", location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
    "pl-waw-3": { region: "pl-waw", location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
  };

  private static readonly REGION_INFO: Record<string, { location: string; flag: string }> = {
    "fr-par": { location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "nl-ams": { location: "Amsterdam, Netherlands", flag: "\u{1F1F3}\u{1F1F1}" },
    "pl-waw": { location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
  };

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    const secretKey = credentials["secretKey"];
    if (!secretKey) throw new Error("Scaleway plugin: missing secretKey credential");
    this.secretKey = secretKey;
    this.accessKey = credentials["accessKey"] ?? "";
    this.defaultProjectId = credentials["defaultProjectId"] ?? "";
    this.resourceTypes = resourceTypes;
  }

  /**
   * Returns the (lazily-initialised) SDK client. The SDK validates
   * credentials/settings on construction, so we defer until we actually
   * need to talk to the API.
   */
  private getClient(): Client {
    if (!this.sdkClient) {
      const settings: Parameters<typeof createClient>[0] = {
        accessKey: this.accessKey,
        secretKey: this.secretKey,
        defaultRegion: ScalewayClient.DEFAULT_REGION,
        defaultZone: ScalewayClient.DEFAULT_ZONE,
      };
      if (this.defaultProjectId) {
        settings.defaultProjectId = this.defaultProjectId;
      }
      this.sdkClient = createClient(settings);
    }
    return this.sdkClient;
  }

  private instanceApi(): InstanceType<typeof Instancev1.API> {
    return new Instancev1.API(this.getClient());
  }

  private k8sApi(): InstanceType<typeof K8Sv1.API> {
    return new K8Sv1.API(this.getClient());
  }

  private rdbApi(): InstanceType<typeof Rdbv1.API> {
    return new Rdbv1.API(this.getClient());
  }

  private blockApi(): InstanceType<typeof Blockv1.API> {
    return new Blockv1.API(this.getClient());
  }

  private assertS3Credentials(): void {
    if (!this.accessKey) {
      throw new Error(
        "Scaleway plugin: Object Storage operations require an Access Key. " +
          "Please add your Scaleway Access Key (SCW...) in the account credentials.",
      );
    }
  }

  /**
   * Perform an unparsed S3-compatible request against Scaleway Object
   * Storage, signed with AWS SigV4 via the shared `signedS3Fetch` helper.
   * Throws on non-2xx with a Scaleway-flavoured error message.
   */
  private async objectStorageFetch(
    method: string,
    host: string,
    path: string,
    region: string,
  ): Promise<Response> {
    this.assertS3Credentials();

    const url = `https://${host}${path}`;
    const res = await signedS3Fetch({
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      region,
      method,
      url,
    });

    if (!res.ok) {
      throw new Error(`Scaleway S3 error ${res.status} for ${method} ${url}: ${await res.text()}`);
    }
    return res;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "instance":
        return this.listInstances(accountId);
      case "kapsule-cluster":
        return this.listKapsuleClusters(accountId);
      case "rdb-instance":
        return this.listManagedDatabases(accountId);
      case "object-storage-bucket":
        return this.listObjectStorageBuckets(accountId);
      case "block-volume":
        return this.listBlockVolumes(accountId);
      default:
        throw new Error(`Scaleway plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Scaleway plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "kapsule-cluster" && outputKey === "kubeconfig") {
      const externalId = resourceId.split(":").pop()!;
      // externalId format: {region}/{clusterId}
      const parts = externalId.split("/");
      const region = parts[0]! as Region;
      const clusterId = parts[1]!;
      // The SDK returns the kubeconfig as a Blob whose body is JSON of the
      // form {content: base64, ...} (matching the upstream REST response).
      const blob = await this.k8sApi().getClusterKubeConfig({ region, clusterId });
      const text = await blob.text();
      try {
        const parsed = JSON.parse(text) as { content?: string };
        return typeof parsed.content === "string" ? atob(parsed.content) : "";
      } catch {
        // If the response is already plain YAML, return it as-is.
        return text;
      }
    }

    if (typeId === "rdb-instance") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const region = parts[0]! as Region;
      const instanceId = parts[1]!;
      const instance = await this.rdbApi().getInstance({ region, instanceId });
      const endpoint = instance.endpoints?.[0];
      switch (outputKey) {
        case "host":
          return endpoint?.ip ?? endpoint?.hostname ?? "";
        case "port":
          return String(endpoint?.port ?? "");
        case "username":
          return ""; // User needs to look up users from the RDB API
        case "password":
          return ""; // Password is only shown at creation time
        case "dbName":
          return "rdb"; // Default database name
      }
    }

    if (typeId === "object-storage-bucket") {
      if (outputKey === "endpoint") {
        const resource = await this.getResource(typeId, resourceId, accountId);
        const region = String(resource.fields["region"] ?? "fr-par");
        return `https://s3.${region}.scw.cloud`;
      }
      if (outputKey === "accessKeyId") return this.accessKey;
      if (outputKey === "secretAccessKey") return this.secretKey;
    }

    throw new Error(`Scaleway plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "instance") {
      return this.getInstanceCreateConfig();
    }

    if (typeId === "kapsule-cluster") {
      return this.getKapsuleCreateConfig();
    }

    if (typeId === "rdb-instance") {
      return {
        fields: [
          { key: "name", label: "Instance Name", kind: "text", required: true },
          {
            key: "engine",
            label: "Engine",
            kind: "select",
            required: true,
            options: [
              { id: "PostgreSQL-16", label: "PostgreSQL 16" },
              { id: "PostgreSQL-15", label: "PostgreSQL 15" },
              { id: "MySQL-8", label: "MySQL 8" },
            ],
            defaultValue: "PostgreSQL-16",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: Object.entries(ScalewayClient.REGION_INFO).map(([id, info]) => ({
              id,
              label: id,
              location: info.location,
              flag: info.flag,
            })),
            defaultValue: "fr-par",
          },
          {
            key: "nodeType",
            label: "Node Type",
            kind: "text",
            required: true,
            defaultValue: "DB-DEV-S",
            description: "e.g. DB-DEV-S, DB-GP-XS",
          },
          {
            key: "isHaCluster",
            label: "High Availability",
            kind: "select",
            required: true,
            options: [
              { id: "false", label: "Standalone" },
              { id: "true", label: "HA Cluster" },
            ],
            defaultValue: "false",
          },
          {
            key: "disableBackup",
            label: "Backups",
            kind: "select",
            required: true,
            options: [
              { id: "false", label: "Enabled" },
              { id: "true", label: "Disabled" },
            ],
            defaultValue: "false",
          },
          {
            key: "userName",
            label: "Admin Username",
            kind: "text",
            required: true,
            defaultValue: "admin",
          },
          { key: "password", label: "Admin Password", kind: "text", required: true },
        ],
      };
    }

    if (typeId === "object-storage-bucket") {
      return {
        fields: [
          { key: "name", label: "Bucket Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: Object.entries(ScalewayClient.REGION_INFO).map(([id, info]) => ({
              id,
              label: id,
              location: info.location,
              flag: info.flag,
            })),
            defaultValue: "fr-par",
          },
        ],
      };
    }

    if (typeId === "block-volume") {
      return {
        fields: [
          { key: "name", label: "Volume Name", kind: "text", required: true },
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: Object.entries(ScalewayClient.ZONE_INFO).map(([id, info]) => ({
              id,
              label: id,
              location: info.location,
              flag: info.flag,
            })),
            defaultValue: "fr-par-1",
          },
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 1,
            maxGb: 10000,
            defaultGb: 100,
            stepGb: 1,
          },
          {
            key: "perfIops",
            label: "Performance (IOPS)",
            kind: "select",
            required: true,
            defaultValue: "5000",
            options: [
              { id: "5000", label: "5,000 IOPS" },
              { id: "15000", label: "15,000 IOPS" },
            ],
          },
        ],
      };
    }

    throw new Error(`No create config for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId === "instance") {
      const externalId = resourceId.split(":").pop()!;
      // externalId format: {zone}/{serverId}
      const parts = externalId.split("/");
      const zone = parts[0]! as Zone;
      const serverId = parts[1]!;
      // Terminate to also release the IP
      await this.instanceApi().serverAction({ zone, serverId, action: "terminate" });
      return;
    }

    if (typeId === "kapsule-cluster") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const region = parts[0]! as Region;
      const clusterId = parts[1]!;
      await this.k8sApi().deleteCluster({ region, clusterId, withAdditionalResources: true });
      return;
    }

    if (typeId === "rdb-instance") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const region = parts[0]! as Region;
      const instanceId = parts[1]!;
      await this.rdbApi().deleteInstance({ region, instanceId });
      return;
    }

    if (typeId === "object-storage-bucket") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const region = parts[0]!;
      const bucketName = parts[1]!;
      // S3-compatible DeleteBucket: DELETE https://<bucket>.s3.<region>.scw.cloud/
      await this.objectStorageFetch("DELETE", `${bucketName}.s3.${region}.scw.cloud`, "/", region);
      return;
    }

    if (typeId === "block-volume") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const zone = parts[0]! as Zone;
      const volumeId = parts[1]!;
      await this.blockApi().deleteVolume({ zone, volumeId });
      return;
    }

    throw new Error(`Scaleway plugin: deleteResource not supported for type "${typeId}"`);
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "block-volume" && targetTypeId === "instance") {
      const [volume, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const volumeZone = String(volume.fields["zone"] ?? "");
      const instanceZone = String(instance.fields["zone"] ?? "");
      if (volumeZone && instanceZone && volumeZone !== instanceZone) {
        throw new Error(
          `Volume zone ${volumeZone} does not match instance zone ${instanceZone} — Scaleway block volumes must be in the same AZ as the instance.`,
        );
      }
      const instanceExternalId = instance.externalId ?? "";
      const serverId = instanceExternalId.split("/").pop() ?? "";
      const volumeExternalId = volume.externalId ?? "";
      const volumeId = volumeExternalId.split("/").pop() ?? "";
      if (!serverId || !volumeId || !instanceZone) {
        throw new Error("Cannot determine zone/instance/volume id for attachment");
      }
      // The SDK's attachVolume helper reads the server's current volume map,
      // appends the new volume slot, and PATCHes the server — exactly what
      // the hand-rolled code below used to do.
      await this.instanceApi().attachVolume({
        zone: instanceZone as Zone,
        serverId,
        volumeId,
      });
      return;
    }
    throw new Error(
      `Scaleway plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "instance") {
      return this.createInstance(accountId, fields);
    }

    if (typeId === "kapsule-cluster") {
      return this.createKapsuleCluster(accountId, fields);
    }

    if (typeId === "rdb-instance") {
      const region = (fields["region"] ?? "fr-par") as Region;
      const created = await this.rdbApi().createInstance({
        region,
        name: fields["name"] ?? "",
        engine: fields["engine"] ?? "PostgreSQL-16",
        nodeType: fields["nodeType"] ?? "DB-DEV-S",
        isHaCluster: fields["isHaCluster"] === "true",
        disableBackup: fields["disableBackup"] === "true",
        userName: fields["userName"] ?? "admin",
        password: fields["password"] ?? "",
        // The original REST payload omitted these; passing 0/false preserves
        // the same server-side defaults.
        volumeSize: 0,
        backupSameRegion: false,
      });
      const engine = fields["engine"] ?? "PostgreSQL-16";
      const [engineName, engineVersion] = engine.split("-");
      const createdAt = created.createdAt
        ? created.createdAt.toISOString()
        : new Date().toISOString();
      return {
        id: `${accountId}:rdb-instance:${region}/${created.id}`,
        pluginId: "scaleway",
        resourceTypeId: "rdb-instance",
        accountId,
        displayName: created.name,
        fields: {
          name: created.name,
          engine: engineName ?? engine,
          engineVersion: engineVersion ?? "",
          region,
          nodeType: fields["nodeType"] ?? "DB-DEV-S",
          status: created.status ?? "provisioning",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${region}/${created.id}`,
        createdAt,
        updatedAt: createdAt,
      };
    }

    if (typeId === "object-storage-bucket") {
      const region = fields["region"] ?? "fr-par";
      const bucketName = fields["name"] ?? "";
      // S3-compatible CreateBucket: PUT https://<bucket>.s3.<region>.scw.cloud/
      await this.objectStorageFetch("PUT", `${bucketName}.s3.${region}.scw.cloud`, "/", region);
      const now = new Date().toISOString();
      return {
        id: `${accountId}:object-storage-bucket:${region}/${bucketName}`,
        pluginId: "scaleway",
        resourceTypeId: "object-storage-bucket",
        accountId,
        displayName: bucketName,
        fields: { name: bucketName, region },
        resolvedOutputs: {
          endpoint: `https://s3.${region}.scw.cloud`,
        },
        secretStates: [],
        externalId: `${region}/${bucketName}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "block-volume") {
      const zone = (fields["zone"] ?? "fr-par-1") as Zone;
      const sizeGb = Number(fields["sizeGb"] ?? 100);
      const perfIops = Number(fields["perfIops"] ?? 5000);
      const created = await this.blockApi().createVolume({
        zone,
        ...(this.defaultProjectId ? { projectId: this.defaultProjectId } : {}),
        name: fields["name"] ?? "",
        perfIops,
        fromEmpty: { size: sizeGb * 1_000_000_000 },
      });
      const nowIso = new Date().toISOString();
      const createdAt = created.createdAt ? created.createdAt.toISOString() : nowIso;
      return {
        id: `${accountId}:block-volume:${zone}/${created.id}`,
        pluginId: "scaleway",
        resourceTypeId: "block-volume",
        accountId,
        displayName: created.name ?? fields["name"] ?? created.id,
        fields: {
          name: created.name ?? fields["name"] ?? "",
          zone,
          sizeGb: Math.round(created.size / 1_000_000_000),
          perfIops: String(perfIops),
          status: created.status ?? "creating",
          attachedInstanceId: "",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${zone}/${created.id}`,
        createdAt,
        updatedAt: nowIso,
      };
    }

    throw new Error(`Scaleway plugin: createResource not supported for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;
    const ro = resource.resolvedOutputs ?? {};

    switch (resourceTypeId) {
      case "instance": {
        const state = String(f.state ?? "unknown");
        const stats: DashboardStat[] = [
          {
            label: "State",
            value: state,
            variant:
              state === "running"
                ? "status-healthy"
                : state === "stopped" || state === "off"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Type", value: String(f.commercialType ?? "") },
          { label: "Zone", value: String(f.zone ?? "") },
        ];
        if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
        return stats;
      }
      case "kapsule-cluster": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "ready" || status === "running" ? "status-healthy" : "status-degraded",
          },
          { label: "Version", value: String(f.version ?? "") },
          { label: "Region", value: String(f.region ?? "") },
          { label: "Nodes", value: String(f.nodeCount ?? 0) },
        ];
      }
      case "rdb-instance": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "ready" || status === "running" ? "status-healthy" : "status-degraded",
          },
          { label: "Engine", value: String(f.engine ?? "") },
          { label: "Node Type", value: String(f.nodeType ?? "") },
          { label: "Region", value: String(f.region ?? "") },
        ];
      }
      case "object-storage-bucket": {
        return [
          { label: "Name", value: String(f.name ?? "") },
          { label: "Region", value: String(f.region ?? "") },
        ];
      }
      default:
        return [];
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? fields["status"] ?? "");

    let statusKind: ResourceStatus = "info";
    if (state === "running" || state === "ready") statusKind = "healthy";
    else if (
      state === "starting" ||
      state === "stopping" ||
      state === "provisioning" ||
      state === "creating"
    )
      statusKind = "provisioning";
    else if (state === "stopped" || state === "error" || state === "locked" || state === "deleting")
      statusKind = "error";

    return {
      title: resource.displayName,
      subtitle: `${resource.resourceTypeId} · ${String(fields["zone"] ?? fields["region"] ?? "")}`,
      status: { kind: "status-dot", status: statusKind },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: labeledFieldItems(fields, this.resourceTypes, resource.resourceTypeId),
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const state = String(resource.fields["state"] ?? resource.fields["status"] ?? "");
    let status: ResourceStatus = "info";
    if (state === "running" || state === "ready") status = "healthy";
    else if (state === "starting" || state === "stopping" || state === "provisioning")
      status = "provisioning";
    else if (state === "stopped" || state === "error" || state === "locked") status = "error";

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  private async listBlockVolumes(accountId: string): Promise<ResourceInstance[]> {
    const zones = Object.keys(ScalewayClient.ZONE_INFO) as Zone[];
    const api = this.blockApi();
    const fetches = zones.map(async (zone) => {
      try {
        const data = await api.listVolumes({
          zone,
          ...(this.defaultProjectId ? { projectId: this.defaultProjectId } : {}),
          includeDeleted: false,
        });
        return data.volumes.map<ResourceInstance>((v) => {
          const attached =
            v.references.find((r) => r.productResourceType === "instance_server")
              ?.productResourceId ?? "";
          const createdAt = v.createdAt ? v.createdAt.toISOString() : new Date().toISOString();
          const updatedAt = v.updatedAt ? v.updatedAt.toISOString() : createdAt;
          return {
            id: `${accountId}:block-volume:${zone}/${v.id}`,
            pluginId: "scaleway",
            resourceTypeId: "block-volume",
            accountId,
            displayName: v.name || v.id,
            fields: {
              name: v.name ?? "",
              zone,
              sizeGb: Math.round(v.size / 1_000_000_000),
              perfIops: String(v.specs?.perfIops ?? ""),
              status: v.status ?? "",
              attachedInstanceId: attached,
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: `${zone}/${v.id}`,
            createdAt,
            updatedAt,
          };
        });
      } catch {
        return [];
      }
    });
    const allResults = await Promise.all(fetches);
    return allResults.flat();
  }

  private async listInstances(accountId: string): Promise<ResourceInstance[]> {
    const zones = Object.keys(ScalewayClient.ZONE_INFO) as Zone[];
    const api = this.instanceApi();

    const fetches = zones.map(async (zone) => {
      try {
        const data = await api.listServers({
          zone,
          ...(this.defaultProjectId ? { project: this.defaultProjectId } : {}),
        });
        return data.servers.map((s) => this.mapInstance(s, zone, accountId));
      } catch {
        // Zone may not be available — skip silently
        return [];
      }
    });

    const allResults = await Promise.all(fetches);
    return allResults.flat();
  }

  private mapInstance(
    s: import("@scaleway/sdk-instance").Instancev1.Server,
    zone: Zone,
    accountId: string,
  ): ResourceInstance {
    const publicIp = s.publicIp?.address ?? "";
    const privateIp = s.privateIp ?? "";
    const externalId = `${zone}/${s.id}`;
    const createdAt = s.creationDate ? s.creationDate.toISOString() : new Date().toISOString();
    const updatedAt = s.modificationDate ? s.modificationDate.toISOString() : createdAt;

    return {
      id: `${accountId}:instance:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "instance",
      accountId,
      displayName: s.name,
      fields: {
        name: s.name,
        zone,
        commercialType: s.commercialType ?? "",
        image: s.image?.name ?? "",
        state: s.state ?? "",
      },
      resolvedOutputs: { publicIp, privateIp },
      secretStates: [],
      externalId,
      createdAt,
      updatedAt,
    };
  }

  private async getInstanceCreateConfig(): Promise<CreateResourceConfig> {
    const zones = Object.keys(ScalewayClient.ZONE_INFO);

    const regionOptions = zones.map((zone) => {
      const info = ScalewayClient.ZONE_INFO[zone];
      return {
        id: zone,
        label: zone,
        ...(info ? { location: info.location, flag: info.flag } : {}),
      };
    });

    const api = this.instanceApi();

    let sizes: SizeOption[] = [];
    try {
      const data = await api.listServersTypes({ zone: "fr-par-1" });

      const sizesByCategory = new Map<string, SizeOption[]>();
      for (const [slug, info] of Object.entries(data.servers)) {
        // Categorize by prefix: DEV1, GP1, PRO2, ENT1, STARDUST1, etc.
        const category = slug.replace(/-.*$/, "");
        if (!sizesByCategory.has(category)) sizesByCategory.set(category, []);
        const monthlyPrice =
          info.monthlyPrice ?? (info.hourlyPrice ? info.hourlyPrice * 730 : undefined);
        sizesByCategory.get(category)!.push({
          id: slug,
          label: slug,
          vcpus: info.ncpus,
          memoryMb: Math.round(info.ram / (1024 * 1024)),
          diskGb: 0, // Scaleway uses separate volumes
          category,
          ...(monthlyPrice != null ? { priceMonthly: Math.round(monthlyPrice * 100) / 100 } : {}),
        });
      }
      sizes = [...sizesByCategory.values()].flat();
    } catch {
      // Fall back to a minimal static list
      sizes = [
        { id: "DEV1-S", label: "DEV1-S", vcpus: 2, memoryMb: 2048, diskGb: 0, category: "DEV1" },
        { id: "DEV1-M", label: "DEV1-M", vcpus: 3, memoryMb: 4096, diskGb: 0, category: "DEV1" },
        { id: "DEV1-L", label: "DEV1-L", vcpus: 4, memoryMb: 8192, diskGb: 0, category: "DEV1" },
        { id: "GP1-XS", label: "GP1-XS", vcpus: 4, memoryMb: 16384, diskGb: 0, category: "GP1" },
        { id: "GP1-S", label: "GP1-S", vcpus: 8, memoryMb: 32768, diskGb: 0, category: "GP1" },
        { id: "GP1-M", label: "GP1-M", vcpus: 16, memoryMb: 65536, diskGb: 0, category: "GP1" },
        {
          id: "PRO2-XXS",
          label: "PRO2-XXS",
          vcpus: 2,
          memoryMb: 8192,
          diskGb: 0,
          category: "PRO2",
        },
        { id: "PRO2-XS", label: "PRO2-XS", vcpus: 4, memoryMb: 16384, diskGb: 0, category: "PRO2" },
        { id: "PRO2-S", label: "PRO2-S", vcpus: 8, memoryMb: 32768, diskGb: 0, category: "PRO2" },
      ];
    }

    let images: ImageOption[] = [];
    try {
      const data = await api.listImages({ zone: "fr-par-1", perPage: 100, public: true });

      const imageMap = new Map<string, ImageOption[]>();
      for (const img of data.images) {
        if (img.arch !== "x86_64") continue;
        // Categorize by distro name prefix
        const nameParts = img.name.split(" ");
        const category = nameParts[0] ?? "Other";
        if (!imageMap.has(category)) imageMap.set(category, []);
        imageMap.get(category)!.push({ id: img.id, label: img.name, category });
      }
      images = [...imageMap.values()].flat();
    } catch {
      // Minimal fallback
      images = [
        { id: "ubuntu_jammy", label: "Ubuntu 22.04 Jammy Jellyfish", category: "Ubuntu" },
        { id: "ubuntu_noble", label: "Ubuntu 24.04 Noble Numbat", category: "Ubuntu" },
        { id: "debian_bookworm", label: "Debian 12 Bookworm", category: "Debian" },
      ];
    }

    const defaultImage = images.find((i) => i.category === "Ubuntu")?.id ?? images[0]?.id;
    const firstRegion = regionOptions[0]?.id;
    const firstSize = sizes[0]?.id;

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "zone",
          label: "Zone",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(firstRegion ? { defaultValue: firstRegion } : {}),
        },
        {
          key: "commercialType",
          label: "Size",
          kind: "size-picker",
          required: true,
          sizes,
          ...(firstSize ? { defaultValue: firstSize } : {}),
        },
        {
          key: "image",
          label: "Image",
          kind: "image-picker",
          required: true,
          images,
          ...(defaultImage ? { defaultValue: defaultImage } : {}),
        },
        { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
      ],
    };
  }

  private async createInstance(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const zone = (fields["zone"] ?? "fr-par-1") as Zone;
    const api = this.instanceApi();

    const created = await api.createServer({
      zone,
      name: fields["name"] ?? "",
      commercialType: fields["commercialType"] ?? "",
      image: fields["image"] ?? "",
      ...(this.defaultProjectId ? { project: this.defaultProjectId } : {}),
      dynamicIpRequired: true,
      protected: false,
    });

    const server = created.server;
    if (!server) {
      throw new Error("Scaleway plugin: createServer returned no server");
    }

    // Boot the instance after creation
    try {
      await api.serverAction({ zone, serverId: server.id, action: "poweron" });
    } catch {
      // Non-fatal — instance was created even if boot fails
    }

    const publicIp = server.publicIp?.address ?? "";
    const externalId = `${zone}/${server.id}`;
    const createdAt = server.creationDate
      ? server.creationDate.toISOString()
      : new Date().toISOString();

    return {
      id: `${accountId}:instance:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "instance",
      accountId,
      displayName: server.name,
      fields: {
        name: server.name,
        zone,
        commercialType: server.commercialType ?? fields["commercialType"] ?? "",
        image: server.image?.name ?? fields["image"] ?? "",
        state: server.state ?? "starting",
      },
      resolvedOutputs: { publicIp, privateIp: "" },
      secretStates: [],
      externalId,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private async listKapsuleClusters(accountId: string): Promise<ResourceInstance[]> {
    const regions = Object.keys(ScalewayClient.REGION_INFO) as Region[];
    const api = this.k8sApi();

    const fetches = regions.map(async (region) => {
      try {
        const data = await api.listClusters({
          region,
          ...(this.defaultProjectId ? { projectId: this.defaultProjectId } : {}),
        });
        return data.clusters.map((c) => this.mapKapsuleCluster(c, region, accountId));
      } catch {
        return [];
      }
    });

    const allResults = await Promise.all(fetches);
    return allResults.flat();
  }

  private mapKapsuleCluster(
    c: import("@scaleway/sdk-k8s").K8Sv1.Cluster,
    region: Region,
    accountId: string,
  ): ResourceInstance {
    const externalId = `${region}/${c.id}`;
    const createdAt = c.createdAt ? c.createdAt.toISOString() : new Date().toISOString();
    const updatedAt = c.updatedAt ? c.updatedAt.toISOString() : createdAt;

    return {
      id: `${accountId}:kapsule-cluster:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "kapsule-cluster",
      accountId,
      displayName: c.name,
      fields: {
        name: c.name,
        region: c.region ?? region,
        version: c.version ?? "",
        // The Cluster type does not return per-pool info; we used to read it
        // from c.pools[0] but the SDK's Cluster has no pools field. Leave
        // nodeType empty here — the user can drill in for pool details.
        nodeType: "",
        nodeCount: 0,
        status: c.status ?? "",
      },
      resolvedOutputs: {
        clusterUrl: c.clusterUrl ?? "",
      },
      secretStates: [],
      externalId,
      createdAt,
      updatedAt,
    };
  }

  private async getKapsuleCreateConfig(): Promise<CreateResourceConfig> {
    const regions = Object.entries(ScalewayClient.REGION_INFO).map(([id, info]) => ({
      id,
      label: id,
      location: info.location,
      flag: info.flag,
    }));

    let versions: { id: string; label: string }[] = [];
    try {
      const data = await this.k8sApi().listVersions({ region: "fr-par" });
      versions = data.versions.map((v) => ({
        id: v.name,
        label: v.name,
      }));
    } catch {
      versions = [{ id: "1.30.2", label: "1.30.2" }];
    }

    // Reuse instance sizes for node pools
    let sizes: SizeOption[] = [];
    try {
      const data = await this.instanceApi().listServersTypes({ zone: "fr-par-1" });

      const sizesByCategory = new Map<string, SizeOption[]>();
      for (const [slug, info] of Object.entries(data.servers)) {
        const category = slug.replace(/-.*$/, "");
        if (!sizesByCategory.has(category)) sizesByCategory.set(category, []);
        const monthlyPrice =
          info.monthlyPrice ?? (info.hourlyPrice ? info.hourlyPrice * 730 : undefined);
        sizesByCategory.get(category)!.push({
          id: slug,
          label: slug,
          vcpus: info.ncpus,
          memoryMb: Math.round(info.ram / (1024 * 1024)),
          diskGb: 0,
          category,
          ...(monthlyPrice != null ? { priceMonthly: Math.round(monthlyPrice * 100) / 100 } : {}),
        });
      }
      sizes = [...sizesByCategory.values()].flat();
    } catch {
      sizes = [
        { id: "DEV1-M", label: "DEV1-M", vcpus: 3, memoryMb: 4096, diskGb: 0, category: "DEV1" },
        { id: "GP1-XS", label: "GP1-XS", vcpus: 4, memoryMb: 16384, diskGb: 0, category: "GP1" },
        { id: "GP1-S", label: "GP1-S", vcpus: 8, memoryMb: 32768, diskGb: 0, category: "GP1" },
      ];
    }

    const defaultRegion = regions[0]?.id;
    const defaultSize = sizes[0]?.id;
    const defaultVersion = versions[0]?.id;

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(defaultRegion ? { defaultValue: defaultRegion } : {}),
        },
        {
          key: "version",
          label: "Kubernetes Version",
          kind: "select",
          required: true,
          options: versions,
          ...(defaultVersion ? { defaultValue: defaultVersion } : {}),
        },
        {
          key: "nodeType",
          label: "Node Pool Size",
          kind: "size-picker",
          required: true,
          sizes,
          ...(defaultSize ? { defaultValue: defaultSize } : {}),
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "3",
          minValue: 1,
          stepValue: 1,
          description: "Initial number of nodes in the default pool.",
        },
      ],
    };
  }

  private async createKapsuleCluster(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const region = (fields["region"] ?? "fr-par") as Region;
    const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "3", 10);
    const nodeCount =
      Number.isFinite(requestedNodeCount) && requestedNodeCount > 0 ? requestedNodeCount : 3;

    const poolNameBase = (fields["name"] ?? "cluster").trim() || "cluster";
    // The cluster's first pool inherits the cluster region's first zone.
    const poolZone = `${region}-1` as Zone;

    const cluster = await this.k8sApi().createCluster({
      region,
      // "kapsule" is the default cluster type for managed Kapsule clusters.
      type: "kapsule",
      name: fields["name"] ?? "",
      description: "",
      version: fields["version"] ?? "1.30.2",
      cni: "cilium",
      ...(this.defaultProjectId ? { projectId: this.defaultProjectId } : {}),
      pools: [
        {
          name: `${poolNameBase}-default-pool`,
          nodeType: fields["nodeType"] ?? "",
          size: nodeCount,
          autoscaling: false,
          autohealing: true,
          containerRuntime: "containerd",
          tags: [],
          kubeletArgs: {},
          zone: poolZone,
          rootVolumeType: "sbs_5k",
          publicIpDisabled: false,
          labels: {},
          taints: [],
          startupTaints: [],
        },
      ],
    });

    const externalId = `${region}/${cluster.id}`;
    const createdAt = cluster.createdAt
      ? cluster.createdAt.toISOString()
      : new Date().toISOString();

    return {
      id: `${accountId}:kapsule-cluster:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "kapsule-cluster",
      accountId,
      displayName: cluster.name || fields["name"] || "",
      fields: {
        name: cluster.name || fields["name"] || "",
        region,
        version: cluster.version || fields["version"] || "",
        nodeType: fields["nodeType"] ?? "",
        nodeCount,
        status: cluster.status ?? "creating",
      },
      resolvedOutputs: {
        clusterUrl: cluster.clusterUrl ?? "",
      },
      secretStates: [],
      externalId,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private async listManagedDatabases(accountId: string): Promise<ResourceInstance[]> {
    const regions = Object.keys(ScalewayClient.REGION_INFO) as Region[];
    const api = this.rdbApi();

    const fetches = regions.map(async (region) => {
      try {
        const data = await api.listInstances({
          region,
          ...(this.defaultProjectId ? { projectId: this.defaultProjectId } : {}),
        });
        return data.instances.map((db) => this.mapManagedDatabase(db, region, accountId));
      } catch {
        return [];
      }
    });

    const allResults = await Promise.all(fetches);
    return allResults.flat();
  }

  private mapManagedDatabase(
    db: import("@scaleway/sdk-rdb").Rdbv1.Instance,
    region: Region,
    accountId: string,
  ): ResourceInstance {
    const externalId = `${region}/${db.id}`;
    const engine = db.engine ?? "";
    // Scaleway engine format: "PostgreSQL-16", "MySQL-8", etc.
    const [engineName, engineVersion] = engine.split("-");
    const createdAt = db.createdAt ? db.createdAt.toISOString() : new Date().toISOString();

    return {
      id: `${accountId}:rdb-instance:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "rdb-instance",
      accountId,
      displayName: db.name,
      fields: {
        name: db.name,
        engine: engineName ?? engine,
        engineVersion: engineVersion ?? "",
        region: db.region ?? region,
        nodeType: db.nodeType ?? "",
        status: db.status ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private async listObjectStorageBuckets(accountId: string): Promise<ResourceInstance[]> {
    // Scaleway Object Storage uses the S3-compatible API with AWS SigV4 auth.
    // We query each region's S3 endpoint and parse the XML ListBuckets response.
    const regions = ["fr-par", "nl-ams", "pl-waw"];
    const results: ResourceInstance[] = [];

    for (const region of regions) {
      try {
        const res = await this.objectStorageFetch("GET", `s3.${region}.scw.cloud`, "/", region);
        const xml = await res.text();
        // Minimal XML parsing for <Bucket><Name>…</Name><CreationDate>…</CreationDate></Bucket>
        const buckets: Array<{ name: string; creationDate: string }> = [];
        const bucketRegex =
          /<Bucket>\s*<Name>([^<]+)<\/Name>\s*<CreationDate>([^<]+)<\/CreationDate>\s*<\/Bucket>/g;
        let m: RegExpExecArray | null;
        while ((m = bucketRegex.exec(xml)) !== null) {
          buckets.push({ name: m[1]!, creationDate: m[2]! });
        }
        for (const b of buckets) {
          results.push({
            id: `${accountId}:object-storage-bucket:${region}/${b.name}`,
            pluginId: "scaleway",
            resourceTypeId: "object-storage-bucket",
            accountId,
            displayName: b.name,
            fields: {
              name: b.name,
              region,
            },
            resolvedOutputs: {
              endpoint: `https://s3.${region}.scw.cloud`,
            },
            secretStates: [],
            externalId: `${region}/${b.name}`,
            createdAt: b.creationDate,
            updatedAt: b.creationDate,
          });
        }
      } catch {
        // Region may not have Object Storage or credentials may lack access — skip
      }
    }
    return results;
  }
}
