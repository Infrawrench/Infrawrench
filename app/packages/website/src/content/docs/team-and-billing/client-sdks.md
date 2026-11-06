---
title: Client SDKs
description: MIT-licensed API clients for nine languages, generated from the Infrawrench OpenAPI spec.
sidebar_order: 7
---

> **Web only.** The desktop app has no public HTTP API.

Use a client library to call the Infrawrench API from your own code. There are nine, all generated from the same [OpenAPI 3.1 spec](./openapi.md). They are **MIT-licensed**, so you can link one into your own software without taking on Infrawrench's BUSL terms.

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

Rust is the only one with third-party dependencies, since Rust has no standard library HTTP client. The rest run on what ships with the language.

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

Java, from our Maven repository. Maven only looks at Maven Central by default, so add the repository too. Releases up to 1.90.0 are also on Central, and Maven resolves those as before:

```xml
<repositories>
  <repository>
    <id>infrawrench</id>
    <url>https://maven.infrawrench.com</url>
    <snapshots><enabled>false</enabled></snapshots>
  </repository>
</repositories>

<dependency>
  <groupId>com.infrawrench</groupId>
  <artifactId>infrawrench-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

With Gradle, limit the repository to our group so your other dependencies never ask it:

```kotlin
repositories {
    mavenCentral()
    maven("https://maven.infrawrench.com") {
        content { includeGroup("com.infrawrench") }
    }
}
```

Swift, via SwiftPM:

```swift
.package(url: "https://github.com/Infrawrench/infrawrench-swift.git", from: "0.1.0")
```

### Build from source (self-hosting)

If you run your own deployment, you can build clients that match _your_ plugin registry:

```sh
pnpm --filter @infrawrench/web generate:sdk                  # all languages
pnpm --filter @infrawrench/web generate:sdk -- --target python
pnpm --filter @infrawrench/web generate:sdk -- --list        # what's registered
```

They appear under `sdk/<language>/` at the repo root.

## How every SDK works

The same rules hold in every language:

- **The client class is `APIV1Client`.**
- **Calls are dotted, mirroring the URL.** `POST /api/org/{orgId}/accounts/{id}/sync` is `accounts.sync`, and `POST …/resources/{pluginId}/{typeId}/secret-versions/add` is `resources.secretVersions.add`. Casing follows each language's convention: `secret_versions` in Python and Ruby, `SecretVersions` in Go and C#.
- **Set `orgId` once.** Nearly every route belongs to an organization. Set it on the client and calls can leave it out, or pass it per call to override. If you supply neither, the call fails before sending anything.
- **Errors are one type:** `ApiError` (or `ApiException`), carrying the HTTP status, the parsed body, and the machine-readable `code` when the API sends one. Branch on `code`, not on the message.
- **Enums stay open.** A `pluginId` added after you generated your client decodes instead of throwing.
- **Internal routes have no methods.** The [admin surface, webhook receivers, desktop sync, push registration and browser auth redirects](./openapi.md#internal-routes) aren't in the SDKs.

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
// Go: every call takes a context.
client := infrawrench.NewAPIV1Client(infrawrench.WithAPIKey(key), infrawrench.WithOrgID(org))
accounts, err := client.Accounts.List(ctx, nil)
```

```csharp
// C#
using var client = new APIV1Client(new ClientOptions { ApiKey = key, OrgId = org });
var accounts = await client.Accounts.ListAsync();
```

```rust
// Rust: async, and namespaces are accessor methods rather than fields.
let client = APIV1Client::new(ClientConfig::new().api_key(key).org_id(org))?;
for account in client.accounts().list(AccountsListParams::new()).await? { … }
```

Each package ships its own README with language-specific detail: per-call options, file uploads, binary downloads, and what's missing.

The [interactive API reference](./openapi.md#sdk-code-samples) at `/docs` shows a sample for every operation in all nine languages.

## Known gaps

- **Swift on iOS, tvOS and watchOS:** those targets are declared but not built or tested.
- **Empty responses** (`204`-only) aren't exercised yet in any language. The current API has none.
- **Java** has no per-call request options and no async API. Headers and timeouts are set on the client only.
- **PHP** PHPDoc types aren't checked by a static analyser.

## Versions

The SDKs are rebuilt when the API version (`info.version` in the spec) changes. That version is stamped on each package.

## License

The clients are **MIT**, even though Infrawrench itself is BUSL-1.1. Vendor, fork or redistribute them freely. The only obligation is the usual MIT one: keep the copyright notice, which ships in each package's `LICENSE` and at the top of the generated sources.

The BUSL terms still cover the Infrawrench server and the rest of the source tree, including the generator that produces these packages.
