import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface Route {
  status?: number;
  body?: unknown;
  // Raw text instead of JSON (Prometheus metrics, or malformed JSON).
  text?: string;
  delayMs?: number;
}

export type Routes = Record<string, Route>;

// A real HTTP server on a random local port, so probes go through actual fetch and sockets.
export const startFake = async (routes: Routes) => {
  const requests: { path: string; method: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push({ path, method: req.method ?? "", headers: req.headers });
    const route = routes[path];
    const send = () => {
      if (!route) return res.writeHead(404).end("not found");
      const payload = route.text ?? JSON.stringify(route.body ?? {});
      res.writeHead(route.status ?? 200, { "content-type": route.text === undefined ? "application/json" : "text/plain" }).end(payload);
    };
    if (route?.delayMs) setTimeout(send, route.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};
