/**
 * `require("@infrawrench/infraenv/config")`: the CommonJS build of
 * `@infrawrench/infraenv/config`, which cannot await, so it runs
 * `configSync()` and blocks until the variables are set.
 */
import { WORKER_FLAG, configSync, optionsFromEnv } from "./index";

if (!process.env[WORKER_FLAG]) configSync(optionsFromEnv());
