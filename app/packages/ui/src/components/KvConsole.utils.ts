// Console parsing is pure and mobile runs the same console, so it lives in
// client-core; re-exported here because web and desktop import it from `ui`.
export { tokenize, formatRedisResult } from "@infrawrench/client-core";
