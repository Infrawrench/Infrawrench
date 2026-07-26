/**
 * Publisher identity for every generated SDK package.
 *
 * Kept out of the individual targets because it isn't language-specific: a
 * future Python target's `pyproject.toml` wants the same author, repository and
 * license as the TypeScript one, and they should never disagree. Targets read
 * these and translate them into whatever their own manifest format calls them.
 */

export const AUTHOR = {
  name: "Infrawrench LLC",
  email: "astrid@infrawrench.com",
  url: "https://infrawrench.com",
} as const;

export const CONTRIBUTORS = [{ name: "Astrid Gealer", email: "astrid@infrawrench.com" }] as const;

/**
 * The generated clients are MIT, even though this repository is BUSL-1.1.
 *
 * That divergence is deliberate. A client library is something other people
 * link into their own software, and a source-available license with a
 * production-use restriction makes that a legal question they have to answer
 * before they can call the API at all. The BUSL terms protect the service, not
 * the wire format — so the thing that only knows how to *talk* to the service
 * is given away permissively.
 *
 * MIT obliges us to ship the license text and the copyright notice with the
 * package, which is why targets emit `LICENSE_TEXT` as a file rather than just
 * setting an SPDX string in a manifest.
 */
export const LICENSE = "MIT";

/** First year of publication, held fixed so generation stays reproducible. */
export const COPYRIGHT_YEAR = 2026;

export const COPYRIGHT_HOLDER = "Infrawrench LLC";

export const COPYRIGHT_NOTICE = `Copyright (c) ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}`;

export const LICENSE_TEXT = `MIT License

${COPYRIGHT_NOTICE}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export const REPOSITORY_URL = "https://github.com/Infrawrench/Infrawrench";

/**
 * The SDKs' documentation page, not the marketing root.
 *
 * Language-neutral on purpose: this is stamped into every generated manifest,
 * so a URL naming one language — as this did while TypeScript was the only
 * target — is wrong in the other eight. The page carries a section per
 * language.
 */
export const HOMEPAGE = "https://infrawrench.com/docs/team-and-billing/client-sdks";

export const ISSUES_URL = `${REPOSITORY_URL}/issues`;

export const KEYWORDS = [
  "infrawrench",
  "sdk",
  "api-client",
  "openapi",
  "infrastructure",
  "cloud",
  "devops",
] as const;

/** Where the generator lives, for the "don't edit this, edit that" pointer. */
export const GENERATOR_PATH = "app/packages/web/scripts/sdk";
