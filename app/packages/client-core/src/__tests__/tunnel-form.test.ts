import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CredentialField } from "@infrawrench/plugin-base";

import {
  rewriteCredentialFields,
  rewriteValueThroughTunnel,
  type TunnelEnds,
} from "../tunnel-form";

const own = { fallback: true };
const peer = { fallback: false };

function tunnel(remoteHost: string, remotePort: number, localPort = 4000): TunnelEnds {
  return { localPort, remoteHost, remotePort };
}

const address = (value: string, t: TunnelEnds, options = own) =>
  rewriteValueThroughTunnel("address", value, t, options);
const kube = (value: string, t: TunnelEnds, options = own) =>
  rewriteValueThroughTunnel("kubeconfig", value, t, options);

// Certificate data is base64 of a PEM header, long enough to wrap if anything
// re-serialised it; nothing here is a real key or token.
const CA_A =
  "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUM1ekNDQWMrZ0F3SUJBZ0lCQURBTkJna3Foa2lHOXcwQkFRc0ZBREFWTVJNd0VRWURWUVFERXdwcmRXSmwKY201bGRHVnpNQjRYRFRJMk1URXhOakF3TURBd01Gb1hEVE0yTVRFeE5EQXdNREF3TUZvd0ZURVRNQkVHQTFVRQpBeE1LYTNWaVpYSnVaWFJsY3pDQ0FTSXdEUVlKS29aSWh2Y05BUUVCQlFBRGdnRVBBRENDQVFvQ2dnRUJBTC9vCi0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K";
const CA_B =
  "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURCVENDQWUyZ0F3SUJBZ0lJWG1oNHJ4cEVTTmN3RFFZSktvWklodmNOQVFFTEJRQXdGVEVUTUJFR0ExVUUKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=";

/** Two clusters: an EKS one reached with `aws eks get-token`, and a kubeadm one. */
const MULTI = `apiVersion: v1
kind: Config
# Written by hand; the comments and the order stay.
clusters:
- cluster:
    certificate-authority-data: ${CA_A}
    server: https://4F2A9C3B1D.gr7.us-east-1.eks.amazonaws.com
  name: arn:aws:eks:us-east-1:111122223333:cluster/prod
- cluster:
    certificate-authority-data: ${CA_B}
    server: https://k8s-api.internal:6443 # the private API
  name: kubeadm
contexts:
- context:
    cluster: arn:aws:eks:us-east-1:111122223333:cluster/prod
    user: eks-user
  name: prod
- context:
    cluster: kubeadm
    namespace: web
    user: kubeadm-admin
  name: onprem
current-context: prod
preferences: {}
users:
- name: eks-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args:
      - --region
      - us-east-1
      - eks
      - get-token
      - --cluster-name
      - prod
      env:
      - name: AWS_PROFILE
        value: prod
      interactiveMode: Never
- name: kubeadm-admin
  user:
    client-certificate-data: ${CA_B}
    client-key-data: ${CA_A}
`;

describe("a kubeconfig behind a tunnel", () => {
  it("rewrites the issue's kubeconfig into a kubeconfig, not a URL", () => {
    const before =
      "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://10.0.0.1:6443\n";
    expect(kube(before, tunnel("10.0.0.1", 6443))).toBe(
      "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: https://127.0.0.1:4000\n    tls-server-name: 10.0.0.1\n",
    );
  });

  it("changes only the cluster the tunnel reaches, byte for byte everywhere else", () => {
    const after = kube(MULTI, tunnel("k8s-api.internal", 6443));
    expect(after).toBe(
      MULTI.replace(
        "    server: https://k8s-api.internal:6443 # the private API\n",
        "    server: https://127.0.0.1:4000 # the private API\n    tls-server-name: k8s-api.internal\n",
      ),
    );
    // Still a kubeconfig, with its certificates and exec auth intact.
    const doc = parse(after);
    expect(doc.clusters[0].cluster).toEqual({
      "certificate-authority-data": CA_A,
      server: "https://4F2A9C3B1D.gr7.us-east-1.eks.amazonaws.com",
    });
    expect(doc.clusters[1].cluster).toEqual({
      "certificate-authority-data": CA_B,
      server: "https://127.0.0.1:4000",
      "tls-server-name": "k8s-api.internal",
    });
    expect(doc.users[0].user.exec.args).toContain("get-token");
  });

  it("matches a server without a port on its host, whatever the remote port", () => {
    const after = kube(MULTI, tunnel("4f2a9c3b1d.gr7.us-east-1.eks.amazonaws.com", 443));
    const doc = parse(after);
    expect(doc.clusters[0].cluster.server).toBe("https://127.0.0.1:4000");
    expect(doc.clusters[0].cluster["tls-server-name"]).toBe(
      "4f2a9c3b1d.gr7.us-east-1.eks.amazonaws.com",
    );
    expect(doc.clusters[1].cluster.server).toBe("https://k8s-api.internal:6443");
  });

  it("falls back to the current context's cluster when no server names the remote end", () => {
    const after = kube(MULTI, tunnel("10.20.0.7", 443));
    const doc = parse(after);
    expect(doc.clusters[0].cluster.server).toBe("https://127.0.0.1:4000");
    expect(doc.clusters[1].cluster.server).toBe("https://k8s-api.internal:6443");
    // Switch the current context and the other cluster is the one.
    const onprem = MULTI.replace("current-context: prod", "current-context: onprem");
    const switched = parse(kube(onprem, tunnel("10.20.0.7", 443)));
    expect(switched.clusters[0].cluster.server).toBe(
      "https://4F2A9C3B1D.gr7.us-east-1.eks.amazonaws.com",
    );
    expect(switched.clusters[1].cluster.server).toBe("https://127.0.0.1:4000");
  });

  it("leaves a peer's kubeconfig alone unless a server names the remote end", () => {
    expect(kube(MULTI, tunnel("10.20.0.7", 443), peer)).toBe(MULTI);
    expect(
      parse(kube(MULTI, tunnel("k8s-api.internal", 6443), peer)).clusters[1].cluster.server,
    ).toBe("https://127.0.0.1:4000");
  });

  it("is the same rewritten twice", () => {
    const once = kube(MULTI, tunnel("k8s-api.internal", 6443));
    expect(kube(once, tunnel("k8s-api.internal", 6443))).toBe(once);
    const fallback = kube(MULTI, tunnel("10.20.0.7", 443));
    expect(kube(fallback, tunnel("10.20.0.7", 443))).toBe(fallback);
  });

  it("keeps a cluster's own tls-server-name, and adds none when it skips verification", () => {
    const named = `clusters:
- cluster:
    server: https://10.0.0.1:6443
    tls-server-name: api.cluster.local
  name: a
- cluster:
    insecure-skip-tls-verify: true
    server: https://10.0.0.2:6443
  name: b
`;
    expect(kube(named, tunnel("10.0.0.1", 6443))).toBe(
      named.replace("https://10.0.0.1:6443", "https://127.0.0.1:4000"),
    );
    expect(kube(named, tunnel("10.0.0.2", 6443))).toBe(
      named.replace("https://10.0.0.2:6443", "https://127.0.0.1:4000"),
    );
  });

  it("leaves a cluster that goes through a proxy alone", () => {
    const proxied = `clusters:
- cluster:
    proxy-url: socks5://bastion.internal:1080
    server: https://10.0.0.1:6443
  name: a
current-context: a
`;
    expect(kube(proxied, tunnel("10.0.0.1", 6443))).toBe(proxied);
  });

  it("keeps quotes, CRLF line endings and an IPv6 server as written", () => {
    const crlf = [
      "apiVersion: v1",
      "clusters:",
      "  - name: v6",
      "    cluster:",
      '      server: "https://[fd00::10]:6443/"',
      "      certificate-authority-data: " + CA_B,
      "kind: Config",
      "",
    ].join("\r\n");
    expect(kube(crlf, tunnel("fd00::10", 6443))).toBe(
      crlf.replace(
        '      server: "https://[fd00::10]:6443/"\r\n',
        '      server: "https://127.0.0.1:4000/"\r\n      tls-server-name: "fd00::10"\r\n',
      ),
    );
  });

  it("rewrites a kubeconfig written as JSON and keeps it JSON", () => {
    const json = JSON.stringify(
      {
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "gke",
            cluster: { "certificate-authority-data": CA_A, server: "https://34.118.0.9" },
          },
        ],
        contexts: [{ name: "gke", context: { cluster: "gke", user: "gke" } }],
        "current-context": "gke",
        users: [{ name: "gke", user: { token: "placeholder-not-a-token" } }],
      },
      null,
      2,
    );
    const after = kube(json, tunnel("34.118.0.9", 443));
    const doc = JSON.parse(after);
    expect(doc.clusters[0].cluster).toEqual({
      "certificate-authority-data": CA_A,
      server: "https://127.0.0.1:4000",
      "tls-server-name": "34.118.0.9",
    });
    expect(doc.users).toEqual([{ name: "gke", user: { token: "placeholder-not-a-token" } }]);
  });

  it("leaves anything that is not a kubeconfig alone", () => {
    for (const value of [
      "",
      "not: [valid",
      "placeholder-not-a-token",
      "apiVersion: v1\nkind: Config\nclusters: []\n",
      "https://10.0.0.1:6443",
    ]) {
      expect(kube(value, tunnel("10.0.0.1", 6443))).toBe(value);
    }
  });
});

describe("an address behind a tunnel", () => {
  const db = tunnel("db.internal", 5432);

  it("changes only the host and port of a URL, whatever else it carries", () => {
    expect(
      address(
        "postgresql://app:p%40ss:w0rd@db.internal:5432/app?sslmode=require&application_name=iw#x",
        db,
      ),
    ).toBe("postgresql://app:p%40ss:w0rd@127.0.0.1:4000/app?sslmode=require&application_name=iw#x");
    // An unencoded `@` in the password: the host follows the last one.
    expect(address("postgres://u:p@ss@db.internal:5432/db", db)).toBe(
      "postgres://u:p@ss@127.0.0.1:4000/db",
    );
    // The scheme keeps its case, which a URL parser would lower.
    expect(
      address("HTTPS://Proxmox.Internal:8006/api2/json", tunnel("proxmox.internal", 8006)),
    ).toBe("HTTPS://127.0.0.1:4000/api2/json");
    // A missing port matches on the host and is written in.
    expect(address("postgres://u@db.internal/app", db)).toBe("postgres://u@127.0.0.1:4000/app");
    expect(address("ssh://deploy@docker.internal", tunnel("docker.internal", 22))).toBe(
      "ssh://deploy@127.0.0.1:4000",
    );
  });

  it("rewrites host:port with a dotted name, an IP or an IPv6 literal", () => {
    expect(address("db.internal:6379", tunnel("db.internal", 6379))).toBe("127.0.0.1:4000");
    expect(address("10.0.0.5:6379", tunnel("10.0.0.5", 6379))).toBe("127.0.0.1:4000");
    expect(address("[fd00::5]:6379", tunnel("fd00::5", 6379))).toBe("127.0.0.1:4000");
    expect(address("redis://:pw@[FD00::5]:6379/0", tunnel("fd00::5", 6379))).toBe(
      "redis://:pw@127.0.0.1:4000/0",
    );
  });

  it("rewrites only the members of a list or seed list that name the remote end", () => {
    const seed =
      "mongodb://u:pw@m1.internal:27017,m2.internal:27017,m3.internal:27017/app?replicaSet=rs0";
    expect(address(seed, tunnel("m2.internal", 27017))).toBe(
      "mongodb://u:pw@m1.internal:27017,127.0.0.1:4000,m3.internal:27017/app?replicaSet=rs0",
    );
    expect(
      address("cache-a.internal:11211, cache-b.internal:11211", tunnel("cache-b.internal", 11211)),
    ).toBe("cache-a.internal:11211, 127.0.0.1:4000");
    expect(
      address("nats://n1.internal:4222,nats://n2.internal:4222", tunnel("n2.internal", 4222)),
    ).toBe("nats://n1.internal:4222,nats://127.0.0.1:4000");
    expect(
      address(
        "kafka://b1.internal:9092,b2.internal:9092?sasl=scram-sha-256&ssl=true",
        tunnel("b1.internal", 9092),
      ),
    ).toBe("kafka://127.0.0.1:4000,b2.internal:9092?sasl=scram-sha-256&ssl=true");
  });

  it("falls back to the first address when none names the remote end, and a peer gets no fallback", () => {
    const seed = "mongodb://m1.internal:27017,m2.internal:27017/app";
    expect(address(seed, tunnel("10.1.0.4", 27017))).toBe(
      "mongodb://127.0.0.1:4000,m2.internal:27017/app",
    );
    expect(address(seed, tunnel("10.1.0.4", 27017), peer)).toBe(seed);
    expect(address("postgres://u:p@db.internal:5432/app", tunnel("10.0.0.5", 5432), peer)).toBe(
      "postgres://u:p@db.internal:5432/app",
    );
  });

  it("counts every loopback name as one host, so a preset's localhost matches 127.0.0.1", () => {
    expect(address("postgresql://localhost:5432/postgres", tunnel("127.0.0.1", 5432), peer)).toBe(
      "postgresql://127.0.0.1:4000/postgres",
    );
  });

  it("is the same rewritten twice", () => {
    const once = address(
      "mongodb://m1.internal:27017,m2.internal:27017/app",
      tunnel("m2.internal", 27017),
    );
    expect(address(once, tunnel("m2.internal", 27017))).toBe(once);
    expect(address("redis://127.0.0.1:4000", tunnel("10.0.0.5", 6379))).toBe(
      "redis://127.0.0.1:4000",
    );
  });

  it("leaves a value that is no address alone", () => {
    for (const value of [
      "",
      "unix:///var/run/docker.sock",
      "mongodb+srv://u:pw@cluster0.db.internal/app?retryWrites=true",
      "npipe:////./pipe/docker_engine",
      "host=db.internal port=5432 dbname=app",
      "12:34:56:78:9a:bc:de:f0",
      "db.internal:5432/app",
      "https://a b.internal",
      "postgres://u:pa/ss@db.internal:5432/db",
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      "apiVersion: v1\nkind: Config\n",
      "db.internal:99999",
    ]) {
      expect(address(value, tunnel("db.internal", 5432))).toBe(value);
    }
  });
});

describe("the fields a plugin marks", () => {
  const field = (key: string, tunnelForm?: CredentialField["tunnel"]): CredentialField => ({
    key,
    label: key,
    sensitive: false,
    ...(tunnelForm ? { tunnel: tunnelForm } : {}),
  });
  const fields = [
    field("servers", "address"),
    field("url", "address"),
    field("token"),
    field("kubeconfig", "kubeconfig"),
  ];

  it("rewrites only marked fields and says which it changed", () => {
    const credentials = {
      servers: "nats://nats.internal:4222",
      url: "http://nats.internal:8222",
      token: "nats.internal:4222",
    };
    expect(
      rewriteCredentialFields(fields, credentials, tunnel("nats.internal", 4222), own),
    ).toEqual(["servers"]);
    // The monitoring port is not the forwarded one, so it is not pointed at it.
    expect(credentials).toEqual({
      servers: "nats://127.0.0.1:4000",
      url: "http://nats.internal:8222",
      token: "nats.internal:4222",
    });
  });

  it("falls back across all of them only when no field names the remote end", () => {
    const credentials = { servers: "nats://nats.internal:4222", url: "http://nats.internal:8222" };
    expect(rewriteCredentialFields(fields, credentials, tunnel("10.0.0.9", 4222), own)).toEqual([
      "servers",
      "url",
    ]);
    expect(credentials).toEqual({ servers: "nats://127.0.0.1:4000", url: "http://127.0.0.1:4000" });
  });

  it("changes nothing a field without the flag holds, however much it looks like an address", () => {
    const credentials = { token: "db.internal:5432" };
    expect(rewriteCredentialFields(fields, credentials, tunnel("db.internal", 5432), own)).toEqual(
      [],
    );
    expect(credentials).toEqual({ token: "db.internal:5432" });
  });
});
