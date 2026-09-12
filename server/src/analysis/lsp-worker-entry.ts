import { runLspWorkerCli } from "./lsp-worker.js";

process.exitCode = await runLspWorkerCli();
