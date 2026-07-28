export default {
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Many of these boot a real QuickJS/WASM isolate, each CPU-bound for a few
    // hundred milliseconds. The 5s default is comfortable on an idle machine
    // and too tight on a busy one, which surfaces as a timeout rather than as
    // anything informative.
    testTimeout: 20_000,
  },
};
