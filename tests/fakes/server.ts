import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface Route {
  status?: number;
  body?: unknown;
  // Raw text instead of JSON (Prometheus metrics, or malformed JSON).
  text?: string;
  delayMs?: number;
  // Extra response headers, e.g. a provider's x-ratelimit-* on a header probe.
  headers?: Record<string, string>;
}

export type Routes = Record<string, Route>;

// A real HTTP server on a random local port, so probes go through actual fetch and sockets. A route is matched on the full
// path first, then on the path without its query, so an endpoint whose query is built from the clock can be registered once.
export const startFake = async (routes: Routes) => {
  const requests: { path: string; method: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const route = routes[path] ?? routes[path.split("?")[0]];
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ path, method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const send = () => {
        if (!route) return res.writeHead(404).end("not found");
        const payload = route.text ?? JSON.stringify(route.body ?? {});
        const headers = { "content-type": route.text === undefined ? "application/json" : "text/plain", ...(route.headers ?? {}) };
        res.writeHead(route.status ?? 200, headers).end(payload);
      };
      if (route?.delayMs) setTimeout(send, route.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};
