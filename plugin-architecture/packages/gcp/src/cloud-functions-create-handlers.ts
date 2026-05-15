import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { GCP_REGIONS } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

/** CRC-32 (ISO 3309) for ZIP file construction */
function crc32cf(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a (stored, uncompressed) ZIP archive from a list of named files. */
function buildZipArchive(files: { name: string; content: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const nameBytes = encoder.encode(f.name);
    const data = encoder.encode(f.content);
    return { nameBytes, data, crc: crc32cf(data) };
  });

  let totalLocal = 0;
  for (const e of entries) totalLocal += 30 + e.nameBytes.length + e.data.length;
  let totalCentral = 0;
  for (const e of entries) totalCentral += 46 + e.nameBytes.length;

  const out = new Uint8Array(totalLocal + totalCentral + 22);
  const offsets: number[] = [];
  let p = 0;

  for (const e of entries) {
    offsets.push(p);
    const ldv = new DataView(out.buffer, p, 30);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0, true);
    ldv.setUint16(8, 0, true);
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0, true);
    ldv.setUint32(14, e.crc, true);
    ldv.setUint32(18, e.data.length, true);
    ldv.setUint32(22, e.data.length, true);
    ldv.setUint16(26, e.nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    out.set(e.nameBytes, p + 30);
    out.set(e.data, p + 30 + e.nameBytes.length);
    p += 30 + e.nameBytes.length + e.data.length;
  }

  const centralStart = p;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const cdv = new DataView(out.buffer, p, 46);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, e.crc, true);
    cdv.setUint32(20, e.data.length, true);
    cdv.setUint32(24, e.data.length, true);
    cdv.setUint16(28, e.nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offsets[i]!, true);
    out.set(e.nameBytes, p + 46);
    p += 46 + e.nameBytes.length;
  }

  const ev = new DataView(out.buffer, p, 22);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, p - centralStart, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);

  return out;
}

export const cloudFunctionsCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "cloud-function": async (ctx, parentResourceId) => {
    const nodeDefault = `const functions = require('@google-cloud/functions-framework');\n\nfunctions.http('helloHttp', (req, res) => {\n  res.send('Hello from Cloud Functions!');\n});\n`;
    const pythonDefault = `import functions_framework\n\n@functions_framework.http\ndef helloHttp(request):\n    return "Hello from Cloud Functions!"\n`;
    const goDefault = `package function\n\nimport (\n\t"fmt"\n\t"net/http"\n\n\t"github.com/GoogleCloudPlatform/functions-framework-go/functions"\n)\n\nfunc init() {\n\tfunctions.HTTP("helloHttp", helloHttp)\n}\n\nfunc helloHttp(w http.ResponseWriter, r *http.Request) {\n\tfmt.Fprint(w, "Hello from Cloud Functions!")\n}\n`;
    const javaDefault = `package com.example;\n\nimport com.google.cloud.functions.HttpFunction;\nimport com.google.cloud.functions.HttpRequest;\nimport com.google.cloud.functions.HttpResponse;\nimport java.io.BufferedWriter;\n\npublic class HelloHttp implements HttpFunction {\n  @Override\n  public void service(HttpRequest request, HttpResponse response) throws Exception {\n    BufferedWriter writer = response.getWriter();\n    writer.write("Hello from Cloud Functions!");\n  }\n}\n`;
    return {
      fields: [
        { key: "name", label: "Function Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "language",
          label: "Language",
          kind: "select",
          required: true,
          options: [
            { id: "nodejs", label: "Node.js" },
            { id: "python", label: "Python" },
            { id: "go", label: "Go" },
            { id: "java", label: "Java" },
          ],
          defaultValue: "nodejs",
        },
        {
          key: "runtime_nodejs",
          label: "Runtime",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "nodejs" },
          options: [
            { id: "nodejs24", label: "Node.js 24" },
            { id: "nodejs22", label: "Node.js 22" },
            { id: "nodejs20", label: "Node.js 20" },
          ],
          defaultValue: "nodejs24",
        },
        {
          key: "runtime_python",
          label: "Runtime",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "python" },
          options: [
            { id: "python314", label: "Python 3.14" },
            { id: "python313", label: "Python 3.13" },
            { id: "python312", label: "Python 3.12" },
            { id: "python311", label: "Python 3.11" },
            { id: "python310", label: "Python 3.10" },
          ],
          defaultValue: "python314",
        },
        {
          key: "runtime_go",
          label: "Runtime",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "go" },
          options: [
            { id: "go124", label: "Go 1.24" },
            { id: "go123", label: "Go 1.23" },
          ],
          defaultValue: "go124",
        },
        {
          key: "runtime_java",
          label: "Runtime",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "java" },
          options: [
            { id: "java25", label: "Java 25" },
            { id: "java21", label: "Java 21" },
            { id: "java17", label: "Java 17" },
          ],
          defaultValue: "java25",
        },
        {
          key: "entryPoint",
          label: "Entry Point",
          kind: "text",
          required: true,
          defaultValue: "helloHttp",
          description:
            "The exported function name (Node.js/Python/Go) or the fully-qualified class for Java that handles requests",
        },
        {
          key: "code_nodejs",
          label: "Source Code (index.js)",
          kind: "code",
          codeLanguage: "javascript",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "nodejs" },
          defaultValue: nodeDefault,
          description:
            "Saved as index.js. A package.json depending on @google-cloud/functions-framework is added automatically.",
        },
        {
          key: "code_python",
          label: "Source Code (main.py)",
          kind: "code",
          codeLanguage: "python",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "python" },
          defaultValue: pythonDefault,
          description:
            "Saved as main.py. A requirements.txt with functions-framework is added automatically.",
        },
        {
          key: "code_go",
          label: "Source Code (function.go)",
          kind: "code",
          codeLanguage: "go",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "go" },
          defaultValue: goDefault,
          description: "Saved as function.go alongside an auto-generated go.mod.",
        },
        {
          key: "code_java",
          label: "Source Code (HelloHttp.java)",
          kind: "code",
          codeLanguage: "java",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "java" },
          defaultValue: javaDefault,
          description:
            "Saved under src/main/java alongside an auto-generated pom.xml that depends on functions-framework-api.",
        },
        {
          key: "availableMemory",
          label: "Memory",
          kind: "select",
          required: false,
          options: [
            { id: "128M", label: "128 MB" },
            { id: "256M", label: "256 MB" },
            { id: "512M", label: "512 MB" },
            { id: "1024M", label: "1 GB" },
            { id: "2048M", label: "2 GB" },
          ],
          defaultValue: "256M",
        },
        {
          key: "timeout",
          label: "Timeout (seconds)",
          kind: "number",
          required: false,
          defaultValue: "60",
        },
      ],
    };
  },
};

export const cloudFunctionsCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "cloud-function": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "us-central1";
    const language = fields["language"] ?? "nodejs";
    const runtime = fields[`runtime_${language}`] ?? "nodejs24";
    const entryPoint = fields["entryPoint"] ?? "helloHttp";
    const availableMemory = fields["availableMemory"] ?? "256M";
    const timeout = fields["timeout"] ?? "60";
    const userCode = fields[`code_${language}`] ?? "";

    // Build the source archive. Cloud Functions Gen 2 hands the upload to
    // Buildpacks, which require a manifest file per language — without these
    // the build fails after the create call returns success.
    let sourceFiles: { name: string; content: string }[];
    if (language === "nodejs") {
      sourceFiles = [
        { name: "index.js", content: userCode },
        {
          name: "package.json",
          content: JSON.stringify(
            {
              name: "function",
              version: "0.0.1",
              main: "index.js",
              dependencies: { "@google-cloud/functions-framework": "^3.4.0" },
            },
            null,
            2,
          ),
        },
      ];
    } else if (language === "python") {
      sourceFiles = [
        { name: "main.py", content: userCode },
        { name: "requirements.txt", content: "functions-framework==3.*\n" },
      ];
    } else if (language === "go") {
      const goVersion = runtime.replace(/^go/, "").replace(/(\d)(\d)$/, "$1.$2");
      sourceFiles = [
        { name: "function.go", content: userCode },
        {
          name: "go.mod",
          content: `module example.com/function\n\ngo ${goVersion}\n\nrequire github.com/GoogleCloudPlatform/functions-framework-go v1.9.1\n`,
        },
      ];
    } else if (language === "java") {
      sourceFiles = [
        { name: "src/main/java/com/example/HelloHttp.java", content: userCode },
        {
          name: "pom.xml",
          content: `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>function</artifactId>\n  <version>0.0.1</version>\n  <properties>\n    <maven.compiler.source>17</maven.compiler.source>\n    <maven.compiler.target>17</maven.compiler.target>\n  </properties>\n  <dependencies>\n    <dependency>\n      <groupId>com.google.cloud.functions</groupId>\n      <artifactId>functions-framework-api</artifactId>\n      <version>1.1.0</version>\n      <scope>provided</scope>\n    </dependency>\n  </dependencies>\n</project>\n`,
        },
      ];
    } else {
      throw new Error(`Cloud Functions: unsupported language "${language}"`);
    }

    // Step 1: Generate upload URL (default environment is GEN_2 for v2 API)
    const uploadUrlRes = await fetch(
      `https://cloudfunctions.googleapis.com/v2/projects/${p}/locations/${region}/functions:generateUploadUrl`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "GEN_2" }),
      },
    );
    if (!uploadUrlRes.ok)
      throw new Error(
        `Cloud Functions generateUploadUrl failed: ${uploadUrlRes.status}: ${await uploadUrlRes.text()}`,
      );
    const uploadUrlData = (await uploadUrlRes.json()) as {
      uploadUrl: string;
      storageSource?: Record<string, unknown>;
    };
    const uploadUrl = uploadUrlData.uploadUrl;

    // Step 2: Upload the ZIP to the signed URL. The signed URL must NOT carry
    // an Authorization header — the URL itself is the credential.
    const zipBuffer = buildZipArchive(sourceFiles);
    // Only Content-Type is required per Google's docs — adding
    // x-goog-content-length-range is not (and trips CORS preflight on the
    // signed URL bucket from the desktop renderer).
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: zipBuffer as BodyInit,
    });
    if (!uploadRes.ok)
      throw new Error(
        `Cloud Functions source upload failed: ${uploadRes.status}: ${await uploadRes.text()}`,
      );

    // Step 3: Create the function. No trigger block is needed for HTTP —
    // Gen 2 auto-creates an https trigger when no eventTrigger is specified.
    // The full resource name is required in the body in addition to the
    // functionId query parameter. We resolve the project number so we can
    // pin the build SA and runtime SA explicitly — leaving them unset can
    // cause the Cloud Run service to silently not deploy on newer projects
    // ("CloudRunServiceNotFound" stateMessage), since Google has been
    // tightening default-SA behaviour.
    const fullResourceName = `projects/${p}/locations/${region}/functions/${name}`;
    let computeSaEmail: string | undefined;
    try {
      const proj = await ctx.get<{ projectNumber?: string }>(
        `https://cloudresourcemanager.googleapis.com/v3/projects/${p}`,
      );
      if (proj.projectNumber) {
        computeSaEmail = `${proj.projectNumber}-compute@developer.gserviceaccount.com`;
      }
    } catch {
      /* fall back to API defaults if we can't resolve the project number */
    }
    const buildConfig: Record<string, unknown> = {
      runtime,
      entryPoint,
      source: { storageSource: uploadUrlData.storageSource },
    };
    const serviceConfig: Record<string, unknown> = {
      availableMemory,
      timeoutSeconds: parseInt(timeout, 10),
      ingressSettings: "ALLOW_ALL",
      allTrafficOnLatestRevision: true,
    };
    if (computeSaEmail) {
      buildConfig["serviceAccount"] = `projects/${p}/serviceAccounts/${computeSaEmail}`;
      serviceConfig["serviceAccountEmail"] = computeSaEmail;
    }
    const createBody = {
      name: fullResourceName,
      environment: "GEN_2",
      buildConfig,
      serviceConfig,
    };
    const createRes = await fetch(
      `https://cloudfunctions.googleapis.com/v2/projects/${p}/locations/${region}/functions?functionId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      },
    );
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(
        `Cloud Functions create failed (${createRes.status}): ${text}\n\n` +
          `Tip: ensure these APIs are enabled on the project: ` +
          `cloudfunctions, cloudbuild, run, eventarc, artifactregistry. ` +
          `The default compute service account also needs roles/cloudfunctions.developer ` +
          `and roles/iam.serviceAccountUser.`,
      );
    }
    const fullName = fullResourceName;
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "cloud-function", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-function",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        runtime,
        state: "DEPLOYING",
        availableMemory,
        timeout,
      },
      resolvedOutputs: { url: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  },
};
