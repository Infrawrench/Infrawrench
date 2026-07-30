---
title: Client SDKs
description: Generated, MIT-licensed API clients for nine languages, built from the OpenAPI spec.
sidebar_order: 7
---

> **Web only.** The desktop app has no public HTTP surface — it talks to plugins directly.

Nine client libraries are generated from the same [OpenAPI 3.1 spec](./openapi.md)
the server publishes. They are **MIT-licensed** — deliberately more permissive
than Infrawrench itself, so you can link one into your own software without
inheriting BUSL terms.

| Language   | Package                                 | Dependencies      | Call style                              |
| ---------- | --------------------------------------- | ----------------- | --------------------------------------- |
| TypeScript | `@infrawrench/sdk`                      | none              | `client.accounts.list()`                |
| Python     | `infrawrench-sdk`                       | none (stdlib)     | `client.accounts.list()`                |
| Ruby       | `infrawrench-sdk`                       | none (stdlib)     | `client.accounts.list`                  |
| Go         | `github.com/Infrawrench/infrawrench-go` | none (stdlib)     | `client.Accounts.List(ctx, nil)`        |
| Java       | `com.infrawrench:infrawrench-sdk`       | none (JDK 17+)    | `client.accounts().list()`              |
| C#         | `Infrawrench.Sdk`                       | none (in-box)     | `await client.Accounts.ListAsync()`     |
| PHP        | `infrawrench/sdk`                       | none              | `$client->accounts->list()`             |
| Swift      | `InfrawrenchSDK`                        | none (Foundation) | `try await client.accounts.list()`      |
| Rust       | `infrawrench-sdk`                       | reqwest, serde    | `client.accounts().list(params).await?` |

Rust is the only one with third-party dependencies, because Rust has no standard
library HTTP client. Everything else runs on what ships with the language.

## Install

```sh
npm install @infrawrench/sdk                    # TypeScript / JavaScript
pip install infrawrench-sdk                     # Python
gem install infrawrench-sdk                     # Ruby
go get github.com/Infrawrench/infrawrench-go    # Go
composer require infrawrench/sdk                # PHP
dotnet add package Infrawrench.Sdk              # C#
cargo add infrawrench-sdk                       # Rust
```

Java, from Maven Central:

```xml
<dependency>
  <groupId>com.infrawrench</groupId>
  <artifactId>infrawrench-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

Swift, via SwiftPM:

```swift
.package(url: "https://github.com/Infrawrench/infrawrench-swift.git", from: "0.1.0")
```

### Building from source

The packages are generated from the spec, so you can also build them yourself —
useful when you run your own deployment and want a client that matches _your_
plugin registry rather than ours:

```sh
pnpm --filter @infrawrench/web generate:sdk                  # all languages
pnpm --filter @infrawrench/web generate:sdk -- --target python
pnpm --filter @infrawrench/web generate:sdk -- --list        # what's registered
```

They appear under `sdk/<language>/` at the repo root.

## What they all share

Nine SDKs written by different hands would feel like nine products. These are
generated from one intermediate representation, so the same decisions hold
everywhere:

- **The client class is `APIV1Client`** in every language.
- **Calls are dotted, mirroring the URL.** `POST /api/org/{orgId}/accounts/{id}/sync`
  is `accounts.sync`, and `POST …/resources/{pluginId}/{typeId}/secret-versions/add`
  is `resources.secretVersions.add`. Casing follows local convention —
  `secret_versions` in Python and Ruby, `SecretVersions` in Go and C#.
- **Set `orgId` once.** Nearly every route is org-scoped; configure it on the
  client and calls can omit it, or pass it per call to override. Supply neither
  and the call fails _before_ sending anything.
- **Errors are one type** — `ApiError` (or `ApiException`) carrying the HTTP
  status, the parsed body, and the machine-readable `code` when the API sends
  one. Branch on `code`, not on the message.
- **Enums stay open.** A `pluginId` the server learns about after you generated
  your client decodes instead of throwing. This cost a little type safety and
  buys forward compatibility; every target reached the same conclusion.
- **Internal routes are absent by construction.** The generator consumes the
  same filtered document `/openapi.json` serves, so the
  [admin surface, webhook receivers, desktop sync, push registration and browser
  auth redirects](./openapi.md#internal-routes) have no methods at all.

<insert [Editor screenshot showing autocomplete on `client.accounts.` in two different languages side by side, with the generated doc comment visible] here>

## Examples

```ts
// TypeScript
import { APIV1Client, ApiError } from "@infrawrench/sdk";
const client = new APIV1Client({ apiKey: process.env.INFRAWRENCH_API_KEY, orgId });
const accounts = await client.accounts.list();
```

```python
# Python
from infrawrench_sdk import APIV1Client, ApiError

client = APIV1Client(api_key=..., org_id=...)
accounts = client.accounts.list()
version = client.resources.secret_versions.add(plugin_id="gcp", type_id="secret", body=...)
```

```go
// Go — every call takes a context, as Go expects.
client := infrawrench.NewAPIV1Client(infrawrench.WithAPIKey(key), infrawrench.WithOrgID(org))
accounts, err := client.Accounts.List(ctx, nil)
```

```csharp
// C#
using var client = new APIV1Client(new ClientOptions { ApiKey = key, OrgId = org });
var accounts = await client.Accounts.ListAsync();
```

```rust
// Rust — async, and namespaces are accessor methods rather than fields.
let client = APIV1Client::new(ClientConfig::new().api_key(key).org_id(org))?;
for account in client.accounts().list(AccountsListParams::new()).await? { … }
```

Each generated package ships its own README with language-specific detail —
per-call options, file uploads, binary downloads, and what is deliberately
missing.

The [interactive API reference](./openapi.md#sdk-code-samples) at `/docs` shows
a per-operation sample for every one of the nine languages, generated from the
same naming rules as the packages themselves.

## How far each one is verified

Generated code that has never been compiled is a guess. Every target is built
and round-tripped against a stub server as part of development:

| Language   | Verified by                                                              |
| ---------- | ------------------------------------------------------------------------ |
| TypeScript | `tsc` during generation — a type error fails the build                   |
| Python     | `compileall`, `pyright --strict`, `mypy --strict`, live `http.server`    |
| Ruby       | `ruby -c` on every file, `rbs validate`, `gem build`                     |
| Go         | `gofmt`, `go build`, `go vet`, `httptest` round-trip                     |
| Java       | `javac`, `mvn -o compile`, `javadoc`, loopback `HttpServer` round-trip   |
| C#         | `dotnet build` (0 warnings), `dotnet pack`, stub-handler round-trip      |
| PHP        | `php -l` on all 232 files, live `php -S` round-trip on both HTTP senders |
| Swift      | `swift build` on macOS **and Linux**, 34 assertions via `URLProtocol`    |
| Rust       | `cargo fmt --check`, `cargo build`, `cargo clippy`, `cargo test`         |

Known gaps, stated rather than hidden:

- **Swift on iOS/tvOS/watchOS** — those deployment targets are declared in
  `Package.swift` but not built.
- **The empty-response path** is emitted but unexercised in every language: the
  current spec has 141 JSON and 2 binary responses and no `204`-only ones.
- **Java has no per-call request options** and no async API — headers and
  timeouts are client-level only, because a trailing options argument would
  reintroduce the overload ambiguity its two-overload scheme avoids.
- **PHP's PHPDoc types are unchecked** — PHPStan and Psalm were not available.

## Regeneration

The SDKs are rebuilt when the API version changes — `info.version` in the spec,
which is also the version stamped on each generated manifest. Running
`generate:openapi` refreshes them as part of the spec workflow.

As a safety net they also rebuild when the published spec changes without a
version bump, or when the generator itself changes; the reason is printed each
time, so an unexpected rebuild is visible rather than silent. Pass `--force` to
rebuild unconditionally. Toolchain build caches (`target/`, `.build/`, `bin/`,
`obj/`) survive regeneration, so a spec bump doesn't force a cold rebuild.

## Adding a language

The generator is target-based. The OpenAPI document is lowered once into a
language-neutral intermediate representation — the namespace tree, a normalized
type graph, and the operation list — and each target decides only how to print
types and calls from it. A new language is one directory under
`app/packages/web/scripts/sdk/targets/` and one line in the registry.

## License

The generated clients are **MIT**, even though Infrawrench itself is BUSL-1.1.
A client library is something you link into your own software, and it shouldn't
drag a production-use restriction along with it. Vendor, fork, or redistribute
them freely — the only obligation is the usual MIT one of keeping the copyright
notice, which ships in each package's `LICENSE` and in a banner comment at the
top of the generated sources.

The BUSL terms still cover the Infrawrench server and the rest of the source
tree, including the generator that produces these packages.
