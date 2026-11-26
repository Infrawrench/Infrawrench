import type { TerraformProduct, TerraformRelease } from "./generate.js";

/**
 * The releases a workspace's runs may download, each pinned to the SHA-256
 * of its Linux zip from the publisher's own checksum list
 * (`releases.hashicorp.com/terraform/<v>/terraform_<v>_SHA256SUMS`,
 * `github.com/opentofu/opentofu/releases/download/v<v>/tofu_<v>_SHA256SUMS`).
 *
 * A job checks the download against the pin before it runs it, so a release
 * is offered only once its checksums are written here: adding a version is
 * adding a row, with both architectures. The first row of a product is its
 * default, used by a workspace that names no version.
 *
 * A `builtin:opentofu` tool in the CI runner would make this table, the
 * download and the virtual machine unnecessary (NOTES.md).
 */
const PINS: Record<TerraformProduct, ReadonlyArray<TerraformRelease>> = {
  terraform: [
    {
      product: "terraform",
      version: "1.15.8",
      sha256: {
        amd64: "d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d",
        arm64: "8891e9dcedc9e3b8950bc6af9d4d8af1f4cfade3062f53b9dc403a89f6ce8c9c",
      },
    },
    {
      product: "terraform",
      version: "1.17.2",
      sha256: {
        amd64: "e6f16b2f0b137ee5729caa8c4e79a3bae4ee261acd198a1fcfa8584a6296605b",
        arm64: "858e08c181a76b6b223e8c767a8e983922eebe2d062db949a2de66ce040c368c",
      },
    },
  ],
  opentofu: [
    {
      product: "opentofu",
      version: "1.13.10",
      sha256: {
        amd64: "c1f0d6b34d8328f963d3b1ad10896fae30a6c6890596190ffef477dab991090f",
        arm64: "e8febf96590c59f40bda6a3ea152847eebea8ec5efe7a39ba1d53a979e230cb3",
      },
    },
  ],
};

/** The versions of a product a workspace may choose, the default first. */
export function pinnedVersions(product: TerraformProduct): readonly string[] {
  return PINS[product].map((release) => release.version);
}

/**
 * The pinned release for a workspace's choice: the product's default for
 * null, the exact version when it is pinned, and null for anything else (a
 * constraint, or a version with no row here), which the caller reports
 * rather than guessing a near one.
 */
export function pinnedRelease(
  product: TerraformProduct,
  version: string | null,
): TerraformRelease | null {
  const releases = PINS[product];
  if (version === null || version.trim() === "") return releases[0] ?? null;
  const wanted = version.trim().replace(/^[=v]\s*/, "");
  return releases.find((release) => release.version === wanted) ?? null;
}
