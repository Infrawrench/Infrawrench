import type { S3Config } from "./s3.js";
import { S3Error, transport } from "./s3.js";
import { signV4 } from "./sigv4.js";

/**
 * MinIO's admin API (`/minio/admin/{v4|v3}/...`), the one `mc admin` and
 * madmin-go speak. Requests are SigV4-signed exactly like S3 (service "s3")
 * with the same access key; it needs a key whose policy allows
 * `admin:ServerInfo` (the root user has it). madmin-go now calls `/v4` and
 * falls back to `/v3` on 426 Upgrade Required; community MinIO serves `/v3`,
 * AIStor `/v4`. Shapes from madmin-go `info-commands.go` (2026-10):
 * `InfoMessage` (`mode`, `deploymentID`, `buckets.count`, `objects.count`,
 * `usage.size`, `servers[]` with `state`, `endpoint`, `uptime`, `version`,
 * `drives[]`) and `DataUsageInfo` (`objectsCount`, `objectsTotalSize`,
 * `bucketsCount`, `bucketsUsageInfo{name: {size, objectsCount, versionsCount}}`,
 * `capacity`, `freeCapacity`, `usedCapacity`).
 */

export interface MinioDrive {
  endpoint?: string;
  path?: string;
  state?: string;
  healing?: boolean;
  totalspace?: number;
  usedspace?: number;
  availspace?: number;
}

export interface MinioServer {
  state?: string;
  endpoint?: string;
  uptime?: number;
  version?: string;
  edition?: string;
  drives?: MinioDrive[];
  poolNumber?: number;
}

export interface MinioInfo {
  mode?: string;
  region?: string;
  deploymentID?: string;
  buckets?: { count?: number };
  objects?: { count?: number };
  versions?: { count?: number };
  usage?: { size?: number };
  backend?: Record<string, unknown>;
  servers?: MinioServer[];
}

export interface MinioDataUsage {
  lastUpdate?: string;
  objectsCount?: number;
  objectsTotalSize?: number;
  bucketsCount?: number;
  capacity?: number;
  freeCapacity?: number;
  usedCapacity?: number;
  bucketsUsageInfo?: Record<
    string,
    { size?: number; objectsCount?: number; versionsCount?: number; deleteMarkersCount?: number }
  >;
}

export class MinioAdmin {
  private version: Promise<string> | undefined;

  constructor(private readonly cfg: S3Config) {}

  private async raw(
    prefix: string,
    path: string,
    query: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    const qs = new URLSearchParams(query).toString();
    const url = `${this.cfg.endpoint.replace(/\/+$/, "")}/minio/admin/${prefix}${path}${qs ? `?${qs}` : ""}`;
    const headers = await signV4({
      method: "GET",
      url,
      headers: {},
      accessKey: this.cfg.accessKey,
      secretKey: this.cfg.secretKey,
      region: this.cfg.region,
      service: "s3",
      ...(this.cfg.sessionToken ? { sessionToken: this.cfg.sessionToken } : {}),
    });
    return transport(this.cfg, { url, method: "GET", headers });
  }

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    this.version ??= (async () => {
      const v4 = await this.raw("v4", "/info");
      return v4.status === 426 || v4.status === 404 || v4.status === 400 ? "v3" : "v4";
    })();
    const res = await this.raw(await this.version, path, query);
    if (res.status < 200 || res.status >= 300) {
      let message = res.body.slice(0, 200);
      try {
        message = (JSON.parse(res.body) as { Message?: string }).Message ?? message;
      } catch {
        // XML or text
      }
      throw new S3Error(
        res.status,
        "AdminAPI",
        `MinIO admin ${path} failed (${res.status}): ${message}`,
      );
    }
    return JSON.parse(res.body) as T;
  }

  info(): Promise<MinioInfo> {
    return this.get<MinioInfo>("/info");
  }

  dataUsage(): Promise<MinioDataUsage> {
    return this.get<MinioDataUsage>("/datausageinfo", { capacity: "true" });
  }
}

/** Server vendor from the S3 `Server` response header. */
export function detectServer(serverHeader: string | undefined): string {
  const h = (serverHeader ?? "").trim();
  if (/minio/i.test(h)) return "MinIO";
  if (/ceph|rgw/i.test(h)) return "Ceph RGW";
  if (/garage/i.test(h)) return "Garage";
  if (/seaweed/i.test(h)) return "SeaweedFS";
  if (/amazons3/i.test(h)) return "Amazon S3";
  return h || "Unknown";
}
