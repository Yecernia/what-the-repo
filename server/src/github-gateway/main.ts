import { buildGithubGateway } from "./app.js";
import { loadGithubGatewayConfig } from "./config.js";

const config = loadGithubGatewayConfig();
const app = buildGithubGateway({ config });

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[github-gateway] received ${signal}; closing`);
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

await app.listen({ host: config.host, port: config.port });
console.log(`[github-gateway] listening on ${config.host}:${config.port}`);
