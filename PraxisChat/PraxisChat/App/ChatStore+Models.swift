import Foundation
import AgentCore
import AgentMCP
import AgentRuntime

extension ChatStore {
    // MARK: Live settings (model, connectors, toggles)

    var isCloud: Bool { engineKind == .cloud }
    var isLive: Bool { engineKind == .live || isCloud }

    /// The model new turns use: the demo pick, or the selected provider's.
    var model: AIModel {
        get {
            if let cloud = cloudServices {
                return cloud.model(selectionID: cloudModelID).map(cloud.adapter)
                    ?? cloud.availableModels.first
                    ?? AIModel(id: "", name: "Choose a model", tagline: "Account / Server in Settings", speed: 0, intelligence: 0, streamMultiplier: 1)
            }
            return isLive ? liveModel : demoModel
        }
        set {
            if cloudServices != nil { cloudModelID = newValue.id; snapEffortToSupportedLevels() }
            else if isLive { selectModel(id: newValue.id) } else { demoModel = newValue; snapEffortToSupportedLevels() }
        }
    }

    /// Reasoning levels the tray offers for the current model. Nil = unknown
    /// (all four); empty = no reasoning (the control hides). Live models
    /// resolve this from the provider's list or a learned rejection.
    var supportedEfforts: [Effort]? {
        if let cloud = cloudServices {
            return cloud.model(selectionID: model.id).map { EffortLevels.map($0.reasoningEfforts) }
        }
        if isLive {
            guard let wire = services?.settings.selectedEffortWireValues else { return nil }
            return EffortLevels.map(wire)
        }
        return demoModel.effortLevels
    }

    /// After a model change, moves the effort to the nearest level the new
    /// model takes; unknown or unreasoning models keep it. The tray's
    /// control animates to the new selection, which is the subtle show.
    func snapEffortToSupportedLevels() {
        guard let levels = supportedEfforts, !levels.isEmpty, !levels.contains(effort),
              let snapped = EffortLevels.nearest(to: effort, in: levels) else { return }
        effort = snapped
    }

    /// What the tray's model page lists.
    var availableModels: [AIModel] {
        if let cloud = cloudServices { return cloud.availableModels }
        guard isLive else { return MockData.models }
        guard let settings = services?.settings, let profile = settings.selectedProfile else { return [] }
        var models = settings.models(for: profile.id).map { Self.aiModel($0, profile: profile) }
        // A manually entered id the server doesn't list still shows.
        if !profile.defaultModel.isEmpty, !models.contains(where: { $0.id == profile.defaultModel }) {
            models.insert(Self.aiModel(ModelInfo(id: profile.defaultModel), profile: profile), at: 0)
        }
        return models
    }

    private var liveModel: AIModel {
        guard let profile = services?.settings.selectedProfile else {
            return AIModel(id: "", name: "No model", tagline: "Add a provider in Settings",
                           speed: 0, intelligence: 0, streamMultiplier: 1)
        }
        let info = services?.settings.models(for: profile.id).first { $0.id == profile.defaultModel }
        guard !profile.defaultModel.isEmpty else {
            return AIModel(id: "", name: "Choose a model", tagline: profile.name, speed: 0, intelligence: 0, streamMultiplier: 1)
        }
        return Self.aiModel(info ?? ModelInfo(id: profile.defaultModel), profile: profile)
    }

    private func selectModel(id: String) {
        guard let settings = services?.settings, let profile = settings.selectedProfile else { return }
        settings.setModel(id, for: profile.id)
        snapEffortToSupportedLevels()
    }

    private static func aiModel(_ info: ModelInfo, profile: ProviderProfile) -> AIModel {
        let window = info.contextWindow.map { " · \($0 / 1000)K context" } ?? ""
        return AIModel(id: info.id, name: info.displayName, tagline: profile.name + window,
                       speed: 0, intelligence: 0, streamMultiplier: 1)
    }

}
