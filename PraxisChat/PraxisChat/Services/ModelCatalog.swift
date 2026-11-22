import Foundation

enum ModelSearch {
    /// Prefix-first search over name/id/tagline (case/diacritic-insensitive); stable on ties.
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

    static func matches(_ text: String, query: String) -> Bool {
        let needle = normalized(query)
        return needle.isEmpty || normalized(text).contains(needle)
    }

    static func normalized(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    /// Lower wins: name/id/tagline prefix, then substring; nil = no match.
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

/// Splits models into pinned + rest; unlisted pins stay visible as Unavailable, never dropped.
struct ModelSections: Equatable {
    var favorites: [AIModel] = []
    var unavailableIDs: [String] = []
    var rest: [AIModel] = []

    var isEmpty: Bool { favorites.isEmpty && unavailableIDs.isEmpty && rest.isEmpty }

    static func make(models: [AIModel], pinnedIDs: [String], query: String) -> ModelSections {
        var listedByID: [String: AIModel] = [:]
        for model in models where listedByID[model.id] == nil { listedByID[model.id] = model }
        // Deduplicate against hand-edited JSON so a model row never renders twice.
        var seen: Set<String> = []
        let pinned = pinnedIDs.filter { !$0.isEmpty && seen.insert($0).inserted }
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
    /// Uses selected profile ID, or demoProfileID before any provider is configured.
    var modelPinProfileID: UUID { services?.settings.selectedProfile?.id ?? ProviderSettings.demoProfileID }

    func pinnedModelIDs() -> [String] {
        if let cloud = cloudServices { return cloud.pinnedModelIDs }
        return services?.settings.pinnedModels(for: modelPinProfileID) ?? []
    }

    func isModelPinned(_ id: String) -> Bool {
        if let cloud = cloudServices { return cloud.pinnedModelIDs.contains(id) }
        return services?.settings.isPinned(profileID: modelPinProfileID, model: id) ?? false
    }

    func setModelPinned(_ id: String, pinned: Bool) {
        if let cloud = cloudServices, let model = cloud.model(selectionID: id) {
            Task { try? await cloud.setModelPreference(model, pinned: pinned) }
            return
        }
        services?.settings.setPinned(pinned, profileID: modelPinProfileID, model: id)
    }
}
