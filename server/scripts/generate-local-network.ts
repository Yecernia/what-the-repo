/** Generate local development routing data; never read credentials or change the proxy itself. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerPreset, SUPPORTED_PROVIDER_IDS } from "../src/agent/provider-catalog.js";
import { safePublicHttpsUrl } from "../src/security/outbound-url.js";

const extraHosts = (process.env.WHAT_THE_REPO_LLM_DIRECT_HOSTS ?? "").split(",").map(host => host.trim()).filter(Boolean);
const webHosts = (process.env.WHAT_THE_REPO_WEB_REAL_IP_HOSTS ?? "").split(",").map(host => host.trim()).filter(Boolean).map(host => {
  if (!/^[a-z0-9.-]+$/i.test(host) || !safePublicHttpsUrl(`https://${host}`)) throw new Error("Invalid research hostname");
  return host.toLowerCase();
});
const hosts = [...new Set([
  ...SUPPORTED_PROVIDER_IDS.map(id => providerPreset(id)?.base_url).filter((url): url is string => Boolean(url))
    .map(url => new URL(url).hostname),
  ...extraHosts.map(host => {
    if (!/^[a-z0-9.-]+$/i.test(host) || !safePublicHttpsUrl(`https://${host}`)) throw new Error("Invalid extra LLM hostname");
    return host.toLowerCase();
  }),
])].sort();
const output = resolve(process.argv[2] ?? fileURLToPath(new URL("../../.local/network", import.meta.url)));
const script = `// what-the-repo local LLM routing. Regenerate after changing Node or provider endpoints.
// Install in Clash Verge's global extension script; retain any other existing customization.
const llmHosts = ${JSON.stringify(hosts, null, 2)};
const realIpHosts = ${JSON.stringify([...new Set([...hosts, ...webHosts])].sort(), null, 2)};
const nodePath = ${JSON.stringify(process.execPath)};

function main(config) {
  const dns = config.dns || {};
  const filterMode = dns["fake-ip-filter-mode"] || "blacklist";
  if (filterMode !== "blacklist" && filterMode !== "rule") {
    throw new Error("Review the existing DNS whitelist before applying what-the-repo routing");
  }
  const directRules = llmHosts.map(host => "AND,((PROCESS-PATH," + nodePath + "),(DOMAIN," + host + ")),DIRECT");
  config.rules = directRules.concat((config.rules || []).filter(rule => !directRules.includes(rule)));
  const realIpFilters = filterMode === "rule" ? realIpHosts.map(host => "DOMAIN," + host + ",real-ip") : realIpHosts;
  dns["fake-ip-filter"] = realIpFilters.concat((dns["fake-ip-filter"] || []).filter(rule => !realIpFilters.includes(rule)));
  config.dns = dns;
  return config;
}
`;
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "clash-llm-direct.js"), script);
await writeFile(resolve(output, "llm-hosts.json"), JSON.stringify({ node_path: process.execPath, hosts, web_real_ip_hosts: [...new Set(webHosts)].sort() }, null, 2) + "\n");
// Both Node's environment proxy and Pi's proxy-aware adapters understand NO_PROXY.
await writeFile(resolve(output, "no-proxy.env"), `NO_PROXY=localhost,127.0.0.1,::1,${hosts.join(",")}\n`);
process.stdout.write(`Generated local routing for ${hosts.length} LLM API hosts in ${output}\n`);
