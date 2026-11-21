# Converting an existing .env

The goal is a committed `.infraenv` with the same keys and no secret values.

1. **Read the keys, not the values aloud.** List the keys in `.env` (and `.env.example`, `.env.production` and the like, if present). You may look at a value only to classify it; never repeat it.
2. **Classify each key:**
   - **Not secret** (ports, feature flags, public URLs, `NODE_ENV`): keep it as a literal.
   - **Comes from infrastructure** (database URLs, cache URLs, bucket names, endpoints, API keys a provider issues): find the resource with `list_env_sources` and write a by-name `resource()` reference with the output the key needs.
   - **A secret with no resource behind it** (a third-party API key): write `secret("KEY")` and tell the user to create the organization secret `KEY` in Infrawrench (Environment files, or Settings) with the value from their `.env`. Do not create it for them with the value from the file unless they ask.
3. **Split environments.** Values that differ between the user's `.env.<stage>` files become `[env.<stage>]` overrides, or a `[vars]` substitution when only part of a name changes.
4. **Write `.infraenv`, then check it** with `infraenv check` (or `infrawrench env check`) and fix every problem.
5. **Leave the old `.env` alone.** The first pull refuses to overwrite a `.env` without the generated header; the user decides when to pass `--force`. Make sure `.env` is gitignored, and suggest `infraenv install` (or `infrawrench env hooks install`) so it regenerates when `.infraenv` changes.

`infrawrench env init --from .env` does steps 1 and 2 crudely (every key becomes `secret("KEY")`); use it as a start, then replace each line with the right kind.
