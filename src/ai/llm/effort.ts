/**
 * Thinking / reasoning effort levels: the names graft accepts, how a typed
 * value is normalized, and which levels to offer for a model.
 *
 * Kept free of every other graft module so the config resolver can import it
 * without a cycle. Which levels a model ACCEPTS is not known from its name —
 * providers add and drop levels per release — so {@link candidateEfforts} only
 * says what to ask about; `graft effort` probes the endpoint to find out
 * (src/ai/llm-effort.ts).
 *
 * Wire mapping: the OpenAI-compatible wire sends the level as
 * `reasoning_effort`, the Anthropic wire as `output_config.effort`.
 */

/** The environment variable `graft effort` saves and `graft build --deep` reads. */
export const REASONING_EFFORT_ENV = "GRAFT_REASONING_EFFORT";

/**
 * The level `graft build --deep` asks for while GRAFT_REASONING_EFFORT is not
 * set, on every model. Only where the model takes it: a model that refuses it
 * runs at its own default, quietly (see `effortOptional` in the adapters).
 * GRAFT_REASONING_EFFORT=default sends no effort at all.
 */
export const DEFAULT_REASONING_EFFORT = "high";

/** The value saved to mean "send no effort: the model's own default". */
export const MODEL_DEFAULT_EFFORT = "default";

/**
 * Extra output tokens to allow for reasoning at `level` on the OpenAI-compatible
 * wire, where reasoning tokens count against `max_tokens`: without it a 2,048
 * cap at "high" can be spent on thinking before any answer is written.
 */
export function reasoningTokenAllowance(level: string): number {
  switch (level) {
    case "none":
    case "minimal":
      return 0;
    case "low":
      return 2048;
    case "medium":
      return 4096;
    case "xhigh":
    case "max":
      return 16384;
    default:
      return 8192;
  }
}

/** Every level graft knows, lowest first. */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const DESCRIPTIONS: Record<string, string> = {
  none: "no thinking — fastest and cheapest",
  minimal: "barely any thinking",
  low: "light thinking — fast, cheap",
  medium: "balanced",
  high: "thorough thinking — slower, more output tokens",
  xhigh: "extra-high thinking",
  max: "the most thinking the model allows",
};

/** Spellings people type for a level, mapped to the name the APIs take. */
const ALIASES: Record<string, string> = {
  off: "none",
  disabled: "none",
  min: "minimal",
  med: "medium",
  "x-high": "xhigh",
  x_high: "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  extrahigh: "xhigh",
  maximum: "max",
};

/** Values that mean "no setting: let the model use its own default". */
const DEFAULT_WORDS = new Set(["", "default", "auto", "unset"]);

/**
 * The level `raw` names, lower-cased and with aliases resolved, or undefined
 * when it means "the model's default". A name graft does not know is kept as
 * typed: a provider may add a level before graft learns it, and the endpoint
 * is the judge (the probe, or a warning at build time).
 */
export function normalizeEffort(raw: string | undefined): string | undefined {
  const v = raw?.trim().toLowerCase() ?? "";
  if (DEFAULT_WORDS.has(v)) return undefined;
  return ALIASES[v] ?? v;
}

/** A syntactically valid level name (whether or not graft knows it). */
export function isEffortName(level: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(level);
}

/** One-line description of a level, for lists and prompts. */
export function describeEffort(level: string): string {
  return DESCRIPTIONS[level] ?? "level not known to graft";
}

/** Sort levels lowest first; unknown names go last, in the order given. */
export function sortEfforts(levels: readonly string[]): string[] {
  const rank = (l: string) => {
    const i = (EFFORT_LEVELS as readonly string[]).indexOf(l);
    return i < 0 ? EFFORT_LEVELS.length : i;
  };
  return [...new Set(levels)].sort((a, b) => rank(a) - rank(b));
}

/**
 * The levels worth asking `model` about, lowest first. Families differ —
 * OpenAI's o-series takes low…high, the gpt-5 line adds none/minimal and later
 * xhigh, Gemini's OpenAI-compatible API takes none…high, Claude takes
 * low…max — and gateways rename models, so an unknown family gets every level.
 */
export function candidateEfforts(model: string, wire: "openai" | "anthropic"): string[] {
  const id = (model.slice(model.lastIndexOf("/") + 1) || model).toLowerCase().replace(/^databricks-/, "");
  if (wire === "anthropic" || /claude/.test(id)) return ["low", "medium", "high", "xhigh", "max"];
  if (/^o\d/.test(id)) return ["low", "medium", "high"];
  if (/^gpt-?[5-9]/.test(id)) return ["none", "minimal", "low", "medium", "high", "xhigh"];
  if (/gemini/.test(id)) return ["none", "minimal", "low", "medium", "high"];
  if (/deepseek|qwen|glm|kimi|grok|mistral|magistral/.test(id)) return ["none", "low", "medium", "high"];
  return [...EFFORT_LEVELS];
}
