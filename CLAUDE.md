# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Polaris — an in-browser AI coding assistant / IDE. Users manage projects whose files live in Convex; an AI agent (the "Polaris" agent) reads and mutates those files through tool calls; a WebContainer runs the project for live preview.

## Commands

- `npm run dev` — Next.js dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run start` — run production build
- `npm run lint` — ESLint (flat config at `eslint.config.mjs`, extends `eslint-config-next`)
- `npx convex dev` — start the Convex backend in watch mode; must be running alongside `next dev` for the app to work. It also regenerates `convex/_generated/*`.
- `npx convex deploy` — deploy Convex functions.

There is no test runner configured in this repo.

## Required environment (`.env.local`)

- `NEXT_PUBLIC_CONVEX_URL` — Convex deployment URL (used by both browser and server clients).
- `CLERK_JWT_ISSUER_DOMAIN` — set on the **Convex** deployment (referenced in `convex/auth.config.ts`), not the Next.js process.
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — Clerk.
- `POLARIS_CONVEX_INTERNAL_KEY` — shared secret gating `convex/system.ts` mutations (see auth model below). Must be set **identically** in both Next.js env and Convex env.
- `GOOGLE_GENERATIVE_AI_API_KEY`, `FIRECRAWL_API_KEY` — AI and URL-scraping providers.
- Inngest signing key / event key for production.

## Architecture

### Three-process topology

1. **Next.js app (App Router, React 19)** — UI, API routes, auth middleware.
2. **Convex** (`convex/`) — the database of record. Holds `projects`, `files`, `conversations`, `messages` (schema in `convex/schema.ts`). The React app subscribes via `ConvexProviderWithClerk`; most UI state comes from live `useQuery` calls, not local state.
3. **Inngest** (`src/inngest/`, served at `/api/inngest`) — durable background jobs. All long-running AI work (message processing, GitHub import/export) runs here so HTTP handlers stay fast and work survives restarts.

### Two auth paths into Convex — this is important

Convex functions run under two distinct trust models; mixing them up causes silent data access bugs.

- **User-authenticated path** (`convex/auth.ts` → `verifyAuth(ctx)`) — used by `projects.ts`, `files.ts`, `conversations.ts`. Called from the browser via `ConvexReactClient` with Clerk JWTs. Each handler re-checks `project.ownerId === identity.subject`.
- **Internal/system path** (`convex/system.ts` → `validateInternalKey`) — used by Inngest functions and Next.js route handlers (via `ConvexHttpClient` in `src/lib/convex-client.ts`). These have no user identity; they prove trust by passing `POLARIS_CONVEX_INTERNAL_KEY` as an argument. When writing a new server-side mutation that an Inngest function or API route needs, add it to `convex/system.ts`, not the user-facing files.

### Request → AI work lifecycle

Chat messages flow: `POST /api/messages` → creates user + placeholder assistant `messages` rows via `system.createMessage` → sends `message/sent` Inngest event → `processMessage` (in `src/features/conversations/inngest/process-message.ts`) runs the `@inngest/agent-kit` network → agent calls file tools in `src/features/conversations/inngest/tools/*` which mutate Convex → assistant message is updated with final text (status `completed`). Cancellation goes through `POST /api/messages/cancel` which emits `message/cancel`; `processMessage` declares `cancelOn` so Inngest terminates the run mid-flight.

The agent-kit **network router** in `processMessage` has a subtle invariant: Gemini (via agent-kit's adapter) emits text and tool calls in the same turn, so the router only terminates when the last result has text **without** tool calls. Loosening this check will cut responses off early.

### GitHub import/export

`src/features/projects/inngest/import-github-repo.ts` and `export-to-github.ts` are long-running Inngest flows that walk the repo tree with Octokit and sync against Convex `files`. Status on the `projects` row (`importStatus`, `exportStatus`) is the source of truth the UI polls. Binary files are stored in Convex `_storage` (field `storageId`); text files inline (`content`). Respect this split when touching file mutations.

### Files: tree model

`files` table is an adjacency-list tree (`parentId` self-reference). `type: "folder" | "file"`. Root items have no `parentId`. The file explorer and AI tools both rely on `parentId === undefined` meaning "root", and the AI agent's prompt in `src/features/conversations/inngest/constants.ts` explicitly tells it to pass empty string for root — if changing the tool schema, keep this contract aligned with the system prompt.

### Editor stack

- CodeMirror 6 (`src/features/editor/`) with custom extensions under `extensions/`.
- `suggestion/` — inline Copilot-style completions via `POST /api/suggestion` (Gemini 2.5 Flash-Lite, structured output).
- `quick-edit/` — selection-based rewrite via `POST /api/quick-edit` (Gemini 2.5 Flash, structured output, with Firecrawl URL scraping from the instruction).
- Tab state is a per-project Zustand store (`src/features/editor/store/use-editor-store.ts`) with a VS Code–style preview-tab concept: single-click opens as preview (replaces the existing preview slot); double-click or edit pins it.

### Preview: WebContainer

`src/features/preview/hooks/use-webcontainer.ts` boots a **singleton** `WebContainer` (module-level refs `webcontainerInstance`, `bootPromise`). Only one can exist per page. It requires cross-origin isolation headers, which is why `next.config.ts` sets `Cross-Origin-Embedder-Policy: credentialless` and `Cross-Origin-Opener-Policy: same-origin` globally — don't remove those headers. Files are mirrored from the Convex `files` table into the container via `src/features/preview/utils/file-tree.ts`.

### Auth middleware filename

This project uses Next.js 16, where the old `middleware.ts` convention is renamed to `proxy.ts` (`src/proxy.ts`). Edit that file for Clerk middleware / route protection — there is no `middleware.ts`.

### Convex generated code

`convex/_generated/*` is committed but auto-generated by `npx convex dev`. Don't hand-edit. If `api`/`dataModel` imports look stale after schema changes, re-run convex dev.

### Path alias

`@/*` → `src/*` (see `tsconfig.json`). Prefer it over relative imports, except inside `convex/` which imports `./_generated/*` relatively.

## Conventions observed in the codebase

- shadcn/ui (New York style, `neutral` base) under `src/components/ui`. Configured in `components.json`; add components with `npx shadcn@latest add <name>`.
- Feature-first layout under `src/features/<feature>/{components,hooks,inngest,store,extensions,...}` — new feature code should follow this shape rather than going into top-level `src/components` or `src/lib`.
- AI model selection is intentional per call-site: Gemini 2.5 Flash for the coding agent and quick-edit; Gemini 2.5 Flash-Lite for inline suggestions, title generation, and the demo Inngest job. Don't unify these without reason.
- Optimistic updates on file mutations (`src/features/projects/hooks/use-files.ts`) — when adding a new file-mutating hook, follow the `withOptimisticUpdate` pattern against `api.files.getFolderContents` so the tree doesn't flicker.
