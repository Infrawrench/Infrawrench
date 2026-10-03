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
  CostFetchRange,
  CostRow,
  DashboardStat,
  MetricSeries,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
} from "@infrawrench/plugin-base";
import {
  deleteS3Object,
  getS3BucketPolicy,
  joinSubtitle,
  jsonRestFetch,
  labeledFieldItems,
  listS3Objects,
  makeS3Folder,
  pathStyleUrl,
  putS3BucketPolicy,
  signedS3Fetch,
  uploadS3Object,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import type { S3StorageConfig, StorageObject } from "@infrawrench/plugin-base";
import { fetchScalewayCostData } from "./cost-data.js";
import * as products from "./products.js";
import type { ScwRest } from "./products.js";
import type { Client, Region, Zone } from "@scaleway/sdk-client";
import {
  createAdvancedClient,
  createClient,
  withHTTPClient,
  withProfile,
} from "@scaleway/sdk-client";
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
 * S3-compatible and uses a hand-rolled SigV4 path below: the SDK does
 * not cover Object Storage.
 */
export class ScalewayClient implements PluginClient {
  private readonly secretKey: string;
  private readonly accessKey: string;
  private readonly defaultProjectId: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly cockpitQueryToken: string | null;
  private readonly services: HostServices | undefined;

  // Cache of discovered Cockpit data-source URLs keyed by region slug.
  private cockpitDataSourceCache: Map<string, string> = new Map();

  /**
   * Cache of Object Storage bucket name → region populated by
   * `listObjectStorageBuckets`. Storage verbs only receive the bucket name,
   * but Scaleway S3 endpoints are region-specific.
   */
  private readonly objectStorageBucketRegions = new Map<string, string>();

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
    "it-mil-1": { region: "it-mil", location: "Milan, Italy", flag: "\u{1F1EE}\u{1F1F9}" },
  };

  private static readonly REGION_INFO: Record<string, { location: string; flag: string }> = {
    "fr-par": { location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "nl-ams": { location: "Amsterdam, Netherlands", flag: "\u{1F1F3}\u{1F1F1}" },
    "pl-waw": { location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
    "it-mil": { location: "Milan, Italy", flag: "\u{1F1EE}\u{1F1F9}" },
  };

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    const secretKey = credentials["secretKey"];
    if (!secretKey) throw new Error("Scaleway plugin: missing secretKey credential");
    this.secretKey = secretKey;
    this.accessKey = credentials["accessKey"] ?? "";
    this.defaultProjectId = credentials["defaultProjectId"] ?? "";
    this.resourceTypes = resourceTypes;
    this.cockpitQueryToken = credentials["cockpitQueryToken"] ?? null;
    this.services = services;
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
      if (this.services?.http) {
        this.sdkClient = createAdvancedClient(
          withProfile(settings),
          withHTTPClient((request) => this.fetchThroughHost(request)),
        );
      } else {
        this.sdkClient = createClient(settings);
      }
    }
    return this.sdkClient;
  }

  private async fetchThroughHost(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const response = await this.services!.http!.request({
      url: request.url,
      method: request.method,
      headers,
      ...(body ? { body } : {}),
    });
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
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

  /**
   * Plain REST access for products without an SDK dependency here (see
   * `products.ts`). Same secret-key auth and host HTTP routing as Cockpit.
   */
  private get rest(): ScwRest {
    return {
      projectId: this.defaultProjectId,
      fetch: <T>(path: string, init?: RequestInit) =>
        jsonRestFetch<T>({
          vendor: "Scaleway",
          url: `https://api.scaleway.com${path}`,
          errorPath: path.split("?")[0] ?? path,
          headers: { "X-Auth-Token": this.secretKey },
          ...(init ? { init } : {}),
          ...(this.services?.http ? { http: this.services.http } : {}),
        }),
    };
  }

  private zones(): string[] {
    return Object.keys(ScalewayClient.ZONE_INFO);
  }

  private regions(): string[] {
    return Object.keys(ScalewayClient.REGION_INFO);
  }

  private zoneOptions() {
    return Object.entries(ScalewayClient.ZONE_INFO).map(([id, info]) => ({
      id,
      label: id,
      location: info.location,
      flag: info.flag,
    }));
  }

  private regionOptions() {
    return Object.entries(ScalewayClient.REGION_INFO).map(([id, info]) => ({
      id,
      label: id,
      location: info.location,
      flag: info.flag,
    }));
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
      case "flexible-ip":
        return this.listFlexibleIps(accountId);
      case "load-balancer":
        return products.listLoadBalancers(this.rest, this.zones(), accountId);
      case "private-network":
        return products.listPrivateNetworks(this.rest, this.regions(), accountId);
      case "serverless-container":
        return products.listContainers(this.rest, this.regions(), accountId);
      case "serverless-function":
        return products.listFunctions(this.rest, this.regions(), accountId);
      case "registry-namespace":
        return products.listRegistryNamespaces(this.rest, this.regions(), accountId);
      case "secret":
        return products.listSecrets(this.rest, this.regions(), accountId);
      case "dns-zone":
        return products.listDnsZones(this.rest, accountId);
      case "dns-record":
        return products.listDnsRecords(this.rest, accountId);
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
    if (outputKey === "nodeHourlyRates") {
      // The Kubernetes peer asks every managed-cluster type what its nodes
      // cost per hour, so it can derive per-namespace and per-workload spend.
      // Scaleway publishes no pricing API this plugin reads today.
      // Returning "" is the honest answer and makes the peer show capacity and
      // efficiency without money rather than inventing a price. It must return
      // rather than fall through: the host resolves every credentialMapping
      // before building the peer client, so a throw here would take the whole
      // Kubernetes tab down.
      return "";
    }

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

    if (SIMPLE_OUTPUT_TYPES.has(typeId)) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const value = resource.resolvedOutputs[outputKey];
      if (value !== undefined) return String(value);
    }

    throw new Error(`Scaleway plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "instance") {
      return this.getInstanceCreateConfig();
    }

    if (typeId === "flexible-ip") {
      return {
        fields: [
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: this.zoneOptions(),
            defaultValue: "fr-par-1",
          },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "routed_ipv4",
            options: [
              { id: "routed_ipv4", label: "IPv4" },
              { id: "routed_ipv6", label: "IPv6 (/64)" },
            ],
          },
        ],
      };
    }

    if (typeId === "load-balancer") {
      return products.loadBalancerCreateConfig(this.rest, this.zoneOptions());
    }

    if (typeId === "private-network") {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: this.regionOptions(),
            defaultValue: "fr-par",
          },
          {
            key: "subnets",
            label: "Subnets",
            kind: "string-list",
            required: false,
            description:
              "Private CIDR ranges, e.g. 172.16.0.0/22. Leave empty to let Scaleway pick one",
          },
        ],
      };
    }

    if (typeId === "registry-namespace") {
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description: "Lowercase letters, digits and hyphens; unique across Scaleway",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: this.regionOptions(),
            defaultValue: "fr-par",
          },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "isPublic",
            label: "Visibility",
            kind: "select",
            required: true,
            defaultValue: "false",
            options: [
              { id: "false", label: "Private" },
              { id: "true", label: "Public (anyone can pull)" },
            ],
          },
        ],
      };
    }

    if (typeId === "dns-zone") {
      return {
        fields: [
          {
            key: "domain",
            label: "Domain",
            kind: "text",
            required: true,
            placeholder: "example.com",
            description: "A domain registered with Scaleway or an external domain you added",
          },
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "text",
            required: true,
            description: "Creates the zone <subdomain>.<domain>",
          },
        ],
      };
    }

    if (typeId === "dns-record") {
      return products.dnsRecordCreateConfig(this.rest, parentResourceId);
    }

    if (typeId === "kapsule-cluster") {
      return this.getKapsuleCreateConfig();
    }

    if (typeId === "rdb-instance") {
      return this.getRdbCreateConfig();
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

    switch (typeId) {
      case "flexible-ip": {
        const { location, id } = products.splitScoped(resourceId);
        await this.instanceApi().deleteIp({ zone: location as Zone, ip: id });
        return;
      }
      case "load-balancer":
        return products.deleteLoadBalancer(this.rest, resourceId);
      case "private-network": {
        const { location, id } = products.splitScoped(resourceId);
        await this.rest.fetch<unknown>(`/vpc/v2/regions/${location}/private-networks/${id}`, {
          method: "DELETE",
        });
        return;
      }
      case "serverless-container":
        return products.deleteContainer(this.rest, resourceId);
      case "serverless-function":
        return products.deleteFunction(this.rest, resourceId);
      case "registry-namespace":
        return products.deleteRegistryNamespace(this.rest, resourceId);
      case "secret":
        return products.deleteSecret(this.rest, resourceId);
      case "dns-zone":
        return products.deleteDnsZone(this.rest, resourceId);
      case "dns-record":
        return products.deleteDnsRecord(this.rest, resourceId);
    }

    throw new Error(`Scaleway plugin: deleteResource not supported for type "${typeId}"`);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "instance" && INSTANCE_ACTIONS.has(actionId)) {
      const externalId = resourceId.split(":").pop()!;
      // externalId format: {zone}/{serverId}
      const parts = externalId.split("/");
      const zone = parts[0]! as Zone;
      const serverId = parts[1]!;
      await this.instanceApi().serverAction({
        zone,
        serverId,
        action: actionId as "poweron",
        // `backup` snapshots every volume into a new image; name it after
        // the moment it was taken so the Console list stays readable.
        ...(actionId === "backup"
          ? { name: `infrawrench-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}` }
          : {}),
      });
      return;
    }
    if (typeId === "serverless-container" && actionId === "redeploy") {
      await products.redeployContainer(this.rest, resourceId);
      return;
    }
    if (typeId === "serverless-function" && actionId === "deploy") {
      await products.deployFunction(this.rest, resourceId);
      return;
    }
    throw new Error(
      `Scaleway plugin: invokeAction "${actionId}" not supported for type "${typeId}"`,
    );
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
      await this.instanceApi().attachVolume({
        zone: instanceZone as Zone,
        serverId,
        volumeId,
      });
      return;
    }
    if (sourceTypeId === "flexible-ip" && targetTypeId === "instance") {
      const instance = await this.getResource(targetTypeId, targetResourceId, accountId);
      const ip = products.splitScoped(sourceResourceId);
      const instanceZone = String(instance.fields["zone"] ?? "");
      if (instanceZone && instanceZone !== ip.location) {
        throw new Error(
          `Flexible IP zone ${ip.location} does not match instance zone ${instanceZone}.`,
        );
      }
      const serverId = (instance.externalId ?? "").split("/").pop() ?? "";
      if (!serverId) throw new Error("Cannot determine instance id for the flexible IP");
      await this.instanceApi().updateIp({ zone: ip.location as Zone, ip: ip.id, server: serverId });
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
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    if (typeId === "instance") {
      return this.createInstance(accountId, fields);
    }

    if (typeId === "flexible-ip") {
      const zone = (fields["zone"] || "fr-par-1") as Zone;
      const created = await this.instanceApi().createIp({
        zone,
        ...(this.defaultProjectId ? { project: this.defaultProjectId } : {}),
        type: (fields["type"] || "routed_ipv4") as "routed_ipv4" | "routed_ipv6",
      });
      if (!created.ip) throw new Error("Scaleway plugin: createIp returned no IP");
      return this.mapFlexibleIp(created.ip, zone, accountId);
    }
    if (typeId === "load-balancer") {
      return products.createLoadBalancer(this.rest, accountId, fields);
    }
    if (typeId === "private-network") {
      return products.createPrivateNetwork(this.rest, accountId, fields);
    }
    if (typeId === "registry-namespace") {
      return products.createRegistryNamespace(this.rest, accountId, fields);
    }
    if (typeId === "dns-zone") return products.createDnsZone(this.rest, accountId, fields);
    if (typeId === "dns-record") {
      return products.createDnsRecord(this.rest, accountId, fields, parentResourceId);
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
      case "load-balancer":
        return [
          {
            label: "Status",
            value: String(f.status ?? ""),
            variant: f.status === "ready" ? "status-healthy" : "status-degraded",
          },
          { label: "Type", value: String(f.type ?? "") },
          { label: "Frontends", value: String(f.frontendCount ?? 0) },
          { label: "Backends", value: String(f.backendCount ?? 0) },
          { label: "IP", value: String(ro.ipv4 || ro.ipv6 || "") },
        ];
      case "flexible-ip":
        return [
          { label: "Address", value: String(f.address ?? "") },
          { label: "State", value: String(f.state ?? "") },
          { label: "Zone", value: String(f.zone ?? "") },
        ];
      case "serverless-container":
      case "serverless-function": {
        const status = String(f.status ?? "");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "ready"
                ? "status-healthy"
                : status === "error"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Scale", value: `${String(f.minScale ?? 0)}-${String(f.maxScale ?? 0)}` },
          { label: "Memory", value: `${String(f.memoryMb ?? 0)} MB` },
          ...(ro.endpoint ? [{ label: "Endpoint", value: String(ro.endpoint) }] : []),
        ];
      }
      case "registry-namespace":
        return [
          { label: "Images", value: String(f.imageCount ?? 0) },
          { label: "Size", value: `${String(f.sizeGb ?? 0)} GB` },
          { label: "Visibility", value: f.isPublic ? "Public" : "Private" },
        ];
      case "dns-zone":
        return [
          { label: "Status", value: String(f.status ?? "") },
          { label: "Nameservers", value: String(f.nameservers ?? "") },
        ];
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchScalewayCostData(
      {
        secretKey: this.secretKey,
        projectId: this.defaultProjectId,
        ...(this.services?.http ? { http: this.services.http } : {}),
      },
      range,
    );
  }

  /**
   * Discover a Cockpit Scaleway-origin data-source URL ("Scaleway metrics" or
   * "Scaleway logs") for a given region. Uses the IAM secret key (NOT the
   * Cockpit query token) to call the Cockpit control-plane API. Result is
   * cached on the client instance per region and type.
   *
   * Returns null when the data source cannot be found or the request fails.
   */
  private async getCockpitDataSource(
    region: string,
    type: "metrics" | "logs" = "metrics",
  ): Promise<string | null> {
    const cacheKey = type === "metrics" ? region : `${type}:${region}`;
    if (this.cockpitDataSourceCache.has(cacheKey)) {
      return this.cockpitDataSourceCache.get(cacheKey)!;
    }
    try {
      const qs = this.defaultProjectId
        ? `project_id=${this.defaultProjectId}&types=${type}&origin=scaleway`
        : `types=${type}&origin=scaleway`;
      const body = await jsonRestFetch<{
        data_sources?: Array<{ url?: string }>;
      }>({
        vendor: "Scaleway",
        url: `https://api.scaleway.com/cockpit/v1/regions/${region}/data-sources?${qs}`,
        errorPath: `/cockpit/v1/regions/${region}/data-sources`,
        headers: { "X-Auth-Token": this.secretKey },
        ...(this.services?.http ? { http: this.services.http } : {}),
      });
      const url = body.data_sources?.[0]?.url ?? null;
      if (url) {
        this.cockpitDataSourceCache.set(cacheKey, url);
        return url;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Run a Prometheus range query against a Cockpit data-source URL.
   * Returns parsed MetricSeries or null on any error / empty result.
   */
  private async queryCockpitRange(
    dataSourceUrl: string,
    promql: string,
    start: number,
    end: number,
    label: string,
    unit: string,
  ): Promise<MetricSeries | null> {
    if (!this.cockpitQueryToken) return null;
    try {
      const body = new URLSearchParams({
        query: promql,
        start: String(start),
        end: String(end),
        step: "60s",
      });
      const json = await jsonRestFetch<{
        status?: string;
        data?: {
          result?: Array<{ values?: Array<[number, string]> }>;
        };
      }>({
        vendor: "Scaleway",
        url: `${dataSourceUrl}/prometheus/api/v1/query_range`,
        errorPath: "/prometheus/api/v1/query_range",
        headers: { Authorization: `Bearer ${this.cockpitQueryToken}` },
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        },
        ...(this.services?.http ? { http: this.services.http } : {}),
      });
      const values = json.data?.result?.[0]?.values ?? [];
      if (values.length === 0) return null;
      return {
        label,
        unit,
        points: values.map(([ts, val]) => ({ timestamp: ts * 1000, value: Number(val) })),
      };
    } catch {
      return null;
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    // Managed Databases carry their own metrics route on the RDB API, read
    // with the IAM secret key, so they chart without a Cockpit token.
    if (resourceTypeId === "rdb-instance") {
      return this.fetchRdbMetrics(resourceId, timeRange);
    }

    // No-op when the Cockpit query token is absent: this is the common case
    // and must remain side-effect-free so existing tests continue to pass.
    if (!this.cockpitQueryToken) return [];

    const now = Date.now();
    const startUnix = Math.floor((timeRange?.startMs ?? now - 3_600_000) / 1000);
    const endUnix = Math.floor((timeRange?.endMs ?? now) / 1000);

    if (resourceTypeId === "instance") {
      // externalId format: {zone}/{serverId}  e.g. "fr-par-1/abc-123"
      const externalId = resourceId.split(":").pop() ?? "";
      const parts = externalId.split("/");
      const zone = parts[0] ?? "";
      const serverId = parts[1] ?? "";
      if (!zone || !serverId) return [];

      // Map zone → region  (fr-par-1 → fr-par)
      const region = zone.replace(/-\d+$/, "");
      const dsUrl = await this.getCockpitDataSource(region);
      if (!dsUrl) return [];

      // Metric/label names verified against Scaleway's own preconfigured Cockpit
      // alert rules: the series carry no `scaleway_` prefix and are keyed by
      // `resource_id` (server UUID), e.g.
      //   rate(instance_server_cpu_seconds_total[1m]) / instance_server_vcpu_count > 0.9
      // Only the CPU pair is confirmed; the network names follow the same
      // convention and fall back gracefully on empty results.
      const queries: Array<{ promql: string; label: string; unit: string }> = [
        {
          promql:
            `100 * rate(instance_server_cpu_seconds_total{resource_id="${serverId}"}[1m])` +
            ` / instance_server_vcpu_count{resource_id="${serverId}"}`,
          label: "CPU Usage",
          unit: "%",
        },
        {
          promql: `rate(instance_server_network_bytes_total{resource_id="${serverId}",direction="rx"}[1m])`,
          label: "Network In",
          unit: "bytes/s",
        },
        {
          promql: `rate(instance_server_network_bytes_total{resource_id="${serverId}",direction="tx"}[1m])`,
          label: "Network Out",
          unit: "bytes/s",
        },
      ];

      const series = await Promise.all(
        queries.map((q) =>
          this.queryCockpitRange(dsUrl, q.promql, startUnix, endUnix, q.label, q.unit),
        ),
      );
      return series.filter((s): s is MetricSeries => s != null);
    }

    if (resourceTypeId === "kapsule-cluster") {
      // externalId format: {region}/{clusterId}
      const externalId = resourceId.split(":").pop() ?? "";
      const [region, clusterId] = externalId.split("/");
      if (!region || !clusterId) return [];

      const dsUrl = await this.getCockpitDataSource(region);
      if (!dsUrl) return [];

      // Kapsule pushes control-plane metrics to the Scaleway Cockpit data
      // source natively (data-plane metrics need a user-installed Helm chart
      // and land in a custom data source, not covered here). Series names
      // and labels verified against Scaleway's preconfigured alert rules:
      // metrics are `kubernetes_cluster_k8s_shoot_*` gauges keyed by
      // `resource_name` (the cluster NAME, not its UUID), so resolve the
      // name first.
      let clusterName: string;
      try {
        const cluster = await this.k8sApi().getCluster({
          region: region as Region,
          clusterId,
        });
        clusterName = cluster.name;
      } catch {
        return [];
      }
      if (!clusterName) return [];
      const byName = `resource_name="${clusterName}"`;
      const apiServer = `component="api-server",${byName}`;

      const queries: Array<{ promql: string; label: string; unit: string }> = [
        {
          promql: `sum(kubernetes_cluster_k8s_shoot_nodes{${byName}})`,
          label: "Nodes",
          unit: "count",
        },
        {
          promql: `sum(kubernetes_cluster_k8s_shoot_nodes_ready{${byName}})`,
          label: "Nodes Ready",
          unit: "count",
        },
        {
          promql: `sum(kubernetes_cluster_k8s_shoot_nodes_pods_usage_total{${byName}})`,
          label: "Pods Running",
          unit: "count",
        },
        {
          promql:
            `100 * max(kubernetes_cluster_k8s_shoot_controlplane_cpu_usage{${apiServer}})` +
            ` / sum(kubernetes_cluster_k8s_shoot_controlplane_cpu_limit{${apiServer}})`,
          label: "API Server CPU",
          unit: "%",
        },
        {
          promql:
            `100 * max(kubernetes_cluster_k8s_shoot_controlplane_memory_usage_bytes{${apiServer}})` +
            ` / sum(kubernetes_cluster_k8s_shoot_controlplane_memory_limit_bytes{${apiServer}})`,
          label: "API Server Memory",
          unit: "%",
        },
      ];

      const series = await Promise.all(
        queries.map((q) =>
          this.queryCockpitRange(dsUrl, q.promql, startUnix, endUnix, q.label, q.unit),
        ),
      );
      return series.filter((s): s is MetricSeries => s != null);
    }

    if (resourceTypeId === "serverless-function" || resourceTypeId === "serverless-container") {
      // externalId format: {region}/{id}
      const externalId = resourceId.split(":").pop() ?? "";
      const [region, id] = externalId.split("/");
      if (!region || !id) return [];

      const dsUrl = await this.getCockpitDataSource(region);
      if (!dsUrl) return [];

      // Metric and label names from Scaleway's documented alert queries
      // (serverless-functions/how-to/configure-alerts-functions and the
      // containers twin): one series per running instance, keyed by
      // `resource_id`. `*_cpu_usage_ratio` is alerted on `> 90`, so it is
      // already a percentage. Averaged across instances like the Cockpit
      // overview dashboard; the instance count is the number of series.
      const prefix =
        resourceTypeId === "serverless-function" ? "serverless_function" : "serverless_container";
      const sel = `{resource_id="${id}"}`;
      const queries: Array<{ promql: string; label: string; unit: string }> = [
        {
          promql: `avg(${prefix}_cpu_usage_ratio${sel})`,
          label: "CPU Usage",
          unit: "%",
        },
        {
          promql: `avg(${prefix}_memory_usage_bytes${sel})`,
          label: "Memory Usage",
          unit: "bytes",
        },
        {
          promql:
            `100 * sum(${prefix}_memory_usage_bytes${sel})` +
            ` / sum(${prefix}_memory_limit_bytes${sel})`,
          label: "Memory Utilization",
          unit: "%",
        },
        {
          promql: `count(${prefix}_memory_usage_bytes${sel})`,
          label: "Instances",
          unit: "count",
        },
      ];

      const series = await Promise.all(
        queries.map((q) =>
          this.queryCockpitRange(dsUrl, q.promql, startUnix, endUnix, q.label, q.unit),
        ),
      );
      return series.filter((s): s is MetricSeries => s != null);
    }

    return [];
  }

  /**
   * Managed Database (PostgreSQL / MySQL) metrics from
   * `GET /rdb/v1/regions/{region}/instances/{id}/metrics`. The response names
   * each series itself (`cpu_usage_percent`, `mem_usage_percent`,
   * `disk_usage_percent`, `total_connections`, ...), with a `node` entry in
   * the metadata on HA and replica setups, so nothing here hard-codes a
   * metric name. Scaleway marks the route deprecated in favour of Cockpit;
   * it still answers, and a removal surfaces as an empty Metrics tab.
   */
  private async fetchRdbMetrics(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const externalId = resourceId.split(":").pop() ?? "";
    const [region, instanceId] = externalId.split("/");
    if (!region || !instanceId) return [];
    const now = Date.now();
    let metrics: Rdbv1.InstanceMetrics;
    try {
      metrics = await this.rdbApi().getInstanceMetrics({
        region: region as Region,
        instanceId,
        startDate: new Date(timeRange?.startMs ?? now - 3_600_000),
        endDate: new Date(timeRange?.endMs ?? now),
      });
    } catch {
      return [];
    }
    const timeseries = metrics.timeseries ?? [];
    const nodes = new Set(timeseries.map((t) => t.metadata?.["node"] ?? ""));
    return timeseries.flatMap((t): MetricSeries[] => {
      const points = (t.points ?? [])
        .filter((p) => p.timestamp != null)
        .map((p) => ({ timestamp: p.timestamp!.getTime(), value: Number(p.value) }))
        .filter((p) => Number.isFinite(p.value));
      if (points.length === 0) return [];
      const node = t.metadata?.["node"];
      const base = rdbMetricLabel(t.name);
      return [
        {
          label: nodes.size > 1 && node ? `${base} (${node})` : base,
          unit: rdbMetricUnit(t.name),
          points,
        },
      ];
    });
  }

  /**
   * Logs tab for serverless functions/containers and Managed Databases, read
   * from the Cockpit "Scaleway logs" Loki data source. Every Scaleway-origin
   * stream carries a `resource_id` label (cockpit/api-cli/querying-logs-with-logcli),
   * so the selector needs no per-product label. The Cockpit token needs the
   * logs query permission on top of metrics.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const empty = (text: string): LogsFetchResult => ({
      text,
      containers: [],
      activeContainer: "",
    });
    if (!SCW_LOG_TYPES.has(typeId)) return empty("");
    if (!this.cockpitQueryToken) {
      return empty(
        "Logs are read from Scaleway Cockpit. Add a Cockpit token with logs query access to this account's credentials to see them here.\n",
      );
    }
    const externalId = resourceId.split(":").pop() ?? "";
    const [region, id] = externalId.split("/");
    if (!region || !id) return empty("");
    const dsUrl = await this.getCockpitDataSource(region, "logs");
    if (!dsUrl) return empty("No Scaleway logs data source found in Cockpit for this region.\n");

    const limit = Math.min(Math.max(params.tailLines ?? 200, 1), 5000);
    const endNs = BigInt(Date.now()) * 1_000_000n;
    // Default Cockpit log retention is 7 days; look back one day for the tail.
    const startNs = endNs - 86_400_000_000_000n;
    const qs = new URLSearchParams({
      query: `{resource_id="${id}"}`,
      limit: String(limit),
      start: startNs.toString(),
      end: endNs.toString(),
      direction: "backward",
    });
    let body: {
      data?: { result?: Array<{ values?: Array<[string, string]> }> };
    };
    try {
      body = await jsonRestFetch({
        vendor: "Scaleway",
        url: `${dsUrl}/loki/api/v1/query_range?${qs.toString()}`,
        errorPath: "/loki/api/v1/query_range",
        headers: { Authorization: `Bearer ${this.cockpitQueryToken}` },
        ...(this.services?.http ? { http: this.services.http } : {}),
      });
    } catch (err) {
      return empty(
        `Could not read logs from Cockpit: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const lines = (body.data?.result ?? [])
      .flatMap((stream) => stream.values ?? [])
      .map(([ns, line]) => ({ ns: BigInt(ns), line }))
      .sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0))
      .slice(-limit)
      .map(({ ns, line }) => `${new Date(Number(ns / 1_000_000n)).toISOString()}  ${line}`);
    return empty(
      lines.length > 0
        ? lines.join("\n") + "\n"
        : "No log lines in Cockpit for the last 24 hours.\n",
    );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    // Instances, Kapsule clusters, serverless functions/containers and RDB
    // instances declare `supportsMetrics`; every range defaults to the last hour. Kapsule additionally merges the
    // Kubernetes peer's cost series.
    return withMetricsCapability(
      this.renderDetailInner(resource),
      this.resourceTypes,
      resource.resourceTypeId,
      3_600_000,
    );
  }

  private renderDetailInner(resource: ResourceInstance): DetailViewSchema {
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

    const detail: DetailViewSchema = {
      title: resource.displayName,
      subtitle: joinSubtitle(resource.resourceTypeId, fields["zone"] ?? fields["region"]),
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

    if (resource.resourceTypeId === "instance") {
      if (state === "running") {
        detail.headerActions = [
          {
            kind: "action",
            label: "Power off",
            action: {
              type: "plugin-action",
              actionId: "poweroff",
              confirmMessage:
                "Power off this instance? Compute billing stops while it is powered off; volumes and reserved IPs keep billing.",
              successMessage: "Power off requested.",
            },
            variant: "danger",
          },
          ...(detail.headerActions ?? []),
        ];
      } else if (state === "stopped" || state === "stopped in place") {
        detail.headerActions = [
          {
            kind: "action",
            label: "Power on",
            action: {
              type: "plugin-action",
              actionId: "poweron",
              successMessage: "Power on requested.",
            },
          },
          ...(detail.headerActions ?? []),
        ];
      }
      if (state === "running") {
        detail.headerActions = [
          {
            kind: "action",
            label: "Reboot",
            action: {
              type: "plugin-action",
              actionId: "reboot",
              confirmMessage: "Reboot this instance?",
              successMessage: "Reboot requested.",
            },
          },
          {
            kind: "action",
            label: "Stop in place",
            action: {
              type: "plugin-action",
              actionId: "stop_in_place",
              confirmMessage:
                "Stop this instance but keep it allocated on its hypervisor? It boots faster afterwards, but compute keeps billing.",
              successMessage: "Stop in place requested.",
            },
          },
          ...(detail.headerActions ?? []),
        ];
      }
      detail.headerActions = [
        {
          kind: "action",
          label: "Back up",
          action: {
            type: "plugin-action",
            actionId: "backup",
            confirmMessage:
              "Snapshot every volume of this instance into a new image? Snapshots are billed per GB until deleted.",
            successMessage: "Backup requested.",
          },
        },
        ...(detail.headerActions ?? []),
      ];
    }

    if (resource.resourceTypeId === "serverless-container") {
      detail.headerActions = [
        {
          kind: "action",
          label: "Redeploy",
          action: {
            type: "plugin-action",
            actionId: "redeploy",
            confirmMessage: "Redeploy this container? Running instances are replaced.",
            successMessage: "Redeploy requested.",
          },
        },
        ...(detail.headerActions ?? []),
      ];
    }

    if (resource.resourceTypeId === "serverless-function") {
      detail.headerActions = [
        {
          kind: "action",
          label: "Deploy",
          action: {
            type: "plugin-action",
            actionId: "deploy",
            successMessage: "Deploy requested.",
          },
        },
        ...(detail.headerActions ?? []),
      ];
    }

    if (resource.resourceTypeId === "object-storage-bucket") {
      const bucketName = String(fields["name"] ?? "");
      if (bucketName) {
        detail.storageBrowser = { bucketName };
        detail.bucketPolicyEditor = {
          bucketArn: `arn:aws:s3:::${bucketName}`,
          bucketName,
          vendor: "scaleway-os",
        };
      }
      delete detail.status;
    }

    if (SCW_LOG_TYPES.has(resource.resourceTypeId)) {
      detail.logs = { defaultTailLines: 200 };
    }

    return detail;
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

  private async listFlexibleIps(accountId: string): Promise<ResourceInstance[]> {
    const api = this.instanceApi();
    const results = await Promise.all(
      (this.zones() as Zone[]).map(async (zone) => {
        try {
          const data = await api.listIps({
            zone,
            ...(this.defaultProjectId ? { project: this.defaultProjectId } : {}),
          });
          return data.ips.map((ip) => this.mapFlexibleIp(ip, zone, accountId));
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  private mapFlexibleIp(
    ip: import("@scaleway/sdk-instance").Instancev1.Ip,
    zone: Zone,
    accountId: string,
  ): ResourceInstance {
    const ipZone = ip.zone ?? zone;
    const address = ip.address || ip.prefix || "";
    const now = new Date().toISOString();
    return {
      id: `${accountId}:flexible-ip:${ipZone}/${ip.id}`,
      pluginId: "scaleway",
      resourceTypeId: "flexible-ip",
      accountId,
      displayName: address || ip.id,
      fields: {
        address,
        zone: ipZone,
        type: ip.type ?? "",
        state: ip.state ?? "",
        serverId: ip.server?.id ?? "",
        reverse: ip.reverse ?? "",
        tags: (ip.tags ?? []).join(", "),
      },
      resolvedOutputs: { address },
      secretStates: [],
      externalId: `${ipZone}/${ip.id}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Edit dispatch. SDK-backed types are handled here; the REST products
   * delegate to `products.ts`. `fields` carries only what the user changed.
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const current = await this.getResource(typeId, resourceId, accountId);
    switch (typeId) {
      case "instance":
        return this.updateInstance(current, fields);
      case "rdb-instance":
        return this.updateRdbInstance(current, fields);
      case "kapsule-cluster":
        return this.updateKapsuleCluster(current, fields);
      case "flexible-ip": {
        const { location, id } = products.splitScoped(current.id);
        const res = await this.instanceApi().updateIp({
          zone: location as Zone,
          ip: id,
          ...(fields["reverse"] !== undefined ? { reverse: fields["reverse"] || null } : {}),
          ...(fields["tags"] !== undefined ? { tags: splitTags(fields["tags"]) } : {}),
        });
        return res.ip ? this.mapFlexibleIp(res.ip, location as Zone, accountId) : current;
      }
      case "load-balancer":
        return products.updateLoadBalancer(this.rest, current, fields);
      case "private-network":
        return products.renamePrivateNetwork(this.rest, current, fields);
      case "serverless-container":
        return products.updateContainer(this.rest, current, fields);
      case "serverless-function":
        return products.updateFunction(this.rest, current, fields);
      case "registry-namespace":
        return products.updateRegistryNamespace(this.rest, current, fields);
      case "dns-record":
        return products.updateDnsRecord(this.rest, current, fields);
      default:
        throw new Error(`Scaleway plugin: updateResource not supported for type "${typeId}"`);
    }
  }

  /**
   * `PATCH /servers/{id}`. Scaleway refuses a commercial-type change unless
   * the Instance is stopped (and not in a placement group); that error is
   * surfaced as-is.
   */
  private async updateInstance(
    current: ResourceInstance,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { location, id } = products.splitScoped(current.id);
    const res = await this.instanceApi().updateServer({
      zone: location as Zone,
      serverId: id,
      ...(fields["name"] ? { name: fields["name"] } : {}),
      ...(fields["commercialType"] ? { commercialType: fields["commercialType"] } : {}),
      ...(fields["protected"] !== undefined ? { protected: fields["protected"] === "true" } : {}),
      ...(fields["tags"] !== undefined ? { tags: splitTags(fields["tags"]) } : {}),
    });
    return res.server ? this.mapInstance(res.server, location as Zone, current.accountId) : current;
  }

  /**
   * Rename via `updateInstance`; node type and volume size via `upgrade`,
   * which takes exactly one change per call, so each runs separately and
   * failures are reported together.
   */
  private async updateRdbInstance(
    current: ResourceInstance,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { location, id } = products.splitScoped(current.id);
    const region = location as Region;
    const api = this.rdbApi();
    const failures: string[] = [];
    let latest: import("@scaleway/sdk-rdb").Rdbv1.Instance | undefined;
    const attempt = async (label: string, fn: () => Promise<typeof latest>) => {
      try {
        latest = await fn();
      } catch (e) {
        failures.push(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const name = fields["name"];
    if (name) {
      await attempt("rename", () => api.updateInstance({ region, instanceId: id, name }));
    }
    const nodeType = fields["nodeType"];
    if (nodeType) {
      await attempt("node type upgrade", () =>
        api.upgradeInstance({ region, instanceId: id, nodeType }),
      );
    }
    if (fields["volumeSizeGb"]) {
      await attempt("volume resize", () =>
        api.upgradeInstance({
          region,
          instanceId: id,
          volumeSize: Number(fields["volumeSizeGb"]) * 1_000_000_000,
        }),
      );
    }
    if (failures.length > 0) throw new Error(`Scaleway RDB update: ${failures.join("; ")}`);
    return latest ? this.mapManagedDatabase(latest, region, current.accountId) : current;
  }

  /**
   * Version → `upgradeCluster` with `upgrade_pools: true` (control plane and
   * every pool). Node count → resize the first pool so the total matches.
   */
  private async updateKapsuleCluster(
    current: ResourceInstance,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { location, id } = products.splitScoped(current.id);
    const region = location as Region;
    const api = this.k8sApi();
    const failures: string[] = [];
    if (fields["version"]) {
      try {
        await api.upgradeCluster({
          region,
          clusterId: id,
          version: fields["version"],
          upgradePools: true,
        });
      } catch (e) {
        failures.push(`upgrade failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (fields["nodeCount"]) {
      try {
        const pools = (await api.listPools({ region, clusterId: id })).pools;
        const first = pools[0];
        if (!first) throw new Error("the cluster has no node pool");
        const others = pools.slice(1).reduce((sum, p) => sum + p.size, 0);
        const size = Number(fields["nodeCount"]) - others;
        if (!Number.isFinite(size) || size < 0) {
          throw new Error(`the other pools already hold ${others} nodes`);
        }
        await api.updatePool({ region, poolId: first.id, size });
      } catch (e) {
        failures.push(`resize failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures.length > 0) throw new Error(`Scaleway Kapsule update: ${failures.join("; ")}`);
    return {
      ...current,
      fields: {
        ...current.fields,
        ...(fields["version"] ? { version: fields["version"], status: "updating" } : {}),
        ...(fields["nodeCount"] ? { nodeCount: Number(fields["nodeCount"]) } : {}),
      },
      updatedAt: new Date().toISOString(),
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
        // Zone may not be available: skip silently
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
        protected: s.protected ?? false,
        securityGroupId: s.securityGroup?.id ?? "",
        tags: (s.tags ?? []).join(", "),
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

  /**
   * RDB create form. Engines and node types come from the API
   * (`/database-engines`, `/node-types`) so the form never offers a retired
   * version or an out-of-stock node type; both are read for fr-par, the
   * region with the widest catalogue. The static lists are the fallback.
   */
  private async getRdbCreateConfig(): Promise<CreateResourceConfig> {
    const region = ScalewayClient.DEFAULT_REGION;
    const api = this.rdbApi();
    let engines: Array<{ id: string; label: string }> = [];
    try {
      const data = await api.listDatabaseEngines({ region });
      for (const engine of data.engines) {
        for (const v of engine.versions) {
          if (v.disabled) continue;
          const id = `${engine.name}-${v.version}`;
          engines.push({ id, label: `${engine.name} ${v.version}${v.beta ? " (beta)" : ""}` });
        }
      }
    } catch {
      engines = [];
    }
    if (engines.length === 0) {
      engines = [
        { id: "PostgreSQL-16", label: "PostgreSQL 16" },
        { id: "PostgreSQL-15", label: "PostgreSQL 15" },
        { id: "MySQL-8", label: "MySQL 8" },
      ];
    }
    let nodeTypes: SizeOption[] = [];
    try {
      const data = await api.listNodeTypes({ region, includeDisabledTypes: false });
      nodeTypes = data.nodeTypes
        .filter((n) => !n.disabled && n.stockStatus !== "out_of_stock")
        .map((n) => ({
          id: n.name,
          label: n.name,
          vcpus: n.vcpus,
          memoryMb: Math.round(n.memory / (1024 * 1024)),
          diskGb: 0,
          category: n.generation || "Other",
        }));
    } catch {
      nodeTypes = [];
    }
    const defaultEngine =
      engines.find((e) => e.id.startsWith("PostgreSQL") && !e.label.includes("beta"))?.id ??
      engines[0]!.id;
    const defaultNodeType =
      nodeTypes.find((n) => n.id.toUpperCase() === "DB-DEV-S")?.id ?? nodeTypes[0]?.id;
    return {
      fields: [
        { key: "name", label: "Instance Name", kind: "text", required: true },
        {
          key: "engine",
          label: "Engine",
          kind: "select",
          required: true,
          options: engines,
          defaultValue: defaultEngine,
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: this.regionOptions(),
          defaultValue: "fr-par",
        },
        nodeTypes.length > 0
          ? {
              key: "nodeType",
              label: "Node Type",
              kind: "size-picker",
              required: true,
              sizes: nodeTypes,
              ...(defaultNodeType ? { defaultValue: defaultNodeType } : {}),
              description: "Availability varies by region; listed for fr-par.",
            }
          : {
              key: "nodeType",
              label: "Node Type",
              kind: "text",
              required: true,
              defaultValue: "DB-DEV-S",
              description: "Node type identifier, e.g. DB-DEV-S, db-pro2-xxs (varies by region).",
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
        { key: "password", label: "Admin Password", kind: "password", required: true },
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

    // Authorize the SSH key (agent flow routes it via `sshPublicKey`).
    // createServer has no SSH-key parameter; the supported mechanism is the
    // `cloud-init` user-data key, which cloud-init consumes on first boot,
    // so it must be set before the poweron below. Failing silently would
    // produce an instance the caller can never SSH into, so surface it.
    const sshPublicKey = fields["sshPublicKey"]?.trim();
    if (sshPublicKey) {
      const cloudInit = `#cloud-config\nssh_authorized_keys:\n  - ${sshPublicKey}\n`;
      try {
        await api.setServerUserData({
          zone,
          serverId: server.id,
          key: "cloud-init",
          content: cloudInit,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Scaleway plugin: instance ${server.id} was created but attaching the SSH key failed: ${message}`,
          { cause: err },
        );
      }
    }

    // Boot the instance after creation
    try {
      await api.serverAction({ zone, serverId: server.id, action: "poweron" });
    } catch {
      // Non-fatal: instance was created even if boot fails
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
        return Promise.all(
          data.clusters.map(async (c) => {
            let firstPool: import("@scaleway/sdk-k8s").K8Sv1.Pool | undefined;
            let totalNodes = 0;
            let poolCount = 0;
            try {
              const poolsResp = await api.listPools({ region, clusterId: c.id });
              firstPool = poolsResp.pools[0];
              poolCount = poolsResp.pools.length;
              for (const p of poolsResp.pools) totalNodes += p.size;
            } catch {
              // Skip pools we can't list
            }
            return this.mapKapsuleCluster(c, region, accountId, firstPool, totalNodes, poolCount);
          }),
        );
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
    firstPool?: import("@scaleway/sdk-k8s").K8Sv1.Pool,
    nodeCount = 0,
    poolCount = 0,
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
        nodeType: firstPool?.nodeType ?? "",
        nodeCount,
        diskSizeGb: firstPool?.rootVolumeSize
          ? Math.round(firstPool.rootVolumeSize / (1024 * 1024 * 1024))
          : 0,
        status: c.status ?? "",
        upgradeAvailable: c.upgradeAvailable ?? false,
        poolCount,
        cni: c.cni ?? "",
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
    // Working default mirroring rdb's "DB-DEV-S" and OVH's "b3-8": DEV1-M is
    // the cheapest widely-available type and the create-config fallback size.
    const nodeType = fields["nodeType"] ?? "DEV1-M";
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
          nodeType,
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
        nodeType,
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
        isHaCluster: db.isHaCluster ?? false,
        volumeType: db.volume?.type ?? "",
        volumeSizeGb: db.volume?.size ? Math.round(db.volume.size / 1_000_000_000) : 0,
        backupsEnabled: db.backupSchedule ? !db.backupSchedule.disabled : false,
        backupRetentionDays:
          db.backupSchedule && !db.backupSchedule.disabled ? db.backupSchedule.retention : 0,
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
    const regions = Object.keys(ScalewayClient.REGION_INFO);
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
          this.objectStorageBucketRegions.set(b.name, region);
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
        // Region may not have Object Storage or credentials may lack access: skip
      }
    }
    return results;
  }

  // ── Object Storage (S3-compatible) storage browser ──────────────────────

  private async getObjectStorageConfig(bucket: string): Promise<S3StorageConfig> {
    this.assertS3Credentials();
    let region = this.objectStorageBucketRegions.get(bucket);
    if (!region) {
      // Cold cache: probe each region's S3 endpoint until one acknowledges
      // the bucket (HEAD against `{host}/{bucket}` returns 200 for hits,
      // 404/301 otherwise). Stops at the first match.
      for (const candidate of Object.keys(ScalewayClient.REGION_INFO)) {
        try {
          const res = await signedS3Fetch({
            accessKey: this.accessKey,
            secretKey: this.secretKey,
            region: candidate,
            method: "HEAD",
            url: `https://s3.${candidate}.scw.cloud/${bucket}`,
          });
          if (res.ok || res.status === 403) {
            // 403 still confirms the bucket exists in this region; ACLs are a
            // separate question that the storage verbs will surface later.
            region = candidate;
            break;
          }
        } catch {
          // Network or signing failure: try the next region.
        }
      }
      if (!region) {
        throw new Error(
          `Scaleway plugin: could not locate Object Storage bucket "${bucket}" in any known region. ` +
            "Verify the bucket exists and the account credentials have read access.",
        );
      }
      this.objectStorageBucketRegions.set(bucket, region);
    }
    return {
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      region,
      buildUrl: pathStyleUrl((r) => `s3.${r}.scw.cloud`)(region),
    };
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const cfg = await this.getObjectStorageConfig(bucket);
    return listS3Objects(cfg, bucket, prefix);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const cfg = await this.getObjectStorageConfig(bucket);
    return uploadS3Object(cfg, bucket, key, file);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const cfg = await this.getObjectStorageConfig(bucket);
    return makeS3Folder(cfg, bucket, key);
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const cfg = await this.getObjectStorageConfig(bucket);
    return deleteS3Object(cfg, bucket, key);
  }

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    if (typeId !== "object-storage-bucket") {
      throw new Error(`Scaleway plugin: getManifest not supported for type "${typeId}"`);
    }
    // externalId is `{region}/{bucketName}`: peel the bucket name off.
    const externalId = parts.slice(2).join(":");
    const bucket = externalId.includes("/") ? externalId.split("/").slice(1).join("/") : externalId;
    const cfg = await this.getObjectStorageConfig(bucket);
    const raw = await getS3BucketPolicy(cfg, bucket);
    if (!raw) return "";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    if (typeId !== "object-storage-bucket") {
      throw new Error(`Scaleway plugin: applyManifest not supported for type "${typeId}"`);
    }
    const externalId = parts.slice(2).join(":");
    const bucket = externalId.includes("/") ? externalId.split("/").slice(1).join("/") : externalId;
    const cfg = await this.getObjectStorageConfig(bucket);
    return putS3BucketPolicy(cfg, bucket, manifest);
  }
}

/** Instance actions `invokeAction` accepts (`POST /servers/{id}/action`). */
const INSTANCE_ACTIONS = new Set(["poweron", "poweroff", "reboot", "stop_in_place", "backup"]);

/** Types whose outputs are all precomputed in `resolvedOutputs` by the lister. */
const SIMPLE_OUTPUT_TYPES = new Set([
  "flexible-ip",
  "load-balancer",
  "private-network",
  "serverless-container",
  "serverless-function",
  "registry-namespace",
  "dns-zone",
]);

function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Types with a Cockpit-backed Logs tab (see `getLogs`). */
const SCW_LOG_TYPES = new Set(["serverless-function", "serverless-container", "rdb-instance"]);

/**
 * Display label for an RDB metric name. Names outside the known set fall back
 * to sentence case without the unit suffix.
 */
function rdbMetricLabel(name: string): string {
  const known: Record<string, string> = {
    cpu_usage_percent: "CPU Usage",
    mem_usage_percent: "Memory Usage",
    disk_usage_percent: "Disk Usage",
    total_connections: "Connections",
    total_connections_percent: "Connection Usage",
  };
  const label = known[name];
  if (label) return label;
  const words = name.replace(/_(percent|bytes)$/, "").split("_");
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function rdbMetricUnit(name: string): string {
  if (name.endsWith("_percent")) return "%";
  if (name.endsWith("_bytes")) return "bytes";
  return "count";
}
