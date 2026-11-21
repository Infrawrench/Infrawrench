// Dependency deprecation warnings would print into the user's terminal before
// any CLI output; they are ours to fix, not the user's to read. A module of
// its own so it runs before the imports that follow it in `entry.ts`.
process.noDeprecation = true;
