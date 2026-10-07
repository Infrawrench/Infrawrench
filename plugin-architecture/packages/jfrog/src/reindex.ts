/**
 * Per-package-type "recalculate index" endpoints, relative to
 * `/artifactory/api`. Each is its own Artifactory API (verified against
 * docs.jfrog.com, 2026-10); the paths are irregular (`/deb/reindex/{key}`
 * against `/npm/{key}/reindex`, YUM with no `reindex` at all), so they are
 * listed rather than derived. Package types without an index have no entry
 * and get no button.
 */
const REINDEX: Record<string, (key: string) => string> = {
  npm: (k) => `/npm/${k}/reindex`,
  pypi: (k) => `/pypi/${k}/reindex`,
  helm: (k) => `/helm/${k}/reindex`,
  debian: (k) => `/deb/reindex/${k}`,
  rpm: (k) => `/yum/${k}`,
  nuget: (k) => `/nuget/${k}/reindex`,
  alpine: (k) => `/alpine/${k}/reindex`,
  cargo: (k) => `/cargo/${k}/reindex`,
  conda: (k) => `/conda/${k}/reindex`,
  cran: (k) => `/cran/reindex/${k}`,
  conan: (k) => `/conan/${k}/reindex`,
  cocoapods: (k) => `/cocoapods/${k}/reindex`,
  terraform: (k) => `/terraform/${k}/reindex`,
  pub: (k) => `/pub/${k}/reindex`,
  swift: (k) => `/swift/${k}/reindex`,
  opkg: (k) => `/opkg/reindex/${k}`,
};

/** The reindex path for a repository, or undefined when its type has no index. */
export function reindexPath(packageType: string, key: string): string | undefined {
  const build = REINDEX[packageType.toLowerCase()];
  return build ? `/artifactory/api${build(encodeURIComponent(key))}` : undefined;
}
