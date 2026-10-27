/**
 * Which thinking / reasoning effort levels a model accepts, asked of the
 * endpoint itself.
 *
 * Nothing lists them: `GET /models` never says, and providers add and drop
 * levels per release (gpt-5 took "minimal", a later model refuses it; one
 * takes "none", another cannot stop thinking). So `graft model` and
 * `graft effort` send one tiny request per candidate level and keep the ones
 * the endpoint answers.
 *
 * A plain request without any effort is sent first. When that fails too, the
 * failure is the endpoint's (key, URL, model, quota), not the level's, and no
 * level is judged; when it succeeds, a level whose request is then refused
 * with a 4xx is one this model does not take.
 */
import { createChatModel, type ChatModelConfig } from "./llm/factory.js";
import type { ChatModel } from "./llm/types.js";
import type { ResolvedConfig } from "./providers.js";
import { classifyLlmError, shortError } from "./llm-hints.js";

/** Accepted: the endpoint answered with it. Rejected: refused it. Unknown: could not tell. */
export type EffortVerdict = "accepted" | "rejected" | "unknown";

export interface EffortProbeResult {
  level: string;
  verdict: EffortVerdict;
  /** The endpoint's message for a rejected or unknown level. */
  detail?: string;
}

export interface EffortProbe {
  /** Set when the request without any effort already failed: nothing could be judged. */
  baselineError?: string;
  results: EffortProbeResult[];
}

/** Builds the transport for one probe request (tests inject a stub). */
export type ProbeModelFactory = (cfg: ChatModelConfig) => ChatModel;

/** Answer allowance per probe: enough for "OK", small enough to cost nothing. */
const PROBE_MAX_TOKENS = 64;

/**
 * One probe's transport: the configured model only. No model or provider
 * fallback, or a level the model refuses would be answered by the fallback
 * and read as accepted.
 */
function chatConfig(cfg: ResolvedConfig, level: string | undefined): ChatModelConfig {
  return {
    provider: cfg.provider,
    apiKey: cfg.apiKey ?? "",
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    headers: cfg.headers,
    modelHeaders: cfg.modelHeaders,
    bearerAuth: cfg.bearerAuth,
    reasoningEffort: level,
    strictEffort: true,
  };
}

async function ask(cfg: ResolvedConfig, level: string | undefined, make: ProbeModelFactory): Promise<void> {
  await make(chatConfig(cfg, level)).create({
    messages: [{ role: "user", content: "Reply with OK." }],
    maxTokens: PROBE_MAX_TOKENS,
  });
}

/** A failure that says "this request was refused", as opposed to "the endpoint is not usable". */
function isRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== "number" || status < 400 || status >= 500) return false;
  if (status === 401 || status === 403 || status === 429) return false;
  const problem = classifyLlmError(shortError(err));
  return problem !== "auth" && problem !== "unreachable" && !(problem === "model" && status === 404);
}

/**
 * Probe `levels` for `cfg.model`, all in parallel after one baseline request.
 * Never throws: every failure lands in the result.
 */
export async function probeEfforts(
  cfg: ResolvedConfig,
  levels: readonly string[],
  make: ProbeModelFactory = createChatModel,
): Promise<EffortProbe> {
  try {
    await ask(cfg, undefined, make);
  } catch (err) {
    const baselineError = shortError(err);
    return { baselineError, results: levels.map((level) => ({ level, verdict: "unknown", detail: baselineError })) };
  }
  const results = await Promise.all(
    levels.map(async (level): Promise<EffortProbeResult> => {
      try {
        await ask(cfg, level, make);
        return { level, verdict: "accepted" };
      } catch (err) {
        return { level, verdict: isRefusal(err) ? "rejected" : "unknown", detail: shortError(err) };
      }
    }),
  );
  return { results };
}

/** The levels a probe found accepted, in the order probed. */
export function acceptedEfforts(probe: EffortProbe): string[] {
  return probe.results.filter((r) => r.verdict === "accepted").map((r) => r.level);
}
