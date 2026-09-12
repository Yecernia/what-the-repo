import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface GithubGatewayConfig {
  host: string;
  port: number;
  nodeEnv: string;
  publicUrl: string;
  applicationCallbackUrl: string;
  sharedSecret: string;
  githubClientId: string;
  githubClientSecret: string;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`missing_${name.toLowerCase()}`);
  return trimmed;
}

function secretValue(env: NodeJS.ProcessEnv, directName: string, fileName: string): string {
  const direct = env[directName]?.trim();
  const configuredPath = env[fileName]?.trim();
  if (direct && configuredPath) throw new Error(`${directName}_and_file_conflict`);
  if (direct) return direct;
  if (!configuredPath) throw new Error(`missing_${fileName.toLowerCase()}`);
  const path = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
  if (!existsSync(path)) throw new Error(`${fileName.toLowerCase()}_not_found`);
  return required(readFileSync(path, "utf8"), fileName);
}

function exactHttpsUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`invalid_${name.toLowerCase()}`);
  }
  return url.toString().replace(/\/$/, "");
}

export function loadGithubGatewayConfig(env: NodeJS.ProcessEnv = process.env): GithubGatewayConfig {
  const port = Number(env.GITHUB_GATEWAY_PORT ?? 8408);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_github_gateway_port");
  const sharedSecret = secretValue(env, "GITHUB_GATEWAY_SHARED_SECRET", "GITHUB_GATEWAY_SHARED_SECRET_FILE");
  if (sharedSecret.length < 32) throw new Error("github_gateway_secret_too_short");
  const publicUrl = exactHttpsUrl(required(env.GITHUB_GATEWAY_PUBLIC_URL, "GITHUB_GATEWAY_PUBLIC_URL"), "GITHUB_GATEWAY_PUBLIC_URL");
  const applicationCallbackUrl = exactHttpsUrl(
    required(env.GITHUB_GATEWAY_APPLICATION_CALLBACK_URL, "GITHUB_GATEWAY_APPLICATION_CALLBACK_URL"),
    "GITHUB_GATEWAY_APPLICATION_CALLBACK_URL",
  );
  if (new URL(applicationCallbackUrl).pathname !== "/api/auth/github/callback") {
    throw new Error("invalid_github_gateway_application_callback_path");
  }
  return {
    host: env.GITHUB_GATEWAY_HOST?.trim() || "127.0.0.1",
    port,
    nodeEnv: env.NODE_ENV?.trim() || "production",
    publicUrl,
    applicationCallbackUrl,
    sharedSecret,
    githubClientId: required(env.GITHUB_OAUTH_CLIENT_ID, "GITHUB_OAUTH_CLIENT_ID"),
    githubClientSecret: secretValue(env, "GITHUB_OAUTH_CLIENT_SECRET", "GITHUB_OAUTH_CLIENT_SECRET_FILE"),
  };
}
