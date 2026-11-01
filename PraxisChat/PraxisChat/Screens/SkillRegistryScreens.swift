import SwiftUI
import AgentSkills

/// Settings → Skills → Browse: skills from public registries (GitHub repos
/// and Agent Skills discovery indexes). Pick a registry, search, open a
/// skill for its SKILL.md and install it.
struct SkillRegistryBrowserScreen: View {
    let library: SkillLibrary
    @Environment(ChatStore.self) private var store
    @State private var selectedID = SkillRegistry.anthropic.id
    @State private var listing: RegistryListing?
    @State private var loading = false
    @State private var error: String?
    @State private var query = ""
    @State private var adding = false
    @State private var newRegistry = ""
    @State private var addError: String?
    @State private var addWorking = false

    private var registry: SkillRegistry? { library.registry(id: selectedID) ?? library.registries.first }

    private var filtered: [RegistrySkill] {
        let skills = listing?.skills ?? []
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return skills }
        return skills.filter { $0.name.lowercased().contains(q) || $0.description.lowercased().contains(q) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                registryPicker
                if let registry { header(registry) }
                if let error {
                    Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                        .padding(.horizontal, 4).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("registryError")
                }
                ForEach(listing?.warnings ?? [], id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(Type.inter(12, .caption)).foregroundStyle(Praxis.secondaryInk)
                        .padding(.horizontal, 4).fixedSize(horizontal: false, vertical: true)
                }
                results
                addSection
                Text("Registries are public GitHub repositories or sites publishing an Agent Skills index (/.well-known/agent-skills/index.json). Praxis reads them directly; nothing goes through a Praxis server. Scripts in a skill are never downloaded or run.")
                    .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(Praxis.canvas)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search skills")
        .navigationTitle("Browse skills")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load(refresh: true) }
        .task(id: selectedID) { await load(refresh: false) }
    }

    // MARK: Sections

    private var registryPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(library.registries) { registry in
                    let selected = registry.id == (self.registry?.id ?? "")
                    Button {
                        store.haptics.fire(.selection)
                        selectedID = registry.id
                    } label: {
                        Text(registry.name)
                            .font(Type.inter(14, weight: selected ? .semibold : .regular, .subheadline))
                            .foregroundStyle(selected ? Praxis.canvas : Praxis.ink)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(selected ? Praxis.ink : Praxis.card, in: Capsule())
                            .overlay(Capsule().strokeBorder(Praxis.hairline, lineWidth: selected ? 0 : 1))
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .contextMenu {
                        if !registry.isBuiltIn {
                            Button("Remove registry", role: .destructive) {
                                library.removeRegistry(registry.id)
                                if selectedID == registry.id { selectedID = SkillRegistry.anthropic.id }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .accessibilityIdentifier("registryPicker")
    }

    private func header(_ registry: SkillRegistry) -> some View {
        HStack(spacing: 8) {
            if let url = registry.source.pageURL {
                Link(destination: url) {
                    Label(registry.source.displayLocation, systemImage: "arrow.up.right.square")
                        .font(Type.inter(12, .caption)).foregroundStyle(Praxis.secondaryInk).lineLimit(1)
                }
            }
            Spacer()
            if loading {
                ProgressView().controlSize(.small)
            } else if let listing {
                Text("Updated \(listing.fetchedAt.formatted(.relative(presentation: .named)))")
                    .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
            }
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private var results: some View {
        if let registry, listing != nil || !loading {
            if filtered.isEmpty {
                Text(listing == nil ? "Couldn't load this registry." : query.isEmpty ? "This registry lists no skills." : "No skills match “\(query)”.")
                    .font(Type.inter(14, .subheadline)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
            } else {
                SettingsCard {
                    ForEach(filtered) { skill in
                        if skill.id != filtered.first?.id { SettingsDivider() }
                        NavigationLink(value: SettingsSheet.Route.registrySkill(skill, registry)) {
                            RegistrySkillRow(skill: skill, installed: installState(skill))
                        }
                        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                    }
                }
                .accessibilityIdentifier("registrySkills")
            }
        }
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Add a registry")
            if adding {
                SettingsCard {
                    SettingsField(title: "GitHub repository or index URL", text: $newRegistry,
                                  placeholder: "owner/repo or https://example.com", keyboard: .URL, monospaced: true)
                }
                if let addError {
                    Text(addError).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                        .padding(.horizontal, 4).fixedSize(horizontal: false, vertical: true)
                }
                SettingsActionButton(title: addWorking ? "Checking…" : "Add registry", prominent: true) {
                    Task { await addRegistry() }
                }
                .disabled(addWorking || newRegistry.trimmingCharacters(in: .whitespaces).isEmpty)
                Text("A GitHub repo or folder (every folder with a SKILL.md becomes a skill), or a site that publishes /.well-known/agent-skills/index.json.")
                    .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                SettingsActionButton(title: "Add registry…") { withAnimation(Motion.reflow) { adding = true } }
            }
        }
    }

    // MARK: Actions

    private func installState(_ skill: RegistrySkill) -> RegistrySkillRow.Installed {
        guard let local = library.skills.first(where: { $0.name == skill.name }) else { return .no }
        guard local.source?.kind == .registry, local.source?.registryID == skill.registryID,
              local.source?.entryID == skill.id else { return .otherSource }
        return local.source?.revision == skill.revision || skill.revision == nil ? .current : .updateAvailable
    }

    private func load(refresh: Bool) async {
        guard let registry else { return }
        if !refresh, listing?.registryID != registry.id { listing = await library.cachedListing(for: registry) }
        loading = true
        defer { loading = false }
        do {
            listing = try await library.listing(for: registry, refresh: refresh)
            error = nil
        } catch {
            self.error = (error as? SkillRegistryError)?.description ?? error.localizedDescription
        }
    }

    private func addRegistry() async {
        addWorking = true
        defer { addWorking = false }
        do {
            let registry = try await library.addRegistry(newRegistry)
            addError = nil
            newRegistry = ""
            adding = false
            selectedID = registry.id
            store.haptics.fire(.success)
        } catch {
            addError = (error as? SkillRegistryError)?.description ?? error.localizedDescription
            store.haptics.fire(.warning)
        }
    }
}

private struct RegistrySkillRow: View {
    enum Installed { case no, current, updateAvailable, otherSource }
    let skill: RegistrySkill
    let installed: Installed

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            LucideIcon(name: "wrench", size: 14).foregroundStyle(Praxis.mutedInk).padding(.top, 3)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(skill.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                    if let badge { Text(badge).font(Type.inter(11, weight: .medium, .caption2)).foregroundStyle(Praxis.secondaryInk)
                        .padding(.horizontal, 6).padding(.vertical, 2).background(Praxis.hairline, in: Capsule()) }
                }
                if !skill.description.isEmpty {
                    Text(skill.description).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                        .lineLimit(2).multilineTextAlignment(.leading)
                }
                if let problem = skill.problem {
                    Text(problem).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).lineLimit(2)
                } else if !skill.skippedFiles.isEmpty {
                    Text("Scripts left out: \(skill.skippedFiles.count)").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                }
            }
            Spacer(minLength: 0)
            LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk).padding(.top, 3)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var badge: String? {
        switch installed {
        case .no: return nil
        case .current: return "Installed"
        case .updateAvailable: return "Update"
        case .otherSource: return "Name in use"
        }
    }
}

/// One registry skill: its SKILL.md as published, what would be installed
/// and left out, and Install / Update.
struct RegistrySkillDetailScreen: View {
    let library: SkillLibrary
    let skill: RegistrySkill
    let registry: SkillRegistry
    @Environment(ChatStore.self) private var store
    @State private var preview: RegistryPreview?
    @State private var error: String?
    @State private var working = false
    @State private var report: SkillImportReport?

    private var installed: Skill? { library.skills.first { $0.name == skill.name } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(skill.name).font(Type.inter(22, weight: .semibold, .title2)).foregroundStyle(Praxis.ink)
                    if !skill.description.isEmpty {
                        Text(skill.description).font(Type.inter(15, .body)).foregroundStyle(Praxis.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 6) {
                        Text("From \(registry.name)").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                        if let url = skill.pageURL {
                            Link("View source", destination: url).font(Type.inter(12, weight: .medium, .caption))
                        }
                    }
                }

                if let report {
                    Label(report.replacedExisting ? "Updated \(report.skill.name)" : "Installed \(report.skill.name)",
                          systemImage: "checkmark.circle")
                        .font(Type.inter(14, weight: .semibold, .subheadline)).foregroundStyle(Praxis.success)
                        .accessibilityIdentifier("registryInstallDone")
                }
                if let error {
                    Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                }

                actionButton

                if let preview {
                    if !preview.skipped.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            SettingsSectionTitle("Left out on this iPhone")
                            Text("Scripts and programs can't run here, so they aren't installed. The agent follows the instructions by hand or with its own tools instead.")
                                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                                .fixedSize(horizontal: false, vertical: true)
                            SettingsCard {
                                VStack(alignment: .leading, spacing: 3) {
                                    ForEach(preview.skipped.prefix(20), id: \.path) { file in
                                        HStack(spacing: 6) {
                                            Text(file.path).font(Type.mono(11, .caption2)).foregroundStyle(Praxis.ink).lineLimit(1)
                                            Text(file.reason.description).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                                        }
                                    }
                                    if preview.skipped.count > 20 {
                                        Text("and \(preview.skipped.count - 20) more").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                                    }
                                }
                                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    if !preview.files.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            SettingsSectionTitle("Files")
                            Text(preview.files.map(\.path).joined(separator: ", "))
                                .font(Type.mono(11, .caption2)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    ForEach(preview.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(Type.inter(12, .caption)).foregroundStyle(Praxis.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        SettingsSectionTitle("SKILL.md")
                        SettingsCard {
                            Text(preview.skillMarkdown)
                                .font(Type.mono(12, .caption))
                                .foregroundStyle(Praxis.ink)
                                .textSelection(.enabled)
                                .padding(14)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .accessibilityIdentifier("registrySkillMarkdown")
                    }
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 20)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(Praxis.canvas)
        .navigationTitle(skill.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do { preview = try await library.preview(skill) } catch {
                self.error = (error as? SkillRegistryError)?.description ?? error.localizedDescription
            }
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        let sameEntry = installed?.source?.kind == .registry && installed?.source?.registryID == registry.id
            && installed?.source?.entryID == skill.id
        let upToDate = sameEntry && (installed?.source?.revision == skill.revision)
        if skill.problem == nil {
            if upToDate {
                Text("Installed and up to date").font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    SettingsActionButton(title: working ? "Installing…" : sameEntry ? "Update" : installed != nil ? "Install and replace" : "Install",
                                         prominent: true) { Task { await install() } }
                        .disabled(working)
                        .accessibilityIdentifier("registryInstall")
                    if installed != nil, !sameEntry {
                        Text("You already have a skill named \(skill.name); installing replaces it.")
                            .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                    }
                }
            }
        }
    }

    private func install() async {
        working = true
        defer { working = false }
        do {
            report = try await library.install(skill, from: registry)
            error = nil
            store.haptics.fire(.success)
        } catch {
            self.error = (error as? SkillRegistryError)?.description ?? (error as? SkillError)?.description ?? error.localizedDescription
            store.haptics.fire(.warning)
        }
    }
}
