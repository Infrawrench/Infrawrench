Plugins should have all their logic encapsulated within them. The base should be as generic as possible, and then each plugin should handle everything. We don't want the electron code to have platform specific stuff. Update KNOWLEDGE.md as the project grows.

All code must be formatted with Prettier. Run `pnpm format` to format the entire project, or `pnpm format:check` to verify. The config is in `.prettierrc` at the root.

When you make changes to content that isn't specific to either web or desktop, make sure to implement on the other. Prefer sharing code where it makes sense to do so.
