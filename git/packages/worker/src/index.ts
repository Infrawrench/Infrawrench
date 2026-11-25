/**
 * git.infrawrench.com: the composition root. Routing, auth and the Durable
 * Objects live in their own modules; this file only wires them together.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
};
