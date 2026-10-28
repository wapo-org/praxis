import SwiftUI
import UniformTypeIdentifiers
import AgentSkills

/// Settings → Skills: installed skills (with what was dropped at import
/// and any warnings), import from Files (a .zip, a folder or a SKILL.md)
/// with the import report, and folders that failed to load.
struct SkillsScreen: View {
    let library: SkillLibrary
    @Environment(ChatStore.self) private var store
    @State private var importing = false
    @State private var working = false
    @State private var report: SkillImportReport?
    @State private var importError: String?
    @State private var pendingDelete: Skill?
    @State private var editing: EditedSkill?
    @State private var updateNote: String?

    /// `.skill` is a zip by another name (Claude's export format).
    private static let types: [UTType] = [.zip, .folder, UTType(filenameExtension: "skill") ?? .zip,
                                          UTType(filenameExtension: "md") ?? .plainText, .plainText]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let report { reportCard(report) }
                if let importError {
                    Text(importError).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                        .padding(.horizontal, 4)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("skillImportError")
                }
                installed
                // Two peers, one look: same glass capsule, same width.
                HStack(spacing: 10) {
                    importButton
                    browseButton
                }
                updatesFooter
                if !library.problems.isEmpty { problems }
                Text("A skill is a folder of instructions (SKILL.md) the agent can load when a task needs it. Scripts and programs inside a skill are left out: nothing from a skill runs on this iPhone. In Build and Auto modes the agent can also save skills of its own; they're marked “Created by the agent” and can be edited here.")
                    .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .animation(Motion.reflow, value: report)
        }
        .background(Praxis.canvas)
        .navigationTitle("Skills")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await library.reload()
            await library.checkForUpdates()
        }
        .sheet(item: $editing) { item in
            SkillEditorSheet(library: library, draft: item.draft)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: Self.types, allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                if let url = urls.first { Task { await importSkill(url) } }
            case .failure(let error):
                importError = error.localizedDescription
            }
        }
        .confirmationDialog("Delete \(pendingDelete?.name ?? "skill")?",
                            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                            titleVisibility: .visible, presenting: pendingDelete) { skill in
            Button("Delete", role: .destructive) { Task { await delete(skill) } }
        } message: { _ in
            Text("New chats won't offer it. Chats that already started keep it listed, but it can't be loaded any more.")
        }
    }

    // MARK: Sections

    @ViewBuilder
    private var installed: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Installed")
            if library.skills.isEmpty {
                Text("No skills yet. Import one from Files: a .zip, a folder, or a single SKILL.md.")
                    .font(Type.inter(14, .subheadline))
                    .foregroundStyle(Praxis.secondaryInk)
                    .lineSpacing(4)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("skillsEmpty")
            } else {
                SettingsCard {
                    ForEach(library.skills) { skill in
                        if skill.id != library.skills.first?.id { SettingsDivider() }
                        SkillRow(skill: skill, registryName: library.registry(id: skill.source?.registryID)?.name ?? skill.source?.registryName,
                                 update: library.updates[skill.name],
                                 onDelete: { pendingDelete = skill },
                                 onEdit: { Task { await edit(skill) } },
                                 onUpdate: { Task { await update(skill) } })
                    }
                }
            }
        }
    }

    private var importButton: some View {
        Button {
            importError = nil
            importing = true
        } label: {
            PraxisButtonLabel(working ? "Importing…" : "Import skill", systemImage: "square.and.arrow.down", working: working)
        }
        .buttonStyle(.praxisSecondary(fillsWidth: true))
        .disabled(working)
        .accessibilityLabel("Import skill")
    }

    private var browseButton: some View {
        NavigationLink(value: SettingsSheet.Route.skillBrowser) {
            PraxisButtonLabel("Browse", systemImage: "square.grid.2x2")
        }
        .buttonStyle(.praxisSecondary(fillsWidth: true))
        .accessibilityLabel("Browse skill registries")
        .accessibilityIdentifier("browseSkills")
    }

    @ViewBuilder
    private var updatesFooter: some View {
        if library.skills.contains(where: { $0.source?.kind == .registry }) {
            HStack(spacing: 8) {
                if library.checkingUpdates {
                    ProgressView().controlSize(.small)
                    Text("Checking for updates…").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                } else {
                    Button {
                        Task {
                            let errors = await library.checkForUpdates(refresh: true)
                            updateNote = errors.isEmpty
                                ? (library.updates.isEmpty ? "All registry skills are up to date." : nil)
                                : errors.joined(separator: "\n")
                        }
                    } label: {
                        Text("Check for updates")
                    }
                    .buttonStyle(.praxisText(muted: true))
                    if let updateNote {
                        Text(updateNote).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private var problems: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Couldn't load")
            SettingsCard {
                ForEach(Array(library.problems.enumerated()), id: \.offset) { index, problem in
                    if index > 0 { SettingsDivider() }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(problem.folder).font(Type.mono(13, .body)).foregroundStyle(Praxis.ink)
                        Text(problem.message).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    /// What the last import did: new or replaced, what was left out and
    /// why, and format warnings.
    private func reportCard(_ report: SkillImportReport) -> some View {
        let unchanged = report.replacedExisting && report.previousContentHash == report.skill.contentHash
        let headline = unchanged ? "\(report.skill.name) is already up to date"
            : report.replacedExisting ? "Updated \(report.skill.name)" : "Imported \(report.skill.name)"
        return VStack(alignment: .leading, spacing: 8) {
            SettingsCard {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle").font(.system(size: 14, weight: .semibold)).foregroundStyle(Praxis.success)
                        Text(headline).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                        Spacer()
                        Button { withAnimation(Motion.reflow) { self.report = nil } } label: {
                            Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
                                .frame(width: 28, height: 28)
                        }
                        .buttonStyle(.praxisText(muted: true))
                        .accessibilityLabel("Dismiss import report")
                    }
                    if report.replacedExisting && !unchanged {
                        Text("It replaced the earlier import with the same name.")
                            .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                    }
                    if !report.dropped.isEmpty {
                        Text(report.dropped.count == 1 ? "1 file was left out:" : "\(report.dropped.count) files were left out:")
                            .font(Type.inter(13, weight: .medium, .footnote)).foregroundStyle(Praxis.ink)
                        DroppedList(files: report.dropped)
                    }
                    ForEach(report.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityIdentifier("skillImportReport")
        }
        .transition(.opacity)
    }

    // MARK: Actions

    private func importSkill(_ url: URL) async {
        working = true
        defer { working = false }
        do {
            let result = try await library.importSkill(from: url)
            withAnimation(Motion.reflow) {
                report = result
                importError = nil
            }
            store.haptics.fire(.success)
        } catch {
            withAnimation(Motion.reflow) {
                report = nil
                importError = "Couldn't import \(url.lastPathComponent): " + ((error as? SkillError)?.description ?? error.localizedDescription)
            }
            store.haptics.fire(.warning)
        }
    }

    private func edit(_ skill: Skill) async {
        do {
            editing = EditedSkill(draft: try await library.draft(for: skill.name))
        } catch {
            importError = (error as? SkillError)?.description ?? error.localizedDescription
        }
    }

    private func update(_ skill: Skill) async {
        working = true
        defer { working = false }
        do {
            let result = try await library.applyUpdate(skill.name)
            withAnimation(Motion.reflow) { report = result; importError = nil }
            store.haptics.fire(.success)
        } catch {
            importError = "Couldn't update \(skill.name): " + ((error as? SkillRegistryError)?.description
                ?? (error as? SkillError)?.description ?? error.localizedDescription)
            store.haptics.fire(.warning)
        }
    }

    private func delete(_ skill: Skill) async {
        do {
            try await library.remove(skill.name)
            if report?.skill.name == skill.name { report = nil }
            store.haptics.fire(.success)
        } catch {
            importError = (error as? SkillError)?.description ?? error.localizedDescription
        }
    }
}

/// One skill: name, description, origin, warnings and dropped files.
private struct SkillRow: View {
    let skill: Skill
    var registryName: String?
    var update: RegistryUpdate?
    var onDelete: () -> Void
    var onEdit: () -> Void
    var onUpdate: () -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                LucideIcon(name: "wrench", size: 14).foregroundStyle(Praxis.mutedInk).padding(.top, 3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(skill.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                    Text(skill.description).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                        .lineLimit(expanded ? nil : 2)
                    Text(origin).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                        .accessibilityIdentifier("skillOrigin-\(skill.name)")
                    if update != nil {
                        Button(action: onUpdate) {
                            Label("Update available", systemImage: "arrow.down.circle")
                                .font(Type.inter(12, weight: .semibold, .caption))
                        }
                        .buttonStyle(.praxisText)
                        .padding(.top, 2)
                        .accessibilityLabel("Update \(skill.name)")
                    }
                }
                Spacer(minLength: 0)
                if skill.isAgentCreated {
                    Button(action: onEdit) {
                        Image(systemName: "pencil").font(.system(size: 13)).frame(width: 32, height: 32)
                    }
                    .buttonStyle(.praxisText(muted: true))
                    .accessibilityLabel("Edit \(skill.name)")
                }
                if skill.origin == .imported {
                    Button(action: onDelete) {
                        Image(systemName: "trash").font(.system(size: 13)).frame(width: 32, height: 32)
                    }
                    .buttonStyle(.praxisText(muted: true))
                    .accessibilityLabel("Delete \(skill.name)")
                }
            }
            if expanded {
                if let url = skill.source?.pageURL {
                    Link("View source", destination: url).font(Type.inter(12, weight: .medium, .caption)).padding(.leading, 24)
                }
                if !skill.removedFiles.isEmpty {
                    Text("Left out at import").font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.ink)
                    DroppedList(files: skill.removedFiles)
                }
                ForEach(skill.warnings, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(Type.inter(12, .caption)).foregroundStyle(Praxis.secondaryInk)
                }
            } else if !skill.removedFiles.isEmpty || !skill.warnings.isEmpty || skill.source?.pageURL != nil {
                Button {
                    withAnimation(Motion.reflow) { expanded = true }
                } label: {
                    Text(summary).font(Type.inter(12, weight: .medium, .caption))
                }
                .buttonStyle(.praxisText(muted: true))
                .padding(.leading, 24)
                .accessibilityLabel("Show details, \(summary)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var origin: String {
        let from: String
        switch (skill.origin, skill.source?.kind) {
        case (.bundled, _): from = "Built in"
        case (_, .agent?): from = "Created by the agent"
        case (_, .registry?): from = "From \(registryName ?? "a registry")"
        default: from = "Imported"
        }
        var parts = [from]
        if skill.overridesBundled { parts.append("replaces the built-in one") }
        parts.append(skill.files.count == 1 ? "1 extra file" : "\(skill.files.count) extra files")
        return parts.joined(separator: " · ")
    }

    private var summary: String {
        var parts: [String] = []
        if !skill.removedFiles.isEmpty {
            parts.append(skill.removedFiles.count == 1 ? "1 file left out" : "\(skill.removedFiles.count) files left out")
        }
        if !skill.warnings.isEmpty { parts.append(skill.warnings.count == 1 ? "1 warning" : "\(skill.warnings.count) warnings") }
        if parts.isEmpty { parts.append("Details") }
        return parts.joined(separator: " · ")
    }
}

/// Files dropped at import, each with why.
private struct DroppedList: View {
    let files: [DroppedFile]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(files.prefix(12), id: \.path) { file in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(file.path).font(Type.mono(11, .caption2)).foregroundStyle(Praxis.ink).lineLimit(1)
                    Text(file.reason.description).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                }
                .accessibilityElement(children: .combine)
            }
            if files.count > 12 {
                Text("and \(files.count - 12) more").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
            }
        }
    }
}

/// A skill being edited (sheet item).
private struct EditedSkill: Identifiable {
    var draft: SkillDraft
    var id: String { draft.name }
}

/// Edits an agent-made skill: description and instructions (its other
/// files are kept). Saved with the same checks as when the agent writes it.
private struct SkillEditorSheet: View {
    let library: SkillLibrary
    @State var draft: SkillDraft
    @Environment(\.dismiss) private var dismiss
    @Environment(ChatStore.self) private var store
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        SettingsSectionTitle("Description")
                        TextField("What it does and when to use it", text: $draft.description, axis: .vertical)
                            .font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                            .lineLimit(2...6)
                            .padding(12)
                            .background(Praxis.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .accessibilityIdentifier("skillEditorDescription")
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        SettingsSectionTitle("Instructions (SKILL.md)")
                        TextEditor(text: $draft.instructions)
                            .font(Type.mono(13, .body)).foregroundStyle(Praxis.ink)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 320)
                            .padding(8)
                            .background(Praxis.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .accessibilityIdentifier("skillEditorInstructions")
                    }
                    if let error {
                        Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text("Chats that already started keep the old description in their skill list, but load the new instructions.")
                        .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
            }
            .background(Praxis.canvas)
            .navigationTitle(draft.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.foregroundStyle(Praxis.ink)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                        .disabled(saving)
                }
            }
        }
        .presentationDetents([.large])
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await library.saveEdit(draft)
            store.haptics.fire(.success)
            dismiss()
        } catch {
            self.error = (error as? SkillError)?.description ?? error.localizedDescription
            store.haptics.fire(.warning)
        }
    }
}
