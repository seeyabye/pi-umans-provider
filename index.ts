/**
 * UMANS Provider Extension
 *
 * Registers UMANS (code.umans.ai) as a custom provider using the
 * openai-completions API. Base URL: https://api.code.umans.ai/v1
 *
 * UMANS provides subscription-based access to coding-optimized models.
 * All models support tool use. Reasoning is controlled via `reasoning_effort`
 * and surfaced in a `reasoning_content` field (DeepSeek-style response field).
 *
 * Key API details:
 *   - Reasoning via `reasoning_effort` (none/low/medium/high; minimal/xhigh accepted and mapped to nearest). Default thinking level: `medium`.
 *   - All reasoning models return `reasoning_content` (parsed regardless of thinking format).
 *   - `max_completion_tokens` (and `max_tokens`) are both honored on the OpenAI route; default `max_completion_tokens` is used.
 *   - Developer role is NOT supported (use system role instead)
 *   - Subscription-based: $0 per-token cost
 *   - `umans-flash-beta` is deprecated (sunset 2026-06-07, use `umans-flash`)
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /v1/models/info → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "umans": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 2: Set as environment variable
 *   export UMANS_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-umans-provider
 *
 * @see https://code.umans.ai
 */

import { getAgentDir, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import fs from "fs";
import path from "path";

// ─── Usage/Plan Types ────────────────────────────────────────────────────────

const USAGE_API_URL = "https://api.code.umans.ai/v1/usage";
const USAGE_FETCH_TIMEOUT_MS = 5000;
const USAGE_THROTTLE_MS = 30_000;
const END_SETTLE_MS = 2000;
const IDLE_POLL_MS = 45_000;

let sessionPlan: string | null = null;
let sessionConcurrency: number | null = null;
let sessionOthers: number | null = null;
let activeStreams = 0;
let sessionRequestsInWindow: number | null = null;
let sessionRemainingRequests: number | null = null;
let lastUsageFetchTime = 0;
let usageFetchInFlight = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let endFetchTimer: ReturnType<typeof setTimeout> | null = null;

interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

async function loginUmans(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const apiKey = await callbacks.onPrompt({
    message: "Enter your Umans API key (starts with sk-):",
  });
  const key = apiKey.trim();
  if (!key.startsWith("sk-")) {
    throw new Error("Invalid API key: must start with 'sk-'");
  }
  // API keys don't expire — use a far-future timestamp to prevent unnecessary refresh attempts
  return { refresh: key, access: key, expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000 };
}

function refreshUmansToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return Promise.resolve(credentials);
}

function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template" | "deepseek";
    supportsReasoningEffort?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// Models returned by /v1/models/info
interface UmansModelInfo {
  name: string;
  display_name?: string;
  description?: string;
  base_model?: { name: string; provider?: string; oss_base?: string; family?: string };
  capabilities?: {
    max_completion_tokens?: number;
    recommended_max_tokens?: number;
    context_window?: number;
    supports_vision?: boolean | string;
    supports_tools?: boolean;
  };
  deprecation?: { sunset_date: string; replacement: string };
  benchmarks?: Record<string, unknown>;
}

type UmansModelsInfoResponse = Record<string, UmansModelInfo>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  for (const model of base) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "umans";
const BASE_URL = "https://api.code.umans.ai/v1";
const MODELS_INFO_URL = `${BASE_URL}/models/info`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

const DEPRECATED_MODELS = new Set(["umans-flash-beta"]);

/** Transform a model from the UMANS /v1/models/info API. */
function transformApiModel(id: string, info: UmansModelInfo): JsonModel | null {
  if (info.deprecation || DEPRECATED_MODELS.has(id)) return null;

  const caps = info.capabilities || {};
  const hasVision = caps.supports_vision === true;

  return {
    id,
    name: info.display_name || info.name || id,
    reasoning: true,
    input: hasVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: caps.context_window || 131072,
    maxTokens: caps.recommended_max_tokens || caps.max_completion_tokens || 65000,
  };
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_INFO_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal])
        : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as UmansModelsInfoResponse;
    if (!data || typeof data !== "object") return null;
    const models = Object.entries(data)
      .map(([id, info]) => transformApiModel(id, info))
      .filter((m): m is JsonModel => m !== null);
    if (models.length === 0) return null;
    return models;
  } catch {
    return null;
  }
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      // Self-heal: live API pricing is authoritative field-by-field. Prefer the
      // live cost when the API reports it (non-zero); fall back to embedded when
      // the API is silent (0) so curated cacheRead/cacheWrite isn't clobbered and
      // providers whose /models endpoint exposes no pricing keep their curated
      // cost. Curation (reasoning/input/compat/name) still wins via ...embedded.
      result.push({
        ...liveModel,
        ...embedded,
        cost: {
          input: liveModel.cost.input || embedded.cost.input,
          output: liveModel.cost.output || embedded.cost.output,
          cacheRead: liveModel.cost.cacheRead || embedded.cost.cacheRead,
          cacheWrite: liveModel.cost.cacheWrite || embedded.cost.cacheWrite,
        },
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  const cachedMap = new Map(cached.map((m) => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(
  apiKey: string | undefined,
  embeddedModels: JsonModel[],
  signal?: AbortSignal,
): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution ────────────────────────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;
// Aborted on session replacement/shutdown so in-flight usage fetches from
// timers don't resolve against a stale ctx (the timer handle itself can't be
// clearTimeout'd once the async callback has already fired).
let usageAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = (await modelRegistry.getApiKeyForProvider("umans")) ?? undefined;
}

// ─── Usage/Plan Footer ────────────────────────────────────────────────────────

interface UmansUsage {
  user_id?: string;
  plan: { slug: string; display_name: string };
  limits: {
    requests: { limit: number | null; window_seconds: number; description: string };
    concurrency: { limit: number; description: string };
  };
  usage: {
    requests_in_window: number;
    weighted_in_window?: number;
    remaining_requests: number | null;
    weighted_remaining_requests?: number | null;
    concurrent_sessions: number;
    weighted_concurrent_sessions?: number;
    tokens_in?: number;
    tokens_out?: number;
    tokens_cached?: number;
  };
  window?: {
    started_at?: string;
    resets_at?: string;
    remaining_minutes?: number;
  };
}

async function fetchUsage(
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<UmansUsage | null> {
  if (!apiKey) return null;
  try {
    const response = await fetch(USAGE_API_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS), signal])
        : AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as UmansUsage;
    if (!data.plan?.slug) return null;
    return data;
  } catch {
    return null;
  }
}

function applyUsage(usage: UmansUsage, ctx: any): void {
  sessionPlan = usage.plan.display_name;
  sessionConcurrency = usage.limits?.concurrency?.limit ?? null;
  // Only adopt the server's concurrent count as our idle baseline when we're
  // not streaming — otherwise it already includes us and would double-count
  // against activeStreams in the display.
  if (activeStreams === 0) {
    sessionOthers = usage.usage.concurrent_sessions ?? 0;
  }
  sessionRequestsInWindow = usage.usage.requests_in_window ?? null;
  sessionRemainingRequests = usage.usage.remaining_requests ?? null;
  updateUsageStatus(ctx);
  if (activeStreams === 0) {
    resetIdleTimer(ctx);
  }
}

// Throttled fetch — skips if one is in flight or if the last successful fetch
// was within USAGE_THROTTLE_MS. Returns null on skip, caller checks.
async function throttledFetchUsage(
  apiKey: string | undefined,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<UmansUsage | null> {
  const now = Date.now();
  const { force = false, signal } = options ?? {};
  if (!force && (usageFetchInFlight || now - lastUsageFetchTime < USAGE_THROTTLE_MS)) {
    return null;
  }
  usageFetchInFlight = true;
  try {
    const usage = await fetchUsage(apiKey, signal);
    if (usage) {
      lastUsageFetchTime = now;
    }
    return usage;
  } finally {
    usageFetchInFlight = false;
  }
}

function updateUsageStatus(ctx: any): void {
  // Defensive: a stale ctx (post session replacement/reload) throws on access.
  // Never let a timer-driven status refresh take down the process.
  let model: any;
  try {
    model = ctx.model;
  } catch {
    return;
  }
  if (model?.provider !== "umans") {
    try { ctx.ui.setStatus("umans-usage", undefined); } catch {}
    return;
  }
  if (!sessionPlan) {
    try { ctx.ui.setStatus("umans-usage", undefined); } catch {}
    return;
  }
  const parts: string[] = [sessionPlan];
  if (sessionConcurrency != null) {
    parts.push(`\u27e0 ${(sessionOthers ?? 0) + activeStreams}/${sessionConcurrency}`);
  }
  if (sessionRemainingRequests != null) {
    parts.push(`\u21c4 ${sessionRemainingRequests}`);
  }
  try {
    ctx.ui.setStatus("umans-usage", ctx.ui.theme.fg("dim", parts.join(" | ")));
  } catch {}
}

function clearUsageStatus(ctx: any): void {
  try { ctx.ui.setStatus("umans-usage", undefined); } catch {}
  sessionPlan = null;
  sessionConcurrency = null;
  sessionOthers = null;
  activeStreams = 0;
  sessionRequestsInWindow = null;
  sessionRemainingRequests = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (endFetchTimer) {
    clearTimeout(endFetchTimer);
    endFetchTimer = null;
  }
}

// Light idle poll: refresh the server baseline (others) while nothing is
// streaming, so the optimistic +active sits on a fresh base. Self-rearming.
function resetIdleTimer(ctx: any): void {
  if (idleTimer) clearTimeout(idleTimer);
  const signal = usageAbort?.signal;
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    // Skip while streaming — the optimistic value is in effect and agent_settled
    // will reconcile with a real fetch.
    if (activeStreams > 0) return;
    if (signal?.aborted) return;
    const usage = await throttledFetchUsage(cachedApiKey, { signal });
    if (!usage || signal?.aborted) return;
    applyUsage(usage, ctx);
  }, IDLE_POLL_MS);
}

// After agent_settled the server still counts our session for a brief lag. Wait
// it out, then take a clean idle baseline and re-arm the idle poll.
function scheduleEndFetch(ctx: any): void {
  if (endFetchTimer) clearTimeout(endFetchTimer);
  const signal = usageAbort?.signal;
  endFetchTimer = setTimeout(async () => {
    endFetchTimer = null;
    if (signal?.aborted) return;
    const usage = await throttledFetchUsage(cachedApiKey, { force: true, signal });
    if (!usage || signal?.aborted) return;
    applyUsage(usage, ctx);
  }, END_SETTLE_MS);
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("umans", {
    baseUrl: BASE_URL,
    apiKey: "$UMANS_API_KEY",
    api: "openai-completions",
    models: staleModels,
    oauth: {
      name: "Umans AI (API Key)",
      login: loginUmans,
      refreshToken: refreshUmansToken,
      getApiKey: getApiKey,
    },
  });

  function isUmansModel(ctx: any): boolean {
    return ctx.model?.provider === "umans";
  }

  pi.on("before_provider_request", async (event) => {
    const p = event.payload as Record<string, any>;
    const model: string = p.model ?? "";
    if (!model.startsWith("umans-")) return;

    const messages = p.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const toolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id);
        }
      }
    }

    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id);
      }
    }

    const orphanedIds = [...toolCallIds].filter((id) => !toolResultIds.has(id));
    if (orphanedIds.length === 0) return;

    const newMessages = [...messages];
    let insertOffset = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;

      const orphanedCalls = msg.tool_calls.filter((tc: any) =>
        orphanedIds.includes(tc.id),
      );
      if (orphanedCalls.length === 0) continue;

      const insertIdx = i + insertOffset + 1;
      const syntheticResults = orphanedCalls.map((tc: any) => ({
        role: "tool",
        tool_call_id: tc.id,
        content: "[tool result was lost during context compaction]",
      }));

      newMessages.splice(insertIdx, 0, ...syntheticResults);
      insertOffset += orphanedCalls.length;
    }

    p.messages = newMessages;
    return p;
  });

  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    // Cancel any usage fetches/timers still running from a prior session —
    // their captured ctx is now stale.
    usageAbort?.abort();
    usageAbort = new AbortController();
    const signal = revalidateAbort.signal;
    resolveApiKey(ctx.modelRegistry).then(async () => {
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider("umans", {
            baseUrl: BASE_URL,
            apiKey: "$UMANS_API_KEY",
            api: "openai-completions",
            models: buildModels(freshBase, customModels, patches),
          });
        }
      });

      if (!isUmansModel(ctx)) {
        clearUsageStatus(ctx);
        return;
      }

      const usage = await throttledFetchUsage(cachedApiKey, { force: true, signal });
      if (usage && !signal.aborted) {
        applyUsage(usage, ctx);
      }
    });
  });

  pi.on("model_select", (event, ctx) => {
    if (event.model?.provider === "umans") {
      throttledFetchUsage(cachedApiKey, { force: true }).then((usage) => {
        if (usage) {
          applyUsage(usage, ctx);
        } else {
          updateUsageStatus(ctx);
        }
      });
    } else {
      clearUsageStatus(ctx);
    }
  });

  // Optimistic +1: the moment our agent starts, we know the real concurrent
  // count is at least (others + 1). No API call — the server has a ~2s
  // registration lag, so fetching now would undercount us anyway. One span
  // per prompt (agent_start → agent_settled), so no flicker between tool turns.
  pi.on("agent_start", async (_event, ctx) => {
    if (!isUmansModel(ctx)) return;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    activeStreams++;
    updateUsageStatus(ctx);
  });

  // Turn ended: drop our optimistic +1 and reconcile with the server after a
  // short settle so the server has dropped our session from its count.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!isUmansModel(ctx)) return;
    activeStreams = Math.max(0, activeStreams - 1);
    updateUsageStatus(ctx);
    scheduleEndFetch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateUsageStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
    usageAbort?.abort();
    usageAbort = null;
    activeStreams = 0;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (endFetchTimer) {
      clearTimeout(endFetchTimer);
      endFetchTimer = null;
    }
  });
}
