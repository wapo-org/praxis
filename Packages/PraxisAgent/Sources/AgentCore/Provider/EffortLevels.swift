import Foundation

/// Per-model reasoning effort levels: mapping provider names onto the app's
/// `Effort`, clamping outgoing wire values, and recognizing effort
/// rejections so unknown models are learned like images/tools are.
///
/// What each list exposes (researched 2026-10-28, see the wave-2 effort
/// report for URLs):
/// - OpenRouter `GET /api/v1/models`: per-model `reasoning` object with
///   `supported_efforts` (descending; null = all gateway values; omitted =
///   no effort selection), `default_effort`, `mandatory`. `none` is never
///   sent (the dial has no "off"); `mandatory` models simply never see it.
/// - OpenAI `/v1/models`: id/owner only, no capability info. `reasoning_effort`
///   (Chat Completions) takes model-dependent values from
///   none/minimal/low/medium/high/xhigh/max. Unknown until a request fails.
/// - Anthropic `/v1/models`: `capabilities.effort` with `supported` plus a
///   per-level flag for low/medium/high/xhigh/max. `output_config.effort`
///   takes those same five values.
/// - LM Studio native `GET /api/v1/models` (not the OpenAI-compat list the
///   app reads): `capabilities.reasoning.allowed_options` from
///   off/on/low/medium/high. Ollama native `/api/show`: a `capabilities`
///   name list that may contain `thinking`. The parser understands both
///   shapes if a server ever includes them; over the OpenAI-compat list
///   both servers are names-only, hence unknown.
public enum EffortLevels {
    /// Weakest to strongest. Covers the OpenAI, Anthropic and OpenRouter
    /// gateway vocabularies; LM Studio `on`/`off` are toggles, not levels.
    public static let canonicalOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

    /// Levels for an OpenAI-flavor list that says "reasoning supported"
    /// but names no levels: the o-series / GPT-5 common denominator.
    public static let openAIFamilyDefault = ["low", "medium", "high"]

    /// Levels for an Anthropic-flavor list that says "reasoning supported"
    /// but names no levels (in practice Anthropic always sends per-level
    /// flags; this covers older entries).
    public static let anthropicFamilyDefault = ["low", "medium", "high"]

    /// All OpenRouter gateway effort values, descending, for a `reasoning`
    /// object whose `supported_efforts` is explicitly null (the docs: all
    /// gateway values are then accepted).
    public static let openRouterGatewayAll = ["max", "xhigh", "high", "medium", "low", "minimal", "none"]

    /// Maps provider raw level names onto the app's `Effort`, weakest
    /// first, deduplicated. `none` (reasoning off) and unknown names map to
    /// nothing — the dial has no "off". `minimal` folds to `.low` and
    /// `xhigh` to `.max`; the wire value is clamped separately (`clamp`),
    /// so a folded level still sends a value the model accepts.
    public static func map(_ raw: [String]) -> [Effort] {
        var out: [Effort] = []
        for name in raw {
            guard let level = mapOne(name), !out.contains(level) else { continue }
            out.append(level)
        }
        return out.sorted { rank($0) < rank($1) }
    }

    private static func mapOne(_ name: String) -> Effort? {
        switch name.lowercased() {
        case "low": return .low
        case "minimal": return .low
        case "medium", "med": return .medium
        case "high": return .high
        case "xhigh", "extra_high", "extra-high": return .max
        case "max": return .max
        default: return nil // "none", "off", "on", "auto", unknown
        }
    }

    private static func rank(_ effort: Effort) -> Int {
        switch effort {
        case .low: return 0
        case .medium: return 1
        case .high: return 2
        case .max: return 3
        }
    }

    /// Nearest level to `want` within `supported`. Ties prefer the lower
    /// level (a fallback reduces, never escalates). Nil when empty.
    public static func nearest(to want: Effort, in supported: [Effort]) -> Effort? {
        supported.min {
            let a = abs(rank($0) - rank(want)), b = abs(rank($1) - rank(want))
            return a == b ? rank($0) < rank($1) : a < b
        }
    }

    /// Clamps a would-be wire value to the model's supported wire values.
    /// - Nil (unknown): the value goes out unchanged — today's behaviour.
    /// - Empty (no reasoning): nil — the caller drops the parameter.
    /// - Listed: the value, when the model takes it.
    /// - Otherwise the nearest by `canonicalOrder` (ties prefer lower).
    ///   A custom value with no canonical rank (e.g. a user-configured
    ///   `maxEffortValue` the model doesn't list) can't be placed, so the
    ///   parameter is dropped rather than risking a 400.
    public static func clamp(_ value: String, to supported: [String]?) -> String? {
        guard let supported else { return value }
        guard !supported.isEmpty else { return nil }
        // The list's own spelling: wire values are case-sensitive.
        if let match = supported.first(where: { $0.lowercased() == value.lowercased() }) { return match }
        guard let want = canonicalOrder.firstIndex(of: value.lowercased()) else { return nil }
        var best: String?
        var bestDistance = Int.max
        for candidate in supported {
            guard let rank = canonicalOrder.firstIndex(of: candidate.lowercased()) else { continue }
            let distance = abs(rank - want)
            // Ties prefer the lower level; equally, prefer the list's own
            // spelling (canonical names compare case-insensitively).
            if distance < bestDistance || (distance == bestDistance && rank < want) {
                bestDistance = distance
                best = candidate
            }
        }
        return best
    }

    /// Starting levels for narrowing when a model of unknown support
    /// rejects a value: everything sendable, weakest first. (`none` is left
    /// out: the dial has no "off", so it is never sent.)
    public static let unknownBaseline = ["minimal", "low", "medium", "high", "xhigh", "max"]

    /// Narrows known levels after the provider rejects the sent value.
    /// Support is a contiguous range, so a rejection moves one edge: a value
    /// at or below the weakest known level raises the floor (drop it and
    /// everything weaker), anything else drops the ceiling (drop it and
    /// everything stronger — a model that turns down `xhigh` won't take
    /// `max` either; Anthropic's own "Use effort 'high' or below" wording).
    /// An unranked rejected name removes only itself; unranked known levels
    /// (toggles like `on`) are always kept.
    public static func narrow(_ levels: [String], rejecting value: String) -> [String] {
        guard let cutoff = canonicalOrder.firstIndex(of: value.lowercased()) else {
            return levels.filter { $0.lowercased() != value.lowercased() }
        }
        let ranks = levels.compactMap { canonicalOrder.firstIndex(of: $0.lowercased()) }
        if let weakest = ranks.min(), cutoff <= weakest {
            return levels.filter {
                guard let rank = canonicalOrder.firstIndex(of: $0.lowercased()) else { return true }
                return rank > cutoff
            }
        }
        return levels.filter {
            guard let rank = canonicalOrder.firstIndex(of: $0.lowercased()) else { return true }
            return rank < cutoff
        }
    }

    // MARK: Rejected effort

    /// What a provider error says about effort: the parameter as a whole
    /// is unsupported (drop it), or one value is (fall back). The value is
    /// the model's quoted token when the message names one.
    public enum Rejection: Sendable, Equatable {
        case parameterUnsupported
        case valueUnsupported(String)
    }

    /// Whether a provider error message rejects the effort control: the
    /// parameter itself ("Unrecognized request argument supplied:
    /// reasoning_effort", "adaptive thinking is not supported on this
    /// model") or one value ("'reasoning_effort' does not support 'none'
    /// with this model", "output_config.effort 'xhigh' is not supported …").
    /// Matched on the message, like `ToolSupport.isToolUseRejection`.
    public static func rejection(in message: String) -> Rejection? {
        let text = message.lowercased()
        let readsAsRejection = rejectionHints.contains { text.contains($0) }
        guard readsAsRejection, let keywordEnd = effortKeywordEnd(in: message) else { return nil }
        if let value = quotedValue(after: keywordEnd, in: message) {
            return .valueUnsupported(value)
        }
        return .parameterUnsupported
    }

    static let rejectionHints = [
        "not supported", "does not support", "unsupported", "unrecognized",
        "unknown parameter", "invalid",
    ]

    static let effortKeywords = [
        "reasoning_effort", "reasoning effort", "output_config.effort", "adaptive thinking",
    ]

    /// End of the first effort keyword's match. Nil when no keyword is named.
    private static func effortKeywordEnd(in message: String) -> String.Index? {
        var best: String.Index?
        for keyword in effortKeywords {
            if let range = message.range(of: keyword, options: .caseInsensitive) {
                if best == nil || range.upperBound < best! { best = range.upperBound }
            }
        }
        return best
    }

    /// Parameter spellings that must not be mistaken for a rejected value.
    private static func isParameterName(_ value: String) -> Bool {
        ["reasoning_effort", "reasoning effort", "output_config.effort", "output_config",
         "effort", "thinking", "adaptive thinking"].contains(value.lowercased())
    }

    /// The rejected value: a quoted token opening after the effort keyword
    /// (model ids are quoted before it, as in "Model 'gpt-5-mini' does not
    /// support reasoning effort 'xhigh'"). Prefers a known level name;
    /// otherwise the first quoted token that isn't a parameter name. Nil
    /// when the message names no value — the parameter itself is unsupported.
    static func quotedValue(after keywordEnd: String.Index, in message: String) -> String? {
        var tokens: [String] = []
        for quote in ["'", "\""] as [Character] {
            var rest = message[...]
            while let open = rest.firstIndex(of: quote) {
                let start = open
                rest = rest[rest.index(after: open)...]
                guard let close = rest.firstIndex(of: quote) else { break }
                let token = String(rest[..<close]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !token.isEmpty, start > keywordEnd { tokens.append(token) }
                rest = rest[rest.index(after: close)...]
            }
        }
        if let known = tokens.first(where: { canonicalOrder.contains($0.lowercased()) }) { return known }
        return tokens.first { !isParameterName($0) }
    }
}
