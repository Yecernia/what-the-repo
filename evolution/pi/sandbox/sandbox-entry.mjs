import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import { posix } from "node:path";

const MAX_INPUT_BYTES = 6 * 1024 * 1024;
process.umask(0o077);

function portablePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") ||
    posix.isAbsolute(value)) throw new Error("invalid workspace path");
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    throw new Error("invalid workspace path");
  }
  return normalized;
}

function decodeFile(file) {
  const path = portablePath(file?.path);
  if (typeof file.contentBase64 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("invalid workspace file");
  const content = Buffer.from(file.contentBase64, "base64");
  if (content.toString("base64") !== file.contentBase64 || content.length !== file.bytes ||
    createHash("sha256").update(content).digest("hex") !== file.sha256) {
    throw new Error("workspace file integrity check failed");
  }
  return { path, content };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error("sandbox input exceeds byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function killGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function textFile(path) {
  return (await readFile(path, "utf8")).trim();
}

async function mount(path) {
  const lines = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n");
  for (const line of lines) {
    const [left, right] = line.split(" - ", 2);
    const fields = left.split(" ");
    if (fields[4] !== path) continue;
    return { options: fields[5].split(","), filesystem: right.split(" ")[0] };
  }
  throw new Error(`required mount is missing: ${path}`);
}

async function filesystemBytes(path) {
  const stats = await statfs(path, { bigint: true });
  const total = stats.bsize * stats.blocks;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`filesystem is too large to attest: ${path}`);
  return Number(total);
}

async function runtimeProbe() {
  const status = Object.fromEntries((await readFile("/proc/self/status", "utf8"))
    .trim().split("\n").map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }));
  const root = await mount("/");
  const workspace = await mount("/workspace");
  const temporary = await mount("/tmp");
  const sharedMemory = await mount("/dev/shm");
  const memoryMax = await textFile("/sys/fs/cgroup/memory.max");
  const swapMax = await textFile("/sys/fs/cgroup/memory.swap.max");
  const pidsMax = await textFile("/sys/fs/cgroup/pids.max");
  const [cpuQuota, cpuPeriod] = (await textFile("/sys/fs/cgroup/cpu.max")).split(/\s+/);
  if ([memoryMax, swapMax, pidsMax, cpuQuota, cpuPeriod].includes("max") ||
    !(await textFile("/sys/fs/cgroup/cgroup.controllers"))) {
    throw new Error("cgroup v2 limits are unavailable");
  }
  const networkInterfaces = (await readdir("/sys/class/net")).sort();
  return {
    schemaVersion: 1,
    uid: process.getuid(),
    gid: process.getgid(),
    noNewPrivileges: status.NoNewPrivs === "1",
    seccompMode: Number(status.Seccomp),
    effectiveCapabilities: status.CapEff,
    boundingCapabilities: status.CapBnd,
    networkInterfaces,
    rootReadOnly: root.options.includes("ro"),
    workspaceFilesystem: workspace.filesystem,
    workspaceBytes: await filesystemBytes("/workspace"),
    tempFilesystem: temporary.filesystem,
    tempBytes: await filesystemBytes("/tmp"),
    sharedMemoryFilesystem: sharedMemory.filesystem,
    sharedMemoryBytes: await filesystemBytes("/dev/shm"),
    cgroupVersion: 2,
    memoryMaxBytes: Number(memoryMax),
    swapMaxBytes: Number(swapMax),
    pidsMax: Number(pidsMax),
    cpuQuota: Number(cpuQuota),
    cpuPeriod: Number(cpuPeriod),
  };
}

async function execute(definition) {
  const maxOutputBytes = definition.maxOutputBytes;
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let terminationReason = "exit";
  let timedOut = false;
  return new Promise((resolve, reject) => {
    const child = spawn(definition.argv[0], definition.argv.slice(1), {
      cwd: definition.cwd,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: "/tmp/home",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        ...definition.env,
      },
    });
    const collect = (target, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes && terminationReason === "exit") {
        terminationReason = "output_limit";
        killGroup(child);
      }
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      terminationReason = "timeout";
      killGroup(child);
    }, definition.timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        schemaVersion: 1,
        exitCode: terminationReason === "exit" ? code : null,
        timedOut,
        terminationReason,
        stdoutBase64: Buffer.concat(stdout).toString("base64"),
        stderrBase64: Buffer.concat(stderr).toString("base64"),
      });
    });
  });
}

async function main() {
  const payload = JSON.parse(await readStdin());
  const definition = payload?.definition;
  const scope = payload?.scope;
  if (payload?.schemaVersion !== 1 || !definition || !scope ||
    !Array.isArray(definition.argv) || definition.argv.length < 1 ||
    !definition.argv.every((value) => typeof value === "string" && !value.includes("\0")) ||
    !posix.isAbsolute(definition.argv[0]) || !posix.isAbsolute(definition.cwd) ||
    !Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1 ||
    !Number.isSafeInteger(definition.maxOutputBytes) || definition.maxOutputBytes < 1 ||
    !Array.isArray(payload.workspaceFiles) || !Array.isArray(scope.allowedFiles) ||
    !Number.isSafeInteger(scope.maxWorkspaceBytes) || scope.maxWorkspaceBytes < 1 ||
    !Number.isSafeInteger(scope.maxFileCount) || scope.maxFileCount !== payload.workspaceFiles.length ||
    !definition.env || typeof definition.env !== "object" || Array.isArray(definition.env)) {
    throw new Error("invalid sandbox request");
  }
  const envEntries = Object.entries(definition.env);
  if (envEntries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
    typeof value !== "string" || value.includes("\0"))) throw new Error("invalid sandbox environment");
  const files = payload.workspaceFiles.map(decodeFile);
  if (new Set(files.map((file) => file.path)).size !== files.length ||
    files.reduce((total, file) => total + file.content.length, 0) > scope.maxWorkspaceBytes ||
    JSON.stringify([...files.map((file) => file.path)].sort()) !==
      JSON.stringify([...scope.allowedFiles.map(portablePath)].sort())) {
    throw new Error("sandbox file scope mismatch");
  }
  for (const file of files) {
    const destination = posix.join("/workspace", file.path);
    await mkdir(posix.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { mode: 0o600, flag: "wx" });
  }
  await mkdir("/tmp/home", { recursive: true, mode: 0o700 });
  const probe = await runtimeProbe();
  process.stdout.write(JSON.stringify({ ...await execute(definition), runtimeProbe: probe }));
}

main().catch((error) => {
  process.stderr.write(`sandbox entry failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 70;
});
