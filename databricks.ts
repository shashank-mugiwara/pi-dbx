/**
 * Databricks AI Gateway provider for pi.
 *
 * Auth is OAuth2 client-credentials (machine-to-machine): a service
 * principal's client id/secret is exchanged at ${host}/oidc/v1/token for a
 * 1-hour bearer token. Pi's credential store handles the hard part — it
 * persists { access, expires, ... } to ~/.pi/agent/auth.json (shared across
 * sessions) and calls refreshToken() under a cross-process lock whenever the
 * token is expired. No timers, no daemons, no manual re-login.
 *
 * Config is hybrid:
 *   - DATABRICKS_HOST / DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET env
 *     vars are used when present (login is then fully non-interactive).
 *   - Anything missing is prompted for during /login and persisted in the
 *     credential record, so env vars are never required after that.
 *
 * Run /login once and pick "Databricks" — that seeds the credential store.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "databricks";
const GATEWAY_PATH = "/ai-gateway/mlflow/v1";

/** Refresh this long before the server-side expiry so a token never dies mid-request. */
const EXPIRY_SAFETY_BUFFER_SECONDS = 300;

/** Extra fields we persist alongside pi's standard { access, refresh, expires }. */
type DatabricksCredentials = {
  access: string;
  refresh: string;
  expires: number;
  host?: string;
  clientId?: string;
  clientSecret?: string;
  [key: string]: unknown;
};

/**
 * Databricks reasoning models accept OpenAI-style `reasoning_effort`
 * (low | medium | high, default medium) — NOT the `thinking: {...}` object,
 * which the gateway reserves for Claude/Gemini. Pi's default "openai"
 * thinkingFormat emits exactly that, so no thinkingFormat override is set.
 * DeepSeek v4 is reasoning-only (always thinks), so pi's "off" level maps to
 * "low" rather than actually disabling; xhigh/max clamp down to "high".
 */
const DEEPSEEK_THINKING_LEVELS = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/**
 * Per-million-token cost rates, read from DATABRICKS_MODEL_COSTS so rates live
 * in the user's environment, not this file — Databricks bills pay-per-token
 * via DBUs, so any meaningful number is workspace/contract specific anyway:
 *   DATABRICKS_MODEL_COSTS='{"system.ai.deepseek-v4-flash-0731":{"input":N,"output":N,"cacheRead":N,"cacheWrite":N}}'
 * Missing models/fields default to 0 (pi then shows token counts but no cost).
 */
function costFor(modelId: string) {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  try {
    const table = JSON.parse(process.env.DATABRICKS_MODEL_COSTS ?? "{}") as Record<
      string,
      Partial<typeof zero> | undefined
    >;
    return { ...zero, ...table[modelId] };
  } catch {
    return zero;
  }
}

/**
 * Models served by the gateway. DeepSeek is the known one; extra model ids can
 * be added without editing this file via DATABRICKS_EXTRA_MODELS="id1,id2"
 * (they get the same default limits and reasoning support).
 */
const KNOWN_MODELS = [
  {
    id: "system.ai.deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash (Databricks)",
    reasoning: true,
    thinkingLevelMap: DEEPSEEK_THINKING_LEVELS,
    input: ["text"] as ("text" | "image")[],
    cost: costFor("system.ai.deepseek-v4-flash-0731"),
    contextWindow: 128000,
    maxTokens: 8192,
    compat: { supportsReasoningEffort: true },
  },
];

export default function (pi: ExtensionAPI) {
  const envHost = normalizeHost(process.env.DATABRICKS_HOST);

  const extraModels = (process.env.DATABRICKS_EXTRA_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .filter((id) => !KNOWN_MODELS.some((m) => m.id === id))
    .map((id) => ({
      id,
      name: `${id} (Databricks)`,
      reasoning: true,
      thinkingLevelMap: DEEPSEEK_THINKING_LEVELS,
      input: ["text"] as ("text" | "image")[],
      cost: costFor(id),
      contextWindow: 128000,
      maxTokens: 8192,
      compat: { supportsReasoningEffort: true },
    }));

  pi.registerProvider(PROVIDER, {
    name: "Databricks",
    // Placeholder until credentials exist; modifyModels() below rewrites it
    // from the stored host on every auth resolution.
    baseUrl: envHost ? `${envHost}${GATEWAY_PATH}` : `https://databricks.invalid${GATEWAY_PATH}`,
    api: "openai-completions",
    models: [...KNOWN_MODELS, ...extraModels],
    oauth: {
      name: "Databricks (service principal)",

      // Client-credentials "login": no browser, no human approval. Collect
      // whatever env doesn't provide, then exchange for a token immediately.
      async login(callbacks) {
        const host =
          envHost ??
          normalizeHost(
            await callbacks.onPrompt({
              message: "Databricks workspace URL (DATABRICKS_HOST)",
              placeholder: "https://dbc-xxxxxxxx-xxxx.cloud.databricks.com",
            }),
          );
        if (!host) throw new Error("A Databricks workspace URL is required.");

        const clientId =
          process.env.DATABRICKS_CLIENT_ID ??
          (await callbacks.onPrompt({
            message: "Service principal client ID (DATABRICKS_CLIENT_ID)",
          }));
        const clientSecret =
          process.env.DATABRICKS_CLIENT_SECRET ??
          (await callbacks.onPrompt({
            message:
              "Service principal client secret (DATABRICKS_CLIENT_SECRET) — stored in ~/.pi/agent/auth.json",
          }));
        if (!clientId || !clientSecret) {
          throw new Error("Client ID and client secret are both required.");
        }

        callbacks.onProgress?.("Requesting token from Databricks…");
        const token = await fetchToken(host, clientId, clientSecret);

        // Persist host/id/secret with the token so hourly refresh works in
        // any future pi session even without the env vars. Values that came
        // from env are not persisted — env stays their source of truth.
        const credentials: DatabricksCredentials = {
          access: token.accessToken,
          refresh: "client_credentials", // grant is repeatable; no refresh token exists
          expires: token.expiresAtMs,
          ...(envHost ? {} : { host }),
          ...(process.env.DATABRICKS_CLIENT_ID ? {} : { clientId }),
          ...(process.env.DATABRICKS_CLIENT_SECRET ? {} : { clientSecret }),
        };
        return credentials;
      },

      // Called automatically by pi (under a cross-process lock) whenever the
      // stored token is past `expires`. Same exchange as login.
      async refreshToken(credentials) {
        const creds = credentials as DatabricksCredentials;
        const host = normalizeHost(process.env.DATABRICKS_HOST) ?? creds.host;
        const clientId = process.env.DATABRICKS_CLIENT_ID ?? creds.clientId;
        const clientSecret = process.env.DATABRICKS_CLIENT_SECRET ?? creds.clientSecret;
        if (!host || !clientId || !clientSecret) {
          throw new Error(
            "Databricks client credentials unavailable (env vars unset and not stored). Run /login again.",
          );
        }
        const token = await fetchToken(host, clientId, clientSecret);
        return { ...creds, access: token.accessToken, expires: token.expiresAtMs };
      },

      getApiKey(credentials) {
        return (credentials as DatabricksCredentials).access;
      },

      // Point every model at the workspace from env/stored credentials.
      modifyModels(models, credentials) {
        const host =
          normalizeHost(process.env.DATABRICKS_HOST) ??
          (credentials as DatabricksCredentials).host;
        if (!host) return models;
        return models.map((m) => ({ ...m, baseUrl: `${host}${GATEWAY_PATH}` }));
      },
    },
  });

  pi.registerCommand("databricks-auth", {
    description: "Databricks auth status (token expiry, host, credential source)",
    handler: async () => {
      pi.sendMessage({
        customType: "databricks-auth",
        content: await databricksAuthStatus(envHost),
        display: true,
      });
    },
  });
}

async function fetchToken(host: string, clientId: string, clientSecret: string) {
  let response: Response;
  try {
    response = await fetch(`${host}/oidc/v1/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials&scope=all-apis",
    });
  } catch (error) {
    throw new Error(`Could not reach ${host}/oidc/v1/token: ${errorText(error)}`);
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Databricks token request failed (HTTP ${response.status}): ${firstLine(body)}`);
  }

  let parsed: { access_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Databricks token endpoint returned non-JSON: ${firstLine(body)}`);
  }
  if (!parsed.access_token) {
    throw new Error(`Databricks token response had no access_token: ${firstLine(body)}`);
  }

  const expiresInSeconds = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  return {
    accessToken: parsed.access_token,
    expiresAtMs: Date.now() + Math.max(expiresInSeconds - EXPIRY_SAFETY_BUFFER_SECONDS, 60) * 1000,
  };
}

/**
 * Status is read directly from ~/.pi/agent/auth.json (read-only): the
 * extension API has no accessor for the credential store, and shelling out
 * for a live token check would spend a request for no decision-changing info.
 */
async function databricksAuthStatus(envHost: string | undefined): Promise<string> {
  const lines = [
    `env DATABRICKS_HOST:          ${envHost ?? "(unset)"}`,
    `env DATABRICKS_CLIENT_ID:     ${process.env.DATABRICKS_CLIENT_ID ? "set" : "(unset)"}`,
    `env DATABRICKS_CLIENT_SECRET: ${process.env.DATABRICKS_CLIENT_SECRET ? "set" : "(unset)"}`,
  ];

  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const raw = await readFile(`${homedir()}/.pi/agent/auth.json`, "utf8");
    const stored = (JSON.parse(raw) as Record<string, DatabricksCredentials | undefined>)[PROVIDER];
    if (!stored?.access) {
      lines.push("credential store: none — run /login and pick Databricks");
    } else {
      const minutes = Math.round((stored.expires - Date.now()) / 60_000);
      lines.push(
        `credential store: token ${minutes > 0 ? `valid ~${minutes} min` : "EXPIRED (auto-refreshes on next request)"}`,
        `stored host:      ${stored.host ?? "(from env)"}`,
        `stored secret:    ${stored.clientSecret ? "yes (in auth.json)" : "no (from env)"}`,
      );
    }
  } catch (error) {
    lines.push(`credential store: unreadable — ${firstLine(errorText(error))}`);
  }

  return lines.join("\n");
}

function normalizeHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
