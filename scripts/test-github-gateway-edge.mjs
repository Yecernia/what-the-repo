import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "scripts/install-github-gateway-edge.sh"), "utf8").replace(/\r\n/g, "\n");
const marker = "\nexport DEBIAN_FRONTEND=noninteractive\n";
assert.equal(source.split(marker).length, 2, "Keep a single boundary before host changes");
// Execute only the real argument/configuration checks, never package installation or /etc writes.
const preflight = source.slice(0, source.indexOf(marker));
assert.match(preflight, /DOMAIN="\$\{WTR_GITHUB_GATEWAY_DOMAIN:-\}"/);
assert.match(preflight, /GUANGZHOU_IP="\$\{WTR_GITHUB_GATEWAY_GUANGZHOU_IP:-\}"/);
assert.doesNotMatch(preflight, /\b(?:apt-get|systemctl|certbot|curl)\b/);
function resolveBash() {
  if (process.env.WTR_TEST_BASH) return process.env.WTR_TEST_BASH;
  if (process.platform === "win32") {
    const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true });
    if (git.status === 0) {
      const candidate = resolve(git.stdout.trim(), "../../../bin/bash.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "bash";
}
const bash = resolveBash();
const releaseRoot = process.platform === "win32"
  ? root.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase())
  : root;
const base = {
  ...process.env,
  WTR_GITHUB_GATEWAY_DOMAIN: "gateway.example.org",
  WTR_GITHUB_GATEWAY_GUANGZHOU_IP: "192.0.2.10",
  WTR_GITHUB_GATEWAY_UPSTREAM: "127.0.0.1:8408",
  WTR_GITHUB_GATEWAY_RELEASE_ROOT: releaseRoot,
  BASH_ENV: "",
  ENV: "",
};
function run(overrides = {}, { rootUser = true, args = ["--install"] } = {}) {
  const command = "id() { printf '" + (rootUser ? "0" : "1000") + "\\n'; }\n" + preflight + "\nprintf 'PREFLIGHT_OK\\n'\n";
  const result = spawnSync(bash, ["--noprofile", "--norc", "-s", "--", ...args], {
    input: command,
    encoding: "utf8",
    env: { ...base, ...overrides },
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}
const failures = [
  ["missing domain", { WTR_GITHUB_GATEWAY_DOMAIN: "" }, "set WTR_GITHUB_GATEWAY_DOMAIN"],
  ["missing IP", { WTR_GITHUB_GATEWAY_GUANGZHOU_IP: "" }, "set WTR_GITHUB_GATEWAY_DOMAIN"],
  ["URL instead of hostname", { WTR_GITHUB_GATEWAY_DOMAIN: "https://gateway.example.org" }, "invalid GitHub gateway hostname"],
  ["hostname injection", { WTR_GITHUB_GATEWAY_DOMAIN: "gateway.example.org;return 200" }, "invalid GitHub gateway hostname"],
  ["empty DNS label", { WTR_GITHUB_GATEWAY_DOMAIN: "gateway..example.org" }, "invalid GitHub gateway hostname"],
  ["invalid DNS label", { WTR_GITHUB_GATEWAY_DOMAIN: "-gateway.example.org" }, "invalid GitHub gateway hostname"],
  ["trailing dot", { WTR_GITHUB_GATEWAY_DOMAIN: "gateway.example.org." }, "invalid GitHub gateway hostname"],
  ["IP octet overflow", { WTR_GITHUB_GATEWAY_GUANGZHOU_IP: "192.0.2.256" }, "invalid Guangzhou IPv4"],
  ["ambiguous leading zero", { WTR_GITHUB_GATEWAY_GUANGZHOU_IP: "192.0.2.010" }, "invalid Guangzhou IPv4"],
  ["CIDR instead of host", { WTR_GITHUB_GATEWAY_GUANGZHOU_IP: "192.0.2.0/24" }, "invalid Guangzhou IPv4"],
  ["IP injection", { WTR_GITHUB_GATEWAY_GUANGZHOU_IP: "192.0.2.10;allow all" }, "invalid Guangzhou IPv4"],
  ["non-loopback upstream", { WTR_GITHUB_GATEWAY_UPSTREAM: "0.0.0.0:8408" }, "invalid loopback upstream"],
  ["zero port", { WTR_GITHUB_GATEWAY_UPSTREAM: "127.0.0.1:0" }, "invalid loopback upstream port"],
  ["port overflow", { WTR_GITHUB_GATEWAY_UPSTREAM: "127.0.0.1:65536" }, "invalid loopback upstream port"],
];
for (const [name, overrides, error] of failures) {
  const result = run(overrides);
  assert.equal(result.status, 64, name);
  assert.ok(result.stderr.includes(error), name);
  assert.ok(!result.stdout.includes("PREFLIGHT_OK"), name);
}
const valid = run();
assert.equal(valid.status, 0, valid.stderr);
assert.ok(valid.stdout.includes("PREFLIGHT_OK"));
assert.equal(run({}, { rootUser: false }).status, 77);
assert.equal(run({}, { args: [] }).status, 64);
assert.equal(run({ WTR_GITHUB_GATEWAY_RELEASE_ROOT: releaseRoot + "/missing-release-for-preflight-test" }).status, 66);
process.stdout.write("GitHub gateway edge preflight passed (18 cases; no host changes)\n");
