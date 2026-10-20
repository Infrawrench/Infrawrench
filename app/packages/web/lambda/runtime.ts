/**
 * The process entry of the Lambda image (`infra/docker/lambda.Dockerfile`'s
 * `bootstrap`) for both functions: the runtime loads whichever handler the
 * function's image command names. See `server-core/src/runtime/lambda-runtime.ts`.
 *
 * Kept free of the server code: it must run before any of it is loaded.
 */
// First, so tls distrusts the compromised eMudhra intermediates before anything connects.
import "kill-emudhra";
import { startLambdaRuntime } from "@infrawrench/server-core/runtime/lambda-runtime";

await startLambdaRuntime();
