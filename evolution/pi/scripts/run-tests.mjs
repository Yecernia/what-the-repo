import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
  throw new Error(`Pi evolution tests require Node >=22.19.0; found ${process.versions.node}`);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = join(packageRoot, ".build", "tests");
const files = (await readdir(testsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => join(testsRoot, entry.name))
  .sort();

if (files.length === 0) throw new Error("compiled test files were not found");

const child = spawn(process.execPath, ["--test", ...files], {
  cwd: packageRoot,
  stdio: "inherit",
});

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
