# pi-dbx — Databricks AI Gateway provider for pi

A [pi](https://github.com/badlogic/pi-mono) extension that adds Databricks-hosted models
(DeepSeek, etc., served via the AI Gateway's OpenAI-compatible endpoint) as a first-class
provider, with OAuth2 **client-credentials** auth handled end to end:

- Exchanges your service principal's client id/secret for a 1-hour bearer token at
  `${DATABRICKS_HOST}/oidc/v1/token`.
- Pi persists the token to `~/.pi/agent/auth.json` and **auto-refreshes it whenever it
  expires** — under a cross-process lock, shared across all pi sessions. No browser, no
  manual re-login, no timers.

## Install

```sh
git clone https://github.com/shashank-mugiwara/pi-dbx.git
ln -s "$(pwd)/pi-dbx/databricks.ts" ~/.pi/agent/extensions/databricks.ts
```

(or just copy `databricks.ts` into `~/.pi/agent/extensions/`.)

## Setup

Configuration is hybrid — env vars if you have them, interactive prompts if you don't.

**Option 1: env vars** (add to your shell profile):

```sh
export DATABRICKS_HOST="https://dbc-xxxxxxxx-xxxx.cloud.databricks.com"
export DATABRICKS_CLIENT_ID="..."
export DATABRICKS_CLIENT_SECRET="..."
```

**Option 2: nothing** — you'll be prompted for each value during login.

Then, either way, run once inside pi:

```
/login        → pick "Databricks (service principal)"
/model        → pick "DeepSeek V4 Flash (Databricks)"
```

Login is non-interactive when env vars are set (it just fetches a token). Values you
were prompted for are stored in `~/.pi/agent/auth.json` so future sessions and hourly
refreshes need no env vars at all; values from env are **not** persisted — env stays
their source of truth.

## Commands

- `/databricks-auth` — show env/credential status and token time-to-expiry.

## Thinking / reasoning effort

DeepSeek v4 on Databricks is a reasoning model taking OpenAI-style
`reasoning_effort: low | medium | high` (default `medium`). Pi's thinking selector
(`Shift+Tab` / `/thinking`) maps onto it as: `off`/`minimal`/`low` → `low`,
`medium` → `medium`, `high`/`xhigh`/`max` → `high`. DeepSeek always reasons
internally — "off" means lowest effort, not disabled.

## Prompt caching

Databricks caches prompts **automatically server-side** for its hosted open-weight
models — there is nothing to enable client-side. Cache hits show up in pi's token
stats once the gateway reports `prompt_tokens_details.cached_tokens` in usage, which
pi parses natively.

## Cost display

Pi computes cost from per-million-token rates in the model config, which this
extension deliberately does not hardcode (Databricks bills pay-per-token via DBUs, so
rates are workspace/contract specific). Provide your own via env:

```sh
export DATABRICKS_MODEL_COSTS='{"system.ai.deepseek-v4-flash-0731":{"input":N,"output":N,"cacheRead":N,"cacheWrite":N}}'
```

Unset models/fields default to 0 — token counts still display, cost shows as zero.

## Adding more gateway models

Comma-separated model ids, picked up at pi start:

```sh
export DATABRICKS_EXTRA_MODELS="system.ai.some-model,system.ai.another-model"
```

Extra models get default limits (128k context, 8k output). For per-model limits, edit
`KNOWN_MODELS` in `databricks.ts`.

## Security note

If you let `/login` prompt for the client secret (i.e. `DATABRICKS_CLIENT_SECRET` is not
in your env), it is stored **in plaintext** in `~/.pi/agent/auth.json` (user-only file
permissions — the same treatment pi gives every stored API key). If your org treats the
secret as sensitive, keep it in the env: env-provided values are never written to disk,
and only the short-lived access token is persisted.

## How refresh works (the interesting part)

Client-credentials is a machine-to-machine grant: the id/secret pair can mint a fresh
token any time with one unattended POST. The extension implements pi's `oauth` provider
interface (`login` / `refreshToken` / `getApiKey`), and pi's auth resolver checks
`expires` on every request — when the token is past its expiry (kept 5 minutes ahead of
the real one), it calls `refreshToken` under a serialized, cross-process-safe lock and
persists the result. Two concurrent pi sessions won't double-refresh; one refreshes, the
other reuses the rotated token.
