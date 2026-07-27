// Console parsing is pure and mobile runs the same console, so it lives in
// client-core; re-exported here because web and desktop import it from `ui`.
export { tokenize, formatRedisResult, parseKvCommand } from "@infrawrench/client-core";
