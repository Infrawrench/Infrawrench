/**
 * `import "@infrawrench/infraenv/config"` (or `node --import
 * @infrawrench/infraenv/config app.js`): `config()` at top level, so every
 * module imported after this one sees the variables. Options come from the
 * environment: INFRAENV_ENVIRONMENT, INFRAENV_FILE, INFRAENV_OVERRIDE=1,
 * INFRAENV_STRICT=1. A failure rejects the import, which stops the program
 * with a message that names files and keys, never values.
 */
import { WORKER_FLAG, config, optionsFromEnv } from "./index";

if (!process.env[WORKER_FLAG]) await config(optionsFromEnv());
