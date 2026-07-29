import type { CredentialExport } from "@infrawrench/plugin-base";
import { buildConnectionUrl, engineInfoFromVersion } from "./cloudsql-engine.js";
import { formatGcpError } from "./utils.js";
import type { GcpClientContext } from "./shared.js";

export async function resolveOutput(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  outputKey: string,
  accountId: string,
): Promise<string> {
  const p = ctx.project;

  if (typeId === "gcp-project") {
    // The token comes from the account's own credentials — this is what lets
    // an Infrafile authenticate gcloud (CLOUDSDK_AUTH_ACCESS_TOKEN) and
    // Artifact Registry (`docker login -u oauth2accesstoken`) without the
    // operator re-supplying the service-account key.
    if (outputKey === "accessToken") return ctx.token();
    if (outputKey === "projectId") {
      const resource = await ctx.getResource(typeId, resourceId, accountId);
      return String(resource.externalId ?? resource.fields["projectId"] ?? "");
    }
  }

  if (typeId === "gke-cluster" && outputKey === "kubeconfig") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const cluster = await ctx.get<Record<string, unknown>>(
      `https://container.googleapis.com/v1/projects/${p}/locations/${String(resource.fields["location"])}/clusters/${resource.externalId}`,
    );
    // The endpoint comes from the API response, not from resolvedOutputs
    const endpoint = (cluster["endpoint"] as string) ?? "";
    const caCert =
      ((cluster["masterAuth"] as Record<string, unknown> | undefined)?.[
        "clusterCaCertificate"
      ] as string) ?? "";
    const tok = await ctx.token();
    const kubeconfig = [
      "apiVersion: v1",
      "kind: Config",
      `clusters:`,
      `- cluster:`,
      `    server: https://${endpoint}`,
      `    certificate-authority-data: ${caCert}`,
      `  name: ${String(cluster["name"])}`,
      `contexts:`,
      `- context:`,
      `    cluster: ${String(cluster["name"])}`,
      `    user: ${String(cluster["name"])}`,
      `  name: ${String(cluster["name"])}`,
      `current-context: ${String(cluster["name"])}`,
      `users:`,
      `- name: ${String(cluster["name"])}`,
      `  user:`,
      `    token: ${tok}`,
    ].join("\n");
    return kubeconfig;
  }

  if (typeId === "memorystore-redis") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    if (outputKey === "authString") {
      const name = resource.externalId ?? "";
      const data = await ctx.get<Record<string, unknown>>(
        `https://redis.googleapis.com/v1/${name}/authString`,
      );
      return (data["authString"] as string) ?? "";
    }
    if (outputKey === "host")
      return String(resource.fields["host"] ?? resource.resolvedOutputs["host"] ?? "");
    if (outputKey === "port")
      return String(resource.fields["port"] ?? resource.resolvedOutputs["port"] ?? "6379");
    if (outputKey === "redisUrl") {
      const host = String(resource.fields["host"] ?? resource.resolvedOutputs["host"] ?? "");
      const port = String(resource.fields["port"] ?? resource.resolvedOutputs["port"] ?? "6379");
      const name = resource.externalId ?? "";
      try {
        const data = await ctx.get<Record<string, unknown>>(
          `https://redis.googleapis.com/v1/${name}/authString`,
        );
        const auth = (data["authString"] as string) ?? "";
        return auth ? `redis://:${auth}@${host}:${port}` : `redis://${host}:${port}`;
      } catch {
        return `redis://${host}:${port}`;
      }
    }
  }

  if (typeId === "cloudsql-instance") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const databaseVersion = String(resource.fields["databaseVersion"] ?? "");
    const engine = engineInfoFromVersion(databaseVersion);
    const ipAddress = String(resource.resolvedOutputs["ipAddress"] ?? "");
    const persistedPassword =
      (await ctx.hostServices?.secrets?.getPlaintext(resourceId, "rootPassword")) ?? null;
    const password = persistedPassword ?? String(resource.fields["rootPassword"] ?? ""); // legacy fallback for instances created before the secretStates migration
    if (outputKey === "connectionName")
      return String(
        resource.fields["connectionName"] ?? resource.resolvedOutputs["connectionName"] ?? "",
      );
    if (outputKey === "ipAddress") return ipAddress;
    if (outputKey === "username") return engine.username;
    if (outputKey === "port") return engine.port;
    if (outputKey === "password") return password;
    if (outputKey === "connectionUrl")
      return buildConnectionUrl(databaseVersion, ipAddress, password);
  }

  if (typeId === "alloydb-instance") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const ipAddress = String(resource.resolvedOutputs["ipAddress"] ?? "");
    // Password lives on the parent cluster (AlloyDB's initialUser is set
    // at cluster creation). Derive the cluster's resourceId from the
    // instance's external name and look the secret up there.
    const clusterFullName = (resource.externalId ?? "").split("/instances/")[0] ?? "";
    const clusterResourceId = clusterFullName
      ? ctx.id(accountId, "alloydb-cluster", clusterFullName)
      : "";
    const password = clusterResourceId
      ? ((await ctx.hostServices?.secrets?.getPlaintext(clusterResourceId, "rootPassword")) ?? "")
      : "";
    if (outputKey === "ipAddress") return ipAddress;
    if (outputKey === "username") return "postgres";
    if (outputKey === "port") return "5432";
    if (outputKey === "password") return password;
    if (outputKey === "connectionUrl") {
      if (!ipAddress) return "";
      const pw = encodeURIComponent(password);
      return `postgres://postgres:${pw}@${ipAddress}:5432/postgres`;
    }
  }

  if (typeId === "ssl-certificate") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const fields = resource.fields;
    if (outputKey === "dnsRecords") {
      const domains = String(fields["domains"] ?? "");
      if (!domains) return "";
      const domainList = domains
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      const records = domainList.map((domain) => {
        const recordName = `_acme-challenge.${domain}.`;
        const recordValue = `${resource.externalId || resource.displayName}.${p}.dscvr.cloud.goog.`;
        return `CNAME ${recordName} -> ${recordValue}`;
      });
      return records.join("\n");
    }
    if (outputKey === "domains") return String(fields["domains"] ?? "");
  }

  if (typeId === "gcs-bucket") {
    if (outputKey === "bucketName") {
      const resource = await ctx.getResource(typeId, resourceId, accountId);
      return String(resource.fields["name"] ?? resource.displayName);
    }
    if (outputKey === "endpoint") {
      const resource = await ctx.getResource(typeId, resourceId, accountId);
      return `https://storage.googleapis.com/${String(resource.fields["name"] ?? resource.displayName)}`;
    }
    if (outputKey === "serviceAccountKey") {
      const tok = await ctx.token();
      const email = ctx.serviceAccountKey.client_email;
      const res = await fetch(
        `https://iam.googleapis.com/v1/projects/${ctx.project}/serviceAccounts/${encodeURIComponent(email)}/keys`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tok}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ keyAlgorithm: "KEY_ALG_RSA_2048" }),
        },
      );
      if (!res.ok) throw new Error(`IAM API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { privateKeyData: string };
      // privateKeyData is base64-encoded JSON — decode it
      return atob(data.privateKeyData);
    }
  }

  if (typeId === "cloud-dns-zone" && outputKey === "nameservers") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.fields["nameservers"] ?? "");
  }

  if (typeId === "secret-manager-secret" && outputKey === "latestVersion") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const secretName = resource.externalId ?? "";
    const data = await ctx.get<Record<string, unknown>>(
      `https://secretmanager.googleapis.com/v1/${secretName}/versions/latest:access`,
    );
    const payload = data["payload"] as Record<string, unknown> | undefined;
    const b64 = (payload?.["data"] as string) ?? "";
    return atob(b64);
  }

  if (typeId === "static-ip" && outputKey === "address") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.fields["address"] ?? resource.resolvedOutputs["address"] ?? "");
  }

  if (typeId === "forwarding-rule" && outputKey === "IPAddress") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.fields["IPAddress"] ?? resource.resolvedOutputs["IPAddress"] ?? "");
  }

  if (typeId === "filestore-instance" && outputKey === "ipAddress") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.fields["ipAddress"] ?? resource.resolvedOutputs["ipAddress"] ?? "");
  }

  if (typeId === "memorystore-memcached" && outputKey === "discoveryEndpoint") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(
      resource.fields["discoveryEndpoint"] ?? resource.resolvedOutputs["discoveryEndpoint"] ?? "",
    );
  }

  if (typeId === "composer-environment" && outputKey === "airflowUri") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.fields["airflowUri"] ?? resource.resolvedOutputs["airflowUri"] ?? "");
  }

  if (typeId === "app-engine-service" && outputKey === "url") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.resolvedOutputs["url"] ?? "");
  }

  if (typeId === "cloud-function" && outputKey === "url") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.resolvedOutputs["url"] ?? "");
  }

  if (typeId === "vpc-network") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.resolvedOutputs[outputKey] ?? "");
  }

  if (typeId === "cloud-router") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.resolvedOutputs[outputKey] ?? "");
  }

  if (typeId === "instance-template") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.resolvedOutputs[outputKey] ?? "");
  }

  if ((typeId === "health-check" || typeId === "backend-service") && outputKey === "selfLink") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const cached = String(resource.resolvedOutputs["selfLink"] ?? "");
    if (cached) return cached;
    const name = String(resource.fields["name"] ?? resource.externalId ?? "");
    const segment = typeId === "health-check" ? "healthChecks" : "backendServices";
    return `https://www.googleapis.com/compute/v1/projects/${p}/global/${segment}/${name}`;
  }

  if (typeId === "gcp-service-account" && outputKey === "key") {
    const exp = await exportCredential(ctx, typeId, resourceId, accountId, "json-key");
    return exp.content;
  }

  if (typeId === "firewall-rule" && outputKey === "name") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return resource.externalId ?? String(resource.fields["name"] ?? "");
  }

  if (typeId === "pubsub-topic" && (outputKey === "topicName" || outputKey === "name")) {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    // Full resource name (projects/X/topics/Y) — what Eventarc and most APIs expect.
    return resource.externalId ?? String(resource.fields["name"] ?? "");
  }

  if (typeId === "gcp-service-account" && outputKey === "email") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    return String(resource.fields["email"] ?? "");
  }

  throw new Error(`GCP plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
}

export async function exportCredential(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  formatId: string,
): Promise<CredentialExport> {
  if (typeId === "gcp-service-account") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const email = String(resource.externalId ?? resource.fields["email"] ?? "");
    if (!email) throw new Error("Cannot determine service account email");
    const privateKeyType =
      formatId === "p12-key" ? "TYPE_PKCS12_FILE" : "TYPE_GOOGLE_CREDENTIALS_FILE";
    const tok = await ctx.token();
    const res = await fetch(
      `https://iam.googleapis.com/v1/projects/${ctx.project}/serviceAccounts/${encodeURIComponent(email)}/keys`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          keyAlgorithm: "KEY_ALG_RSA_2048",
          privateKeyType,
        }),
      },
    );
    if (!res.ok) throw new Error(await formatGcpError("Create service account key", res));
    const data = (await res.json()) as {
      name?: string;
      privateKeyData?: string;
      validAfterTime?: string;
      validBeforeTime?: string;
    };
    const privateKeyData = data.privateKeyData ?? "";
    if (!privateKeyData) throw new Error("GCP returned an empty key");
    // The `name` field looks like "projects/p/serviceAccounts/email/keys/<keyId>".
    const keyId = (data.name ?? "").split("/").pop() ?? "";
    const baseName = email.split("@")[0] ?? "service-account";
    if (formatId === "p12-key") {
      return {
        content: privateKeyData,
        filename: `${baseName}.p12`,
        mimeType: "application/x-pkcs12",
        fields: [
          { label: "Key ID", value: keyId },
          { label: "Password", value: "notasecret", hint: "Fixed by GCP" },
        ],
        warning:
          "Save this now. The PKCS#12 bundle cannot be re-downloaded from GCP once this dialog closes.",
      };
    }
    // JSON key: privateKeyData is base64 of the JSON file.
    const jsonContent = atob(privateKeyData);
    return {
      content: jsonContent,
      filename: `${baseName}.json`,
      mimeType: "application/json",
      fields: [{ label: "Key ID", value: keyId }],
      warning:
        "Save this now. GCP keeps the public key but the private key portion cannot be re-downloaded.",
    };
  }
  throw new Error(
    `GCP plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
  );
}
