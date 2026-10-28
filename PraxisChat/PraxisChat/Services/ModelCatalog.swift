import Foundation

/// The model picker's search: filters a provider-sized list live, as the
/// user types in the composer (which becomes the search field while the
/// Model page is open). Pure, so the unit tests cover the ranking.
enum ModelSearch {
    /// Filters `models` by `query`, ranked prefix-first. Matches the
    /// display name, the model id and the tagline (which carries the
    /// provider name for live models: "OpenRouter · 128K context"), case-
    /// and diacritic-insensitively. An empty query returns the list
    /// unchanged. Ties keep their original order.
    static func filter(_ models: [AIModel], query: String) -> [AIModel] {
        let needle = normalized(query)
        guard !needle.isEmpty else { return models }
        var scored: [(tier: Int, index: Int, model: AIModel)] = []
        scored.reserveCapacity(models.count)
        for (index, model) in models.enumerated() {
            if let tier = tier(of: model, needle: needle) {
                scored.append((tier: tier, index: index, model: model))
            }
        }
        scored.sort { $0.tier == $1.tier ? $0.index < $1.index : $0.tier < $1.tier }
        return scored.map(\.model)
    }

    /// Whether one line of text matches (for pinned ids with no row).
    static func matches(_ text: String, query: String) -> Bool {
        let needle = normalized(query)
        return needle.isEmpty || normalized(text).contains(needle)
    }

    static func normalized(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    /// Lower wins: name prefix, id prefix, tagline prefix, then the same
    /// three as substring matches. Nil = no match on any field.
    private static func tier(of model: AIModel, needle: String) -> Int? {
        let name = normalized(model.name)
        let id = normalized(model.id)
        let tagline = normalized(model.tagline)
        if name.hasPrefix(needle) { return 0 }
        if id.hasPrefix(needle) { return 1 }
        if tagline.hasPrefix(needle) { return 2 }
        if name.contains(needle) { return 3 }
        if id.contains(needle) { return 4 }
        if tagline.contains(needle) { return 5 }
        return nil
    }
}

/// The model page split into its sections: pinned models on top, then
/// everything else. A pin whose model is no longer listed stays visible
/// (dimmed, "Unavailable") so it can be unpinned, never silently dropped.
struct ModelSections: Equatable {
    /// Pinned and listed, in pin order (ranked by match while searching).
    var favorites: [AIModel] = []
    /// Pinned but not listed, in pin order.
    var unavailableIDs: [String] = []
    /// Unpinned, matching the query, in list order (ranked while searching).
    var rest: [AIModel] = []

    var isEmpty: Bool { favorites.isEmpty && unavailableIDs.isEmpty && rest.isEmpty }

    static func make(models: [AIModel], pinnedIDs: [String], query: String) -> ModelSections {
        var listedByID: [String: AIModel] = [:]
        for model in models where listedByID[model.id] == nil { listedByID[model.id] = model }
        let pinned = pinnedIDs.filter { !$0.isEmpty }
        let listed = pinned.compactMap { listedByID[$0] }
        let missing = pinned.filter { listedByID[$0] == nil }
        let pinnedSet = Set(pinned)
        let rest = models.filter { !pinnedSet.contains($0.id) }
        let searching = !ModelSearch.normalized(query).isEmpty
        return ModelSections(
            favorites: searching ? ModelSearch.filter(listed, query: query) : listed,
            unavailableIDs: missing.filter { ModelSearch.matches($0, query: query) },
            rest: ModelSearch.filter(rest, query: query))
    }
}

extension ChatStore {
    /// Whose pins apply to the model page: the selected provider, or the
    /// demo key while no provider is configured (services exist in the
    /// app even then; in tests without services there are no pins).
    var modelPinProfileID: UUID { services?.settings.selectedProfile?.id ?? ProviderSettings.demoProfileID }

    func pinnedModelIDs() -> [String] {
        services?.settings.pinnedModels(for: modelPinProfileID) ?? []
    }

    func isModelPinned(_ id: String) -> Bool {
        services?.settings.isPinned(profileID: modelPinProfileID, model: id) ?? false
    }

    func setModelPinned(_ id: String, pinned: Bool) {
        services?.settings.setPinned(pinned, profileID: modelPinProfileID, model: id)
    }
}
