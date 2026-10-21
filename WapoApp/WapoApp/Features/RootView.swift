import SwiftUI
import Network

/// App-level model. View-state vocabulary follows the reference string
/// catalog (412 state keys: empty / loading / failed / offline / limit…).
@MainActor
final class AppModel: ObservableObject {
    @Published var conversations: [Conversation] = []
    @Published var selectedID: String?
    @Published var isOnline = true
    @Published var banner: String?
    @Published var isStreaming = false

    let api = APIClient()
    private var streamTask: Task<Void, Never>?
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "wapo.net")

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in self?.isOnline = path.status == .satisfied }
        }
        monitor.start(queue: monitorQueue)
        newConversation()
    }

    var selected: Conversation? {
        conversations.first { $0.id == selectedID }
    }

    func newConversation() {
        let c = Conversation(id: UUID().uuidString, title: "New chat", updatedAt: Date())
        conversations.insert(c, at: 0)
        selectedID = c.id
    }

    func delete(_ id: String) {
        conversations.removeAll { $0.id == id }
        if selectedID == id { selectedID = conversations.first?.id }
        if conversations.isEmpty { newConversation() }
    }

    func send(_ text: String) {
        guard var conv = selected, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        conv.messages.append(ChatMessage(role: .user, text: text))
        let placeholder = ChatMessage(role: .assistant, text: "")
        conv.messages.append(placeholder)
        if conv.title == "New chat" {
            conv.title = String(text.prefix(42))
        }
        conv.updatedAt = Date()
        replace(conv)
        let history = conv.messages.filter { !$0.text.isEmpty || $0.role == .user }
        let assistantID = placeholder.id
        isStreaming = true
        banner = isOnline ? nil : "You're offline. Messages will fail until you reconnect."
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in api.streamChat(messages: history) {
                    if Task.isCancelled { break }
                    switch event {
                    case .textDelta(let delta):
                        self.appendDelta(delta, to: assistantID)
                    case .error(let message):
                        self.banner = message == "LIMIT_REACHED"
                            ? "You've reached the usage limit for the local API. Try again later."
                            : message
                    case .messageStop:
                        break
                    default:
                        break
                    }
                }
            } catch {
                self.banner = "Couldn't reach the local API at \(api.baseURL.absoluteString). \(error.localizedDescription)"
            }
            self.finishStreaming(assistantID)
        }
    }

    func stop() {
        streamTask?.cancel()
        if let id = selected?.messages.last(where: { $0.isStreaming })?.id {
            finishStreaming(id)
        }
    }

    private func appendDelta(_ delta: String, to id: String) {
        guard var conv = selected,
              let idx = conv.messages.firstIndex(where: { $0.id == id }) else { return }
        conv.messages[idx].text += delta
        conv.messages[idx].isStreaming = true
        replace(conv)
    }

    private func finishStreaming(_ id: String) {
        if var conv = selected, let idx = conv.messages.firstIndex(where: { $0.id == id }) {
            conv.messages[idx].isStreaming = false
            if conv.messages[idx].text.isEmpty {
                conv.messages[idx].text = "No response received. Check the local API and try again."
            }
            replace(conv)
        }
        isStreaming = false
    }

    private func replace(_ conv: Conversation) {
        if let idx = conversations.firstIndex(where: { $0.id == conv.id }) {
            conversations[idx] = conv
        }
    }
}

struct RootView: View {
    @StateObject private var model = AppModel()
    @State private var showSettings = false
    @AppStorage("Claude-Color-Scheme-Preference") private var schemePref = "system"

    var body: some View {
        NavigationSplitView {
            SidebarView(model: model, showSettings: $showSettings)
        } detail: {
            ChatView(model: model)
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .preferredColorScheme(schemePref == "dark" ? .dark : schemePref == "light" ? .light : nil)
        .tint(Tokens.accent)
        .background(Tokens.surface)
    }
}
