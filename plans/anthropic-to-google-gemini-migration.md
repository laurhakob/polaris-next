# Migrate AI from Anthropic Claude → Google Gemini

## Context

Polaris currently runs all AI work through Anthropic's Claude models (5 call-sites across 4 files). The goal is to switch to Google Gemini to cut cost while keeping quality high enough for each call-site's job: a tool-calling coding agent, a title generator, an inline completion, a selection rewrite, and a demo background job.

Good news from investigation:

- `@ai-sdk/google@^3.0.10` is **already installed** in `package.json` and defaults to reading `GOOGLE_GENERATIVE_AI_API_KEY` — exactly the variable the user has set.
- `@inngest/agent-kit@^0.13.2` **already re-exports a `gemini` adapter** (from `@inngest/ai`) with the same `createAgent({ model })` shape as `anthropic`. No package upgrades needed.
- No other code (UI, routing, Convex schema, tools) is model-specific. Tool-calling is normalized by agent-kit's adapter layer, so the existing `createNetwork` router in `process-message.ts` keeps working.

The only shape difference between the adapters: agent-kit's `gemini({...})` reads `GEMINI_API_KEY` by default, while the user's env var is `GOOGLE_GENERATIVE_AI_API_KEY`. We pass `apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY` explicitly instead of renaming the variable — keeps one env name for both SDKs.

## Model mapping (cost-optimised per role)

| Call-site | From | To | Why |
|---|---|---|---|
| Main coding agent (tool calls, 20 iter) | `claude-opus-4-20250514` | **`gemini-2.5-flash`** | Strong coding + tool use, ~50× cheaper than Opus. Escape hatch: swap to `gemini-2.5-pro` if quality regresses on complex scaffolds. |
| Conversation title generator | `claude-3-haiku-20240307` | **`gemini-2.5-flash-lite`** | 50-token fixed task, cheapest tier is plenty. |
| Quick-edit (code rewrite + URL docs) | `claude-3-7-sonnet-20250219` | **`gemini-2.5-flash`** | Needs real reasoning; Flash handles structured output (`Output.object`) well. |
| Inline suggestion (autocomplete) | `claude-haiku-4-5` | **`gemini-2.5-flash-lite`** | Latency-sensitive; cheapest model. |
| Demo Inngest job | `claude-3-haiku-20240307` | **`gemini-2.5-flash-lite`** | Non-critical demo. |

All three model IDs (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`) are valid for both `@ai-sdk/google` and `@inngest/ai`'s `gemini()` factory.

## Files to modify

### 1. `src/features/conversations/inngest/process-message.ts`

Two agent-kit `anthropic(...)` call-sites. Replace the import symbol and both factories.

- Line 1: change `import { createAgent, anthropic, createNetwork } from "@inngest/agent-kit";` → `import { createAgent, gemini, createNetwork } from "@inngest/agent-kit";`
- Title-generator block (around L115–L122): replace the `model: anthropic({...})` with:
  ```ts
  model: gemini({
    model: "gemini-2.5-flash-lite",
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    defaultParameters: { temperature: 0, maxOutputTokens: 50 },
  }),
  ```
- Coding-agent block (around L152–L170): replace with:
  ```ts
  model: gemini({
    model: "gemini-2.5-flash",
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    defaultParameters: { temperature: 0.3, maxOutputTokens: 16000 },
  }),
  ```

Notes on `defaultParameters`: Anthropic uses `max_tokens`; Gemini uses `maxOutputTokens` in Google's `GenerationConfig` shape. `defaultParameters` is optional for Gemini (required for Anthropic), so if a field causes a type error we can drop it — keep `temperature` and `maxOutputTokens` for parity with current behavior.

The **router invariant** (`hasTextResponse && !hasToolCalls` stops the loop) stays as-is. agent-kit normalizes Gemini's `functionCall` parts into the same `type: "tool_call"` shape that the router checks, so no router changes are needed — but this should be re-verified during end-to-end testing (see Verification §3).

### 2. `src/app/api/suggestion/route.ts`

- Line 5: delete `import { anthropic } from "@ai-sdk/anthropic";`
- Line 6: uncomment/replace with `import { google } from "@ai-sdk/google";`
- Line 86: `model: anthropic("claude-haiku-4-5")` → `model: google("gemini-2.5-flash-lite")`

`Output.object({ schema: suggestionSchema })` is supported by `@ai-sdk/google` v3 — keep as-is. No env-var glue needed: the provider reads `GOOGLE_GENERATIVE_AI_API_KEY` automatically.

### 3. `src/app/api/quick-edit/route.ts`

- Line 5: `import { anthropic } from "@ai-sdk/anthropic";` → `import { google } from "@ai-sdk/google";`
- Line 101: `model: anthropic("claude-3-7-sonnet-20250219")` → `model: google("gemini-2.5-flash")`

The `quickEditSchema` + Firecrawl URL-scraping path is model-agnostic; no other changes.

### 4. `src/inngest/functions.ts`

- Line 4: `import { anthropic } from "@ai-sdk/anthropic";` → `import { google } from "@ai-sdk/google";`
- Line 53: `model: anthropic("claude-3-haiku-20240307")` → `model: google("gemini-2.5-flash-lite")`

### 5. `package.json`

- Remove `"@ai-sdk/anthropic": "^3.0.18"` from `dependencies` (no remaining imports after above).
- Do **not** bump `@ai-sdk/google` (3.0.10 is compatible with `ai@^6.0.79`) or `@inngest/agent-kit` (0.13.2 already has the `gemini` export).
- After editing, run `npm install` to refresh `package-lock.json` and remove the unused package.

### 6. `CLAUDE.md` (documentation sync)

Update three spots to stay truthful post-migration:

- Required-env section (line ~26): remove `ANTHROPIC_API_KEY`, add `GOOGLE_GENERATIVE_AI_API_KEY` as the single AI provider key. Firecrawl line stays.
- Architecture note that today reads *"Anthropic emits text and tool calls in the same turn …"* — keep the router-invariant note but generalize: Gemini, through agent-kit's adapter, behaves the same way; the router check is still correct.
- Per-call-site model rationale line (line ~61): rewrite to describe the new Gemini tiering (Flash for agent + quick-edit, Flash-Lite for suggestions/title/demo).

### 7. `.env.local` (user-owned)

No code change needed. Optionally remove the stale `ANTHROPIC_API_KEY` line after migration verifies. `GOOGLE_GENERATIVE_AI_API_KEY` is already present.

## Reused existing code (do NOT re-implement)

- `src/lib/convex-client.ts` — Convex HTTP client, unchanged.
- `src/features/conversations/inngest/tools/*.ts` — all 8 file-manipulation tools. These are defined via agent-kit's tool API which is model-agnostic; they just get handed to `createAgent`.
- `CODING_AGENT_SYSTEM_PROMPT` / `TITLE_GENERATOR_SYSTEM_PROMPT` in `src/features/conversations/inngest/constants.ts` — system prompts work as-is; no Claude-specific phrasing to rewrite.
- `src/features/conversations/inngest/process-message.ts` cancellation / retry / `onFailure` logic — unchanged.

## Verification

1. **Install step.** After `package.json` edit: `npm install` → confirm `node_modules/@ai-sdk/anthropic` is removed and `npm run lint` passes.
2. **Build + typecheck.** `npm run build` — catches any type mismatch in the new `defaultParameters` shape (especially `maxOutputTokens` vs `max_tokens`). If the Gemini adapter's `Partial<AiAdapter.Input<AiModel>>` rejects `maxOutputTokens`, drop `defaultParameters` entirely for the affected call — it's optional.
3. **Dev smoke test end-to-end** (`npm run dev` + `npx convex dev` in parallel):
   - Open a project, create a conversation, send a message like *"create a simple express hello-world app"*. Confirm: (a) title auto-generates (title-generator path), (b) files appear in the tree (coding-agent + tools path), (c) the assistant message ends with a final text summary — this validates the router invariant for Gemini, step 3's bug risk.
   - Open any file, type a partial line — confirm ghost-text suggestion appears (`/api/suggestion` path).
   - Select code, trigger quick-edit with an instruction — confirm it replaces the selection (`/api/quick-edit` path).
4. **Cancellation still works.** While the coding agent is running, send another message — verify the in-flight one is cancelled and the new one proceeds (Inngest `message/cancel` path, unchanged by migration but worth re-confirming).
5. **Inngest dashboard check.** Run `npx inngest-cli@latest dev` locally or check Inngest cloud — confirm no function failures and that Gemini requests succeed (look for 200s from `generativelanguage.googleapis.com`).
6. **Cost sanity check.** After a few test runs, confirm token usage in Google AI Studio console is landing on the expected model tiers (Flash vs Flash-Lite per call-site).

## Rollback

If the coding agent's quality is noticeably worse with `gemini-2.5-flash`, the one-line fallback is to bump **only that call-site** to `gemini-2.5-pro` (still ~12× cheaper than Opus). The other four call-sites are simple enough that Flash / Flash-Lite are safe.
