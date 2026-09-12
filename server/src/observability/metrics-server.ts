import { createServer, type Server } from "node:http";
import type { RuntimeMetrics } from "./metrics.js";

export interface MetricsServerHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startMetricsServer(options: {
  host: string;
  port: number;
  token?: string | null;
  metrics: RuntimeMetrics;
  refresh?: () => Promise<void>;
}): Promise<MetricsServerHandle | null> {
  const token = options.token?.trim();
  if (!token) return null;

  const server = createServer(async (request, response) => {
    if (
      request.method !== "GET"
      || request.url !== "/metrics"
      || request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found\n");
      return;
    }

    try {
      await options.refresh?.();
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(options.metrics.prometheus());
    } catch {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("Metrics unavailable\n");
    }
  });
  await listen(server, options.host, options.port);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    host: options.host,
    port,
    close: () => close(server),
  };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
