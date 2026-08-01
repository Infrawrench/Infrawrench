// Re-export the @testing-library/jest-dom vitest augmentation so that tsc
// picks it up when type-checking files under src/.  The setupFiles entry
// (vitest.setup.ts) lives outside "src" and is therefore not included in
// tsconfig.json; importing the augmentation here ensures the Assertion<T>
// interface extensions are in scope for all test files.
import "@testing-library/jest-dom/vitest";
