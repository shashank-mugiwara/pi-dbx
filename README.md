# pi-dbx

A [pi](https://github.com/badlogic/pi-mono) extension for Databricks AI Gateway models (DeepSeek etc.).
Handles OAuth client-credentials auth end to end — the 1-hour token is auto-refreshed across all pi sessions, no manual re-login.

## Install

```sh
git clone https://github.com/shashank-mugiwara/pi-dbx.git
ln -s "$(pwd)/pi-dbx/databricks.ts" ~/.pi/agent/extensions/databricks.ts
```

Optionally set env vars (skip to be prompted instead):

```sh
export DATABRICKS_HOST="https://dbc-xxxxxxxx-xxxx.cloud.databricks.com"
export DATABRICKS_CLIENT_ID="..."
export DATABRICKS_CLIENT_SECRET="..."
```

Then in pi:

```
/login   → "Databricks (service principal)"
/model   → "DeepSeek V4 Flash (Databricks)"
```

## Configuration

| Env var | Purpose |
|---|---|
| `DATABRICKS_HOST` / `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET` | Workspace + service principal credentials; anything missing is prompted at `/login` and stored in `~/.pi/agent/auth.json` |
| `DATABRICKS_EXTRA_MODELS` | Comma-separated extra gateway model ids |
| `DATABRICKS_EXTRA_MODELS` | Comma-separated extra gateway model ids; they get conservative 128k context / 8k output limits |
| `DATABRICKS_MODEL_COSTS` | Per-million-token rates as JSON, e.g. `{"system.ai.deepseek-v4-flash-0731":{"input":N,"output":N,"cacheRead":N,"cacheWrite":N}}` — unset means cost shows as zero |
| `DATABRICKS_MIN_REQUEST_INTERVAL_MS` | Minimum gap between requests to the gateway (helps with 429 rate limits); unset/0 = off |

`system.ai.deepseek-v4-flash-0731` is registered with a **1,048,576-token context window and 65,536 max output tokens** — measured against a live endpoint (Databricks docs say 200k/10k for this endpoint, and the serving-endpoint API reports `long_context: false`; both are wrong). Pay-per-token endpoints still hit a workspace tokens-per-minute rate limit far below 1M, so filling the window needs provisioned throughput.

Thinking effort maps to Databricks `reasoning_effort` (`off/minimal/low → low`, `medium → medium`, `high/xhigh/max → high`); prompt caching is automatic server-side. `/databricks-auth` shows auth status and token expiry.

Note: credentials entered at the `/login` prompt (including the client secret) are stored in plaintext in `~/.pi/agent/auth.json`; env-provided values are never written to disk.
