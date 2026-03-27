/**
 * Model resolution for subagent spawning.
 *
 * Resolves model references (shorthand or fully-qualified) against the set of
 * available models in the parent session's model registry. Ensures subagents
 * never get spawned with an unsupported model.
 */

/** Minimal model info needed for resolution. */
export interface ModelInfo {
  provider: string;
  id: string;
}

export interface ResolvedModel {
  /** Canonical form: "provider/modelId" */
  canonical: string;
  provider: string;
  modelId: string;
}

export interface ModelResolutionError {
  error: string;
  suggestions?: string[];
}

export type ModelResolutionResult =
  | { ok: true; model: ResolvedModel; thinkingSuffix?: string }
  | { ok: false; error: string; suggestions?: string[] };

/** Valid thinking levels that can appear as :suffix */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Split a model reference into the model part and an optional :thinking suffix.
 *
 * Model IDs can contain colons (e.g., OpenRouter models), so we only strip the
 * last segment if it's a recognized thinking level.
 */
export function splitThinkingSuffix(ref: string): { modelRef: string; thinkingSuffix?: string } {
  const lastColon = ref.lastIndexOf(":");
  if (lastColon === -1) return { modelRef: ref };

  const suffix = ref.slice(lastColon + 1);
  if (THINKING_LEVELS.has(suffix)) {
    return { modelRef: ref.slice(0, lastColon), thinkingSuffix: suffix };
  }
  return { modelRef: ref };
}

/**
 * Check if a reference is in provider/modelId format.
 */
function isQualified(ref: string): boolean {
  return ref.includes("/");
}

/**
 * Resolve a model reference for subagent spawning.
 *
 * Resolution logic:
 *
 * 1. If modelRef is provided:
 *    a. Strip :thinking suffix if present
 *    b. If "provider/modelId" format → validate against available models
 *    c. If bare "modelId" → find all matching models
 *       - Unique match → use it
 *       - Ambiguous → error listing the qualified forms
 *       - No match → error with suggestions (fuzzy)
 *
 * 2. If no modelRef, use currentModel (inherit parent session model)
 *
 * 3. If no currentModel either, return null (let pi pick its default)
 */
export function resolveModelForSubagent(
  modelRef: string | undefined,
  availableModels: ModelInfo[],
  currentModel: ModelInfo | undefined,
): ModelResolutionResult | null {
  // No model specified → inherit from parent session
  if (modelRef === undefined || modelRef === null) {
    if (!currentModel) return null; // Let pi use its default
    return {
      ok: true,
      model: {
        canonical: `${currentModel.provider}/${currentModel.id}`,
        provider: currentModel.provider,
        modelId: currentModel.id,
      },
    };
  }

  // Parse out thinking suffix
  const { modelRef: cleanRef, thinkingSuffix } = splitThinkingSuffix(modelRef);

  if (isQualified(cleanRef)) {
    // Fully qualified: "provider/modelId"
    const slashIdx = cleanRef.indexOf("/");
    const provider = cleanRef.slice(0, slashIdx);
    const modelId = cleanRef.slice(slashIdx + 1);

    const match = availableModels.find(
      (m) => m.provider === provider && m.id === modelId,
    );

    if (match) {
      return {
        ok: true,
        model: { canonical: `${provider}/${modelId}`, provider, modelId },
        thinkingSuffix,
      };
    }

    // Not found — try to suggest close matches
    const sameProvider = availableModels
      .filter((m) => m.provider === provider)
      .map((m) => `${m.provider}/${m.id}`);

    const sameId = availableModels
      .filter((m) => m.id === modelId)
      .map((m) => `${m.provider}/${m.id}`);

    const suggestions = [...new Set([...sameId, ...sameProvider.slice(0, 5)])];

    return {
      ok: false,
      error: `Model "${cleanRef}" not found in available models.`,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  // Bare model ID — find all matches
  const exactMatches = availableModels.filter((m) => m.id === cleanRef);

  if (exactMatches.length === 1) {
    const m = exactMatches[0];
    return {
      ok: true,
      model: { canonical: `${m.provider}/${m.id}`, provider: m.provider, modelId: m.id },
      thinkingSuffix,
    };
  }

  if (exactMatches.length > 1) {
    const qualified = exactMatches.map((m) => `${m.provider}/${m.id}`);
    return {
      ok: false,
      error: `Ambiguous model "${cleanRef}" — found in ${exactMatches.length} providers. Use the fully qualified form.`,
      suggestions: qualified,
    };
  }

  // No exact match — try substring/fuzzy matching
  const substringMatches = availableModels.filter(
    (m) => m.id.includes(cleanRef) || cleanRef.includes(m.id),
  );

  if (substringMatches.length === 1) {
    const m = substringMatches[0];
    return {
      ok: true,
      model: { canonical: `${m.provider}/${m.id}`, provider: m.provider, modelId: m.id },
      thinkingSuffix,
    };
  }

  // Gather suggestions from substring matches or all available
  const suggestions = substringMatches.length > 0
    ? substringMatches.map((m) => `${m.provider}/${m.id}`).slice(0, 8)
    : availableModels
        .map((m) => `${m.provider}/${m.id}`)
        .filter((c) => levenshteinSimilar(cleanRef, c.split("/")[1]))
        .slice(0, 8);

  return {
    ok: false,
    error: `Model "${cleanRef}" not found in available models.`,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}

/**
 * Quick check: is the Levenshtein distance small enough to be a likely typo?
 * Used only for generating suggestions, not for resolution.
 */
function levenshteinSimilar(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 3) return false;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;

  // Simple character-level similarity: count common characters
  const setA = new Set(a);
  const setB = new Set(b);
  let common = 0;
  for (const ch of setA) {
    if (setB.has(ch)) common++;
  }
  return common / Math.max(setA.size, setB.size) > 0.5;
}

/**
 * Format a resolution error into a human-readable message for tool output.
 */
export function formatResolutionError(result: Extract<ModelResolutionResult, { ok: false }>): string {
  let msg = result.error;
  if (result.suggestions && result.suggestions.length > 0) {
    msg += "\n\nAvailable matches:\n" + result.suggestions.map((s) => `  • ${s}`).join("\n");
  }
  return msg;
}
