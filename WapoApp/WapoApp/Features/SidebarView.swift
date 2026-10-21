import SwiftUI

/// Chat-list sidebar. Rows support swipe actions and long-press menus,
/// after the observed `TranscriptSwipeAction` symbols in the reference.
struct SidebarView: View {
    @ObservedObject var model: AppModel
    @Binding var showSettings: Bool
    @State private var query = ""

    private var filtered: [Conversation] {
        query.isEmpty ? model.conversations
            : model.conversations.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        List {
            Section {
                Button {
                    withAnimation(Tokens.springSnappy) { model.newConversation() }
                } label: {
                    Label { Text("New chat").font(Tokens.bodySans) }
                    icon: { AppIcon.chatAdd.image() }
                }
                .buttonStyle(HapticButtonStyle())
            }
            Section("Recents") {
                if filtered.isEmpty {
                    Text(query.isEmpty ? "No chats yet" : "No results for \u{201C}\(query)\u{201D}")
                        .font(Tokens.captionSans).foregroundStyle(.secondary)
                }
                ForEach(filtered) { conv in
                    Button { model.selectedID = conv.id } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(conv.title).font(Tokens.bodySans).lineLimit(1)
                            Text(conv.updatedAt, style: .relative)
                                .font(Tokens.captionSans).foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(model.selectedID == conv.id ? Tokens.surfaceRaised : Color.clear)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            withAnimation(Tokens.springSnappy) { model.delete(conv.id) }
                        } label: { Label("Delete", systemImage: "trash") }
                    }
                    .contextMenu {
                        Button { model.selectedID = conv.id } label: {
                            Label("Open", systemImage: "message")
                        }
                        Button(role: .destructive) { model.delete(conv.id) } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
            Section("Projects") {
                Label { Text("No projects yet").font(Tokens.captionSans) }
                icon: { AppIcon.folder.image(size: 15) }
                .foregroundStyle(.secondary)
            }
        }
        .listStyle(.sidebar)
        .background(Tokens.surface)
        .searchable(text: $query, prompt: "Search chats")
        .navigationTitle("Chats")
        .toolbar {
            ToolbarItem(placement: .bottomBar) {
                Button { showSettings = true } label: {
                    Label { Text("Settings").font(Tokens.captionSans) }
                    icon: { AppIcon.settings.image(size: 16) }
                }
                .buttonStyle(HapticButtonStyle())
            }
        }
    }
}
