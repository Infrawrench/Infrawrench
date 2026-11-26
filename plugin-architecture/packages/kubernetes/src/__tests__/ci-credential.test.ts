import { describe, expect, it } from "vitest";
import type { CiLentValue } from "@infrawrench/plugin-base";
import yaml from "js-yaml";

import { KUBECTL, kubeContext, lendKubeconfig, serviceAccountOf } from "../ci-credential.js";

const jwt = (payload: object) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const saToken = jwt({ sub: "system:serviceaccount:ci:deployer" });

const kubeconfig = (user: object, extra = "") => `
apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: other
  cluster: { server: "https://other.example.test" }
- name: prod-cluster
  cluster:
    server: "https://k8s.example.test/"
    certificate-authority-data: Q0E=
users:
- name: other
  user: { token: wrong }
- name: prod-user
  user: ${JSON.stringify(user)}
contexts:
- name: dev
  context: { cluster: other, user: other }
- name: prod
  context: { cluster: prod-cluster, user: prod-user, namespace: web }
${extra}`;

const text = (value: CiLentValue) =>
  typeof value === "string" ? value : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
const secrets = (value: CiLentValue) =>
  typeof value === "string" ? [value] : value.flatMap((p) => ("secret" in p ? [p.secret] : []));

const request = { alias: "production-cluster", ttlSeconds: 1800 };
const noMint = async () => null;

describe("kubeContext", () => {
  it("reads the current context, not the first entries", () => {
    const ctx = kubeContext(kubeconfig({ token: "static" }));
    expect(ctx).toMatchObject({
      server: "https://k8s.example.test",
      caData: "Q0E=",
      namespace: "web",
      token: "static",
      external: false,
    });
  });
});

describe("serviceAccountOf", () => {
  it("finds a service account token's account and ignores others", () => {
    expect(serviceAccountOf(saToken)).toEqual({ namespace: "ci", name: "deployer" });
    expect(serviceAccountOf(jwt({ sub: "alice" }))).toBeNull();
    expect(serviceAccountOf("not-a-jwt")).toBeNull();
  });
});

describe("lendKubeconfig", () => {
  it("lends a static token for one context, with only the token secret", async () => {
    const lent = await lendKubeconfig(
      { kubeconfig: kubeconfig({ token: "static" }), mintToken: noMint },
      request,
    );
    const file = lent.files[0]!;
    expect(file.path).toBe("/root/.kube/production-cluster.yaml");
    expect(lent.env["KUBECONFIG"]).toEqual([{ text: "/root/.kube/production-cluster.yaml" }]);
    // Terraform's kubernetes and helm providers read this one, not KUBECONFIG.
    expect(lent.env["KUBE_CONFIG_PATH"]).toEqual(lent.env["KUBECONFIG"]);
    // Both are a path, shown in a log; the secrets are in the file.
    expect(Object.keys(lent.env).sort()).toEqual(["KUBECONFIG", "KUBE_CONFIG_PATH"]);
    expect(Object.values(lent.env).flatMap(secrets)).toEqual([]);
    expect(secrets(file.content)).toEqual(["static"]);
    const doc = yaml.load(text(file.content)) as Record<string, any>;
    expect(doc["clusters"]).toHaveLength(1);
    expect(doc["clusters"][0].cluster.server).toBe("https://k8s.example.test");
    expect(doc["users"][0].user).toEqual({ token: "static" });
    expect(doc["contexts"][0].context.namespace).toBe("web");
    expect(doc["current-context"]).toBe("production-cluster");
  });

  it("uses the namespace the job asks for", async () => {
    const lent = await lendKubeconfig(
      { kubeconfig: kubeconfig({ token: "static" }), mintToken: noMint },
      { ...request, namespace: "staging" },
    );
    const doc = yaml.load(text(lent.files[0]!.content)) as Record<string, any>;
    expect(doc["contexts"][0].context.namespace).toBe("staging");
  });

  it("swaps a service account token for a short-lived one when the cluster allows it", async () => {
    const asked: number[] = [];
    const lent = await lendKubeconfig(
      {
        kubeconfig: kubeconfig({ token: saToken }),
        mintToken: async (sa, seconds) => {
          expect(sa).toEqual({ namespace: "ci", name: "deployer" });
          asked.push(seconds);
          return { token: "minted", expiresAt: "2026-11-13T01:00:00Z" };
        },
      },
      { ...request, ttlSeconds: 60 },
    );
    expect(asked).toEqual([600]);
    expect(secrets(lent.files[0]!.content)).toEqual(["minted"]);
    expect(text(lent.files[0]!.content)).not.toContain(saToken);
    expect(lent.expiresAt).toBe("2026-11-13T01:00:00Z");
  });

  it("lends the stored token when minting is refused", async () => {
    const lent = await lendKubeconfig(
      {
        kubeconfig: kubeconfig({ token: saToken }),
        mintToken: async () => {
          throw new Error("403");
        },
      },
      request,
    );
    expect(secrets(lent.files[0]!.content)).toEqual([saToken]);
  });

  it("keeps client certificates secret", async () => {
    const lent = await lendKubeconfig(
      {
        kubeconfig: kubeconfig({
          "client-certificate-data": "Q0VSVA==",
          "client-key-data": "S0VZ",
        }),
        mintToken: noMint,
      },
      request,
    );
    expect(secrets(lent.files[0]!.content)).toEqual(["Q0VSVA==", "S0VZ"]);
  });

  it("resolves a credential plugin through the driver", async () => {
    const lent = await lendKubeconfig(
      {
        kubeconfig: kubeconfig({ exec: { command: "aws", args: ["eks", "get-token"] } }),
        driverCredentials: async () => ({ token: "k8s-aws-v1.abc" }),
        mintToken: noMint,
      },
      request,
    );
    expect(secrets(lent.files[0]!.content)).toEqual(["k8s-aws-v1.abc"]);
    expect(text(lent.files[0]!.content)).not.toContain("exec");
  });

  // A cloud job's machine has none of these programs either, and is never
  // handed the cloud account's credentials they would need: what it gets is
  // the same self-contained file a runner job gets, whichever managed
  // Kubernetes the kubeconfig came from.
  it.each([
    ["EKS", { exec: { command: "aws", args: ["eks", "get-token", "--cluster-name", "prod"] } }],
    ["GKE", { exec: { command: "gke-gcloud-auth-plugin", provideClusterInfo: true } }],
    ["AKS", { exec: { command: "kubelogin", args: ["get-token", "--login", "azurecli"] } }],
    [
      "DOKS",
      {
        exec: {
          command: "doctl",
          args: ["kubernetes", "cluster", "kubeconfig", "exec-credential"],
        },
      },
    ],
    ["a legacy auth provider", { "auth-provider": { name: "gcp" } }],
  ])("lends %s a bearer token, never its credential plugin", async (_name, user) => {
    const lent = await lendKubeconfig(
      {
        kubeconfig: kubeconfig(user),
        driverCredentials: async () => ({ token: "minted-by-the-host" }),
        mintToken: noMint,
      },
      request,
    );
    const doc = yaml.load(text(lent.files[0]!.content)) as Record<string, any>;
    expect(doc["users"]).toHaveLength(1);
    expect(doc["users"][0].user).toEqual({ token: "minted-by-the-host" });
    expect(secrets(lent.files[0]!.content)).toEqual(["minted-by-the-host"]);
  });

  it("names kubectl as a pinned download for both architectures", () => {
    expect(KUBECTL.command).toBe("kubectl");
    for (const arch of ["x86_64", "aarch64"] as const) {
      expect(KUBECTL.downloads?.[arch]?.url).toMatch(
        /^https:\/\/dl\.k8s\.io\/release\/v\d+\.\d+\.\d+\/bin\/linux\/(amd64|arm64)\/kubectl$/,
      );
      expect(KUBECTL.downloads?.[arch]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("masks a value YAML would need escaped as a whole, quoted", async () => {
    const lent = await lendKubeconfig(
      { kubeconfig: kubeconfig({ token: 'odd"token' }), mintToken: noMint },
      request,
    );
    expect(secrets(lent.files[0]!.content)).toEqual(['"odd\\"token"']);
    const doc = yaml.load(text(lent.files[0]!.content)) as Record<string, any>;
    expect(doc["users"][0].user.token).toBe('odd"token');
  });

  it("refuses a cluster without TLS", async () => {
    await expect(
      lendKubeconfig(
        {
          kubeconfig: kubeconfig({ token: "t" }).replace("https://k8s", "http://k8s"),
          mintToken: noMint,
        },
        request,
      ),
    ).rejects.toThrow("not served over TLS");
  });

  it("explains a credential plugin the host will not run", async () => {
    await expect(
      lendKubeconfig(
        {
          kubeconfig: kubeconfig({ exec: { command: "aws" } }),
          driverCredentials: async () => {
            throw new Error("users[0].user.exec (runs a local credential plugin command)");
          },
          mintToken: noMint,
        },
        request,
      ),
    ).rejects.toThrow("credential plugin, which this Infrawrench host does not run");
  });
});
