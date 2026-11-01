import SwiftUI

/// The official registry can return several remote addresses per server and
/// empty filtered pages with a next cursor. The editor owns health-checked add.
struct CloudConnectorRegistryScreen: View {
    let services: CloudServices
    @State private var query = ""
    @State private var entries: [CloudConnectorRegistryEntry] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        CloudSettingsPage(title: "MCP registry") {
            Text("From registry.modelcontextprotocol.io. Listed servers aren't reviewed by Praxis; check a server before trusting it.")
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
            if entries.isEmpty && !loading && error == nil {
                Text(query.isEmpty ? "No servers found." : "No remote servers match “\(query)”.")
                    .font(Type.inter(14, .body)).foregroundStyle(Praxis.secondaryInk)
            }
            ForEach(entries, id: \.selectionID) { entry in
                NavigationLink { CloudCatalogConnectorEditor(services: services, registryEntry: entry) } label: {
                    SettingsCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(entry.input.name).font(Type.inter(15, weight: .semibold, .body))
                            Text(entry.description).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                            Text(entry.input.url).font(Type.mono(12, .caption)).foregroundStyle(Praxis.mutedInk)
                            if entry.requiresConfiguration { Text("Configuration required").font(Type.inter(12, .caption)) }
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }.buttonStyle(PressHighlightStyle())
            }
            if loading { ProgressView().frame(maxWidth: .infinity) }
            if let cursor {
                CloudSettingsAction("Load more servers") {
                    let expected = query
                    let page = try await services.connectorRegistry(query: expected, cursor: cursor)
                    guard expected == query else { return }
                    guard page.nextCursor != cursor else { throw CloudSettingsError.repeatedCursor }
                    var ids = Set(entries.map(\.selectionID))
                    entries += page.items.filter { ids.insert($0.selectionID).inserted }
                    self.cursor = page.nextCursor
                }
            }
            if let error { CloudSettingsErrorText(message: error) }
        }
        .searchable(text: $query, prompt: "Search servers")
        .task(id: query) {
            let expected = query
            loading = true; error = nil; entries = []; cursor = nil
            do {
                try await Task.sleep(for: .milliseconds(350))
                let page = try await services.connectorRegistry(query: expected)
                try Task.checkCancellation()
                guard expected == query else { return }
                var ids: Set<String> = []
                entries = page.items.filter { ids.insert($0.selectionID).inserted }; cursor = page.nextCursor
                loading = false
            } catch is CancellationError { }
            catch { if expected == query { self.error = error.localizedDescription; loading = false } }
        }
    }
}
