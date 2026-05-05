export type GhAsset = {
  id: number;
  name: string;
  size: number;
  content_type: string;
  updated_at: string;
};

export type GhRelease = {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
};

const UA = "infrawrench-website";

type GhEnv = {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
};

function ghHeaders(env: GhEnv): HeadersInit {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": UA,
  };
}

export async function fetchLatestRelease(env: GhEnv): Promise<GhRelease> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/latest`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) {
    throw new GhError(`Failed to fetch latest release: ${res.status}`, res.status);
  }
  return (await res.json()) as GhRelease;
}

export async function fetchReleaseByTag(env: GhEnv, tag: string): Promise<GhRelease> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) {
    throw new GhError(`Failed to fetch release ${tag}: ${res.status}`, res.status);
  }
  return (await res.json()) as GhRelease;
}

export async function fetchAssetStream(env: GhEnv, assetId: number): Promise<Response> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${assetId}`;
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/octet-stream",
      "User-Agent": UA,
    },
  });
}

export class GhError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "GhError";
  }
}

export type PlatformKey =
  | "macos-arm64"
  | "macos-x64"
  | "windows-x64"
  | "windows-arm64"
  | "linux-x64-appimage"
  | "linux-arm64-appimage"
  | "linux-x64-deb"
  | "linux-arm64-deb"
  | "linux-x64-snap";

export function classifyAsset(name: string): PlatformKey | null {
  const n = name.toLowerCase();

  if (n.endsWith(".dmg")) {
    if (n.includes("arm64")) return "macos-arm64";
    if (n.includes("x64") || n.includes("x86_64") || n.includes("intel")) return "macos-x64";
    return null;
  }

  if (n.endsWith(".exe")) {
    if (n.includes("arm64")) return "windows-arm64";
    if (n.includes("x64") || n.includes("x86_64") || n.includes("amd64")) return "windows-x64";
    return null;
  }

  if (n.endsWith(".appimage")) {
    if (n.includes("arm64") || n.includes("aarch64")) return "linux-arm64-appimage";
    return "linux-x64-appimage";
  }

  if (n.endsWith(".deb")) {
    if (n.includes("arm64") || n.includes("aarch64")) return "linux-arm64-deb";
    return "linux-x64-deb";
  }

  if (n.endsWith(".snap")) {
    return "linux-x64-snap";
  }

  return null;
}

export function versionFromTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}
