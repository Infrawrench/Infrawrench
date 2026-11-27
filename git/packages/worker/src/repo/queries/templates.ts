/**
 * What a repository can be started with: a README, a `.gitignore` and a
 * licence. A name this file does not know is left out of the first commit
 * rather than refused (`RepoReader.init`).
 */
import { APACHE_2_0 } from "./license-apache";

const TERRAFORM = `# Local .terraform directories
.terraform/

# State files, which can hold secrets
*.tfstate
*.tfstate.*

# Crash logs
crash.log
crash.*.log

# Variable files, which tend to hold secrets
*.tfvars
*.tfvars.json

# Local overrides
override.tf
override.tf.json
*_override.tf
*_override.tf.json

# CLI configuration
.terraformrc
terraform.rc
`;

const NODE = `node_modules/
dist/
build/
coverage/
.env
.env.*
!.env.example
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
*.tsbuildinfo
.DS_Store
`;

const PYTHON = `__pycache__/
*.py[cod]
*.egg-info/
.eggs/
build/
dist/
.venv/
venv/
.env
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
htmlcov/
`;

const GO = `# Binaries
*.exe
*.dll
*.so
*.dylib
bin/

# Tests and coverage
*.test
*.out
coverage.*

# Workspaces
go.work
go.work.sum

.env
`;

const RUST = `target/
**/*.rs.bk
*.pdb
.env
`;

const GITIGNORES: Readonly<Record<string, string>> = {
  terraform: TERRAFORM,
  node: NODE,
  python: PYTHON,
  go: GO,
  rust: RUST,
};

const mit = (year: number, holder: string): string => `MIT License

Copyright (c) ${year} ${holder}

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

const isc = (year: number, holder: string): string => `ISC License

Copyright (c) ${year} ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`;

const LICENSES: Readonly<Record<string, (year: number, holder: string) => string>> = {
  mit,
  isc,
  "apache-2.0": () => APACHE_2_0,
};

/** The `.gitignore` for a template name (`Terraform`, `Node`), or null for one not known. */
export const gitignoreFor = (name: string): string | null =>
  GITIGNORES[name.trim().toLowerCase()] ?? null;

/** The licence text for an SPDX id (`MIT`, `Apache-2.0`), or null for one not known. */
export const licenseFor = (spdx: string, year: number, holder: string): string | null =>
  LICENSES[spdx.trim().toLowerCase()]?.(year, holder) ?? null;

export const readmeFor = (title: string, description: string | null): string =>
  description !== null && description.trim() !== ""
    ? `# ${title}\n\n${description.trim()}\n`
    : `# ${title}\n`;
