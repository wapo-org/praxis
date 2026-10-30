import SwiftUI
import UniformTypeIdentifiers

struct CloudSettingsSkillsScreen: View {
    let services: CloudServices
    @State private var importing = false
    @State private var imported: CloudCatalogSkillInput?
    @State private var importError: String?
    var body: some View {
        CloudSettingsPage(title: "Skills") {
            Text("Skill catalogs are frozen when a chat starts. Edits and imports apply to new chats. Skill scripts are not run.")
                .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
            SettingsCard {
                ForEach(services.skills) { skill in
                    NavigationLink { CloudSettingsSkillEditor(services: services, skill: skill) } label: {
                        CloudSettingsRow(title: skill.name, value: skill.enabled ? "On" : "Off", symbol: "doc.text")
                    }.buttonStyle(PressHighlightStyle())
                    SettingsDivider()
                }
                NavigationLink { CloudSettingsSkillEditor(services: services) } label: {
                    CloudSettingsRow(title: "Create skill", symbol: "plus")
                }.buttonStyle(PressHighlightStyle())
                SettingsDivider()
                Button { importing = true } label: { CloudSettingsRow(title: "Import SKILL.md", symbol: "square.and.arrow.down") }
                    .buttonStyle(PressHighlightStyle()).accessibilityIdentifier("cloudImportSkill")
            }
            if let importError { CloudSettingsErrorText(message: importError) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText, .text, .data]) { result in
            do { imported = try CloudSettingsSkillImport.read(result.get()); importError = nil }
            catch { importError = error.localizedDescription }
        }
        .sheet(item: $imported) { draft in
            NavigationStack { CloudSettingsSkillEditor(services: services, imported: draft) }
                .presentationDetents([.large])
        }
    }
}

extension CloudCatalogSkillInput: Identifiable {
    var id: String { name }
}

/// Security-scoped access ends before the data leaves this function. Only a
/// bounded UTF-8 document is sent to the API; no local filesystem path leaks.
enum CloudSettingsSkillImport {
    static func read(_ url: URL) throws -> CloudCatalogSkillInput {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize, size <= 500_000 else { throw CloudSettingsError.invalidSkill }
        let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        guard bytes.count <= 500_000, let document = String(data: bytes, encoding: .utf8), !document.isEmpty else { throw CloudSettingsError.invalidSkill }
        // The API performs authoritative SKILL.md validation. The filename is
        // only an editable suggested name, never a path on the cloud server.
        return CloudCatalogSkillInput(name: url.deletingPathExtension().lastPathComponent, description: "", document: document)
    }
}

struct CloudSettingsSkillEditor: View {
    @Environment(\.dismiss) private var dismiss
    let services: CloudServices
    var skill: CloudCatalogSkill?
    var imported: CloudCatalogSkillInput?
    @State private var name = ""
    @State private var description = ""
    @State private var document = ""
    @State private var enabled = true
    @State private var loaded = false
    @State private var deleting = false
    var body: some View {
        CloudSettingsPage(title: skill?.name ?? "Create skill") {
            SettingsCard {
                SettingsField(title: "Name", text: $name, placeholder: "My skill")
                SettingsDivider()
                SettingsField(title: "Description", text: $description, placeholder: "When to use this skill")
                SettingsDivider()
                Toggle("Enabled", isOn: $enabled).tint(Praxis.ink).padding(14)
            }
            SettingsSectionTitle("SKILL.md")
            TextEditor(text: $document).font(Type.mono(13, .body)).scrollContentBackground(.hidden)
                .frame(minHeight: 280).padding(10).background(Praxis.card, in: RoundedRectangle(cornerRadius: 18))
                .accessibilityLabel("Skill document").accessibilityIdentifier("cloudSkillDocument")
            CloudSettingsAction("Save skill", identifier: "cloudSaveSkill") {
                _ = try await services.saveSkill(id: skill?.id, input: CloudCatalogSkillInput(
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines), description: description, document: document, enabled: enabled))
                dismiss()
            }.disabled(name.isEmpty || document.isEmpty || document.utf8.count > 500_000)
            if let skill {
                Button("Delete skill", role: .destructive) { deleting = true }.buttonStyle(.praxisText)
                if deleting {
                    CloudSettingsAction("Confirm delete", destructive: true) { try await services.deleteSkill(skill.id); dismiss() }
                    Button("Cancel") { deleting = false }.buttonStyle(.praxisText)
                }
            }
        }
        .onAppear {
            guard !loaded else { return }; loaded = true
            if let skill { name = skill.name; description = skill.description; document = skill.document; enabled = skill.enabled }
            else if let imported { name = imported.name; description = imported.description; document = imported.document; enabled = imported.enabled }
        }
    }
}

struct CloudSettingsRegistriesScreen: View {
    let services: CloudServices
    @State private var name = ""
    @State private var url = ""
    var body: some View {
        CloudSettingsPage(title: "Skill registries") {
            SettingsCard {
                ForEach(services.registries) { registry in
                    NavigationLink { CloudSettingsRegistryScreen(services: services, registry: registry) } label: {
                        CloudSettingsRow(title: registry.name, value: registry.enabled ? "On" : "Off", symbol: "books.vertical")
                    }.buttonStyle(PressHighlightStyle())
                    SettingsDivider()
                }
            }
            SettingsSectionTitle("Add registry")
            SettingsCard {
                SettingsField(title: "Name", text: $name, placeholder: "Skill registry")
                SettingsDivider()
                SettingsField(title: "Registry URL", text: $url, placeholder: "https://example.com/skills", keyboard: .URL, monospaced: true)
            }
            CloudSettingsAction("Add registry", identifier: "cloudAddRegistry") {
                _ = try await services.saveRegistry(input: CloudCatalogRegistryInput(name: name, url: url.trimmingCharacters(in: .whitespacesAndNewlines)))
                name = ""; url = ""
            }.disabled(name.isEmpty || url.isEmpty)
        }
    }
}

struct CloudSettingsRegistryScreen: View {
    @Environment(\.dismiss) private var dismiss
    let services: CloudServices
    var registry: CloudCatalogRegistry
    @State private var query = ""
    @State private var items: [CloudCatalogRegistryEntry] = []
    @State private var nextCursor: String?
    @State private var error: String?
    @State private var searching = false
    @State private var deleting = false
    @State private var registryName = ""
    @State private var registryURL = ""
    private var current: CloudCatalogRegistry { services.registries.first { $0.id == registry.id } ?? registry }
    var body: some View {
        CloudSettingsPage(title: current.name) {
            SettingsCard {
                SettingsField(title: "Name", text: $registryName)
                SettingsDivider()
                SettingsField(title: "Registry URL", text: $registryURL, keyboard: .URL, monospaced: true)
            }
            CloudSettingsAction("Save registry") {
                _ = try await services.saveRegistry(id: current.id, input: CloudCatalogRegistryInput(
                    name: registryName.trimmingCharacters(in: .whitespacesAndNewlines),
                    url: registryURL.trimmingCharacters(in: .whitespacesAndNewlines), enabled: current.enabled))
            }.disabled(registryName.isEmpty || registryURL.isEmpty)
            SettingsCard {
                CloudSettingsToggle("Enabled", isOn: current.enabled) {
                    _ = try await services.saveRegistry(id: current.id, input: CloudCatalogRegistryInput(name: current.name, url: current.url, enabled: $0))
                }
            }
            if searching { ProgressView().frame(maxWidth: .infinity) }
            ForEach(items) { skill in
                SettingsCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(skill.name).font(Type.inter(15, weight: .semibold, .body))
                        Text(skill.description).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                        if services.skills.contains(where: { $0.id == skill.id }) {
                            Text("Installed").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                        } else {
                            CloudSettingsAction("Install \(skill.name)") { try await services.installSkill(registryID: current.id, skillID: skill.id) }
                        }
                    }.padding(14)
                }
            }
            if let cursor = nextCursor {
                CloudSettingsAction("Load more skills") {
                    let expected = query
                    let page = try await services.registrySearch(current.id, query: expected, cursor: cursor)
                    guard expected == query else { return }
                    guard page.nextCursor != cursor else { throw CloudSettingsError.repeatedCursor }
                    var ids = Set(items.map(\.id)); items += page.items.filter { ids.insert($0.id).inserted }
                    nextCursor = page.nextCursor
                }
            }
            if let error { CloudSettingsErrorText(message: error) }
            Button("Remove registry", role: .destructive) { deleting = true }.buttonStyle(.praxisText)
            if deleting {
                CloudSettingsAction("Confirm removal", destructive: true) { try await services.deleteRegistry(current.id); dismiss() }
                Button("Cancel") { deleting = false }.buttonStyle(.praxisText)
            }
        }
        .searchable(text: $query, prompt: "Search registry on server")
        .onAppear { registryName = current.name; registryURL = current.url }
        .task(id: query + "\u{0}" + current.url) {
            let expected = query
            do {
                try await Task.sleep(for: .milliseconds(250))
                searching = true; items = []; nextCursor = nil
                let page = try await services.registrySearch(current.id, query: expected)
                try Task.checkCancellation()
                guard expected == query else { return }
                items = page.items; nextCursor = page.nextCursor; error = nil; searching = false
            } catch is CancellationError { }
            catch { if expected == query { self.error = error.localizedDescription; searching = false } }
        }
    }
}
