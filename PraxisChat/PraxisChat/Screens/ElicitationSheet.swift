import SwiftUI
import AgentCore
import AgentMCP

/// A connector asking the user for something mid-call: a small form, or
/// consent to open a URL. Always names the server and offers all three
/// answers the protocol has: accept (Submit / Open), Decline (an explicit
/// no) and Cancel (dismissed without deciding; swiping away does the
/// same). URLs show their host up front and in full below, and open only
/// after the user taps Open, in a Safari view the app can't read.
struct ElicitationSheet: View {
    let pending: ElicitationCenter.Pending
    @Environment(ChatStore.self) private var store
    @State private var form: ElicitationForm
    /// Fields the user has left (their errors show from then on).
    @State private var touched: Set<String> = []
    @State private var showAllErrors = false
    @State private var showSafari: URL?
    @FocusState private var focused: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(pending: ElicitationCenter.Pending) {
        self.pending = pending
        if case .form(let schema) = pending.request.kind {
            _form = State(initialValue: ElicitationForm(schema: schema))
        } else {
            _form = State(initialValue: ElicitationForm(schema: ["type": "object", "properties": [:]]))
        }
    }

    private var request: MCPElicitation { pending.request }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    switch request.kind {
                    case .form:
                        if !form.fields.isEmpty { formCard }
                    case .url(let url):
                        urlConsent(url)
                    }
                    actions
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .background(Praxis.canvas)
            .navigationTitle("Connector request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { respond(.cancel) }
                        .foregroundStyle(Praxis.ink)
                        .accessibilityLabel("Cancel request")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onChange(of: focused) { old, _ in
            if let old { touched.insert(old) }
        }
        // Swiped away without an answer: the asking call gets `cancel`.
        .onDisappear {
            if store.services?.elicitations.queue.contains(where: { $0.id == pending.id }) == true {
                store.services?.elicitations.respond(pending.id, with: .cancel)
            }
        }
        .fullScreenCover(item: $showSafari, onDismiss: { respond(.accept(nil)) }) { url in
            SafariView(url: url).ignoresSafeArea()
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IntegrationAvatar(monogram: String(request.serverName.prefix(1)).uppercased())
                Text(isURL ? "\(request.serverName) wants to open a page" : "\(request.serverName) asks")
                    .font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
            }
            .accessibilityElement(children: .combine)
            if !request.message.isEmpty {
                Text(request.message).font(Type.inter(15, .body)).foregroundStyle(Praxis.secondaryInk).lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var isURL: Bool {
        if case .url = request.kind { return true }
        return false
    }

    // MARK: Form

    private var formCard: some View {
        SettingsCard {
            ForEach(form.fields) { field in
                if field.id != form.fields.first?.id { SettingsDivider() }
                FieldRow(field: field, form: $form, focused: $focused,
                         problem: shownProblem(field))
            }
        }
        .animation(reduceMotion ? Motion.reduced : Motion.reflow, value: shownProblems)
    }

    /// Errors appear once a field has been left, or after a submit try —
    /// not while the user is still typing the first characters.
    private func shownProblem(_ field: ElicitationField) -> String? {
        guard showAllErrors || touched.contains(field.key) else { return nil }
        return form.problem(for: field)
    }

    private var shownProblems: [String] { form.fields.compactMap { shownProblem($0) } }

    // MARK: URL consent

    private func urlConsent(_ url: URL) -> some View {
        let host = url.host() ?? url.absoluteString
        let serverHost = store.services?.connectors.server(request.serverID)?.url.host()
        return VStack(alignment: .leading, spacing: 10) {
            SettingsCard {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Opens").font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                    Text(host).font(Type.inter(17, weight: .semibold, .headline)).foregroundStyle(Praxis.ink)
                        .accessibilityIdentifier("elicitationHost")
                    Text(url.absoluteString)
                        .font(Type.mono(12, .footnote))
                        .foregroundStyle(Praxis.secondaryInk)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let serverHost, !Self.sameSite(host, serverHost) {
                Label("This page isn't on \(serverHost), the connector's own address.", systemImage: "exclamationmark.triangle")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
            }
            Text("It opens in a browser inside Praxis. What you enter there goes to that site; Praxis and the model don't see it.")
                .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// `auth.acme.com` and `mcp.acme.com` are the same site for this note.
    private static func sameSite(_ a: String, _ b: String) -> Bool {
        func site(_ host: String) -> String { host.lowercased().split(separator: ".").suffix(2).joined(separator: ".") }
        return site(a) == site(b)
    }

    // MARK: Answers

    private var actions: some View {
        VStack(spacing: 10) {
            Button(action: accept) {
                PraxisButtonLabel(primaryTitle)
            }
            .buttonStyle(.praxisPrimary(fillsWidth: true))
            .accessibilityLabel(primaryTitle)

            Button { respond(.decline) } label: {
                PraxisButtonLabel("Decline")
            }
            .buttonStyle(.praxisSecondary(fillsWidth: true))
            .accessibilityLabel("Decline")
        }
        .padding(.top, 4)
    }

    private var primaryTitle: String {
        if case .url(let url) = request.kind { return "Open \(url.host() ?? "page")" }
        return "Submit"
    }

    private func accept() {
        switch request.kind {
        case .url(let url):
            showSafari = url
        case .form:
            guard let content = form.content() else {
                withAnimation(reduceMotion ? Motion.reduced : Motion.reflow) { showAllErrors = true }
                store.haptics.fire(.warning)
                return
            }
            respond(.accept(content))
        }
    }

    private func respond(_ result: MCPElicitationResult) {
        store.haptics.fire(.selection)
        store.services?.elicitations.respond(pending.id, with: result)
    }
}

// MARK: Field rows

private struct FieldRow: View {
    let field: ElicitationField
    @Binding var form: ElicitationForm
    var focused: FocusState<String?>.Binding
    let problem: String?

    private var text: Binding<String> {
        Binding(get: { form.values[field.key] ?? "" }, set: { form.values[field.key] = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            control
            if let hint {
                Text(hint).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let problem {
                Text(problem).font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.destructive)
                    .transition(.opacity)
                    .accessibilityLabel("\(field.title): \(problem)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 48)
    }

    private var label: some View {
        HStack(spacing: 4) {
            Text(field.title).font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
            if !field.isRequired && field.kind != .boolean {
                Text("Optional").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk.opacity(0.7))
            }
        }
    }

    @ViewBuilder
    private var control: some View {
        switch field.kind {
        case .boolean:
            Toggle(isOn: Binding(get: { form.flags[field.key] ?? false }, set: { form.flags[field.key] = $0 })) {
                Text(field.title).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
            }
            .tint(Praxis.ink)
        case .choice(let options):
            HStack {
                Text(field.title).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                Spacer()
                Picker(field.title, selection: text) {
                    if !field.isRequired || (form.values[field.key] ?? "").isEmpty {
                        Text(field.isRequired ? "Choose" : "None").tag("")
                    }
                    ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                        Text(field.choiceTitles.indices.contains(index) ? field.choiceTitles[index] : option).tag(option)
                    }
                }
                .tint(Praxis.secondaryInk)
                .accessibilityLabel(field.title)
            }
        case .text where field.format == .date || field.format == .dateTime:
            dateControl
        case .text, .number, .integer:
            VStack(alignment: .leading, spacing: 4) {
                label
                TextField(placeholder, text: text)
                    .font(Type.inter(15, .body))
                    .foregroundStyle(Praxis.ink)
                    .keyboardType(keyboard)
                    .textContentType(field.format == .email ? .emailAddress : field.format == .uri ? .URL : nil)
                    .textInputAutocapitalization(field.format == nil && field.kind == .text ? .sentences : .never)
                    .autocorrectionDisabled(field.format != nil || field.kind != .text)
                    .focused(focused, equals: field.key)
                    .accessibilityLabel(field.title)
            }
        }
    }

    /// Date formats get a picker; the value stays the ISO text the
    /// schema asks for. Optional dates start empty ("Add").
    @ViewBuilder
    private var dateControl: some View {
        let isDateTime = field.format == .dateTime
        let current = (form.values[field.key]).flatMap {
            isDateTime ? ElicitationField.dateTime($0) : ElicitationField.dateFormatter.date(from: $0)
        }
        HStack {
            label
            Spacer()
            if let current {
                DatePicker(field.title, selection: Binding(get: { current }, set: { set($0, isDateTime) }),
                           displayedComponents: isDateTime ? [.date, .hourAndMinute] : [.date])
                    .labelsHidden()
                    .accessibilityLabel(field.title)
                if !field.isRequired {
                    Button { form.values[field.key] = nil } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Praxis.mutedInk)
                    }
                    .accessibilityLabel("Clear \(field.title)")
                }
            } else {
                Button("Add") { set(Date(), isDateTime) }
                    .buttonStyle(.praxisText)
                    .accessibilityLabel("Add \(field.title)")
            }
        }
    }

    private func set(_ date: Date, _ isDateTime: Bool) {
        form.values[field.key] = isDateTime ? ElicitationField.dateTimeString(date) : ElicitationField.dateFormatter.string(from: date)
    }

    private var keyboard: UIKeyboardType {
        switch field.kind {
        case .integer: return (field.minimum ?? -1) < 0 ? .numbersAndPunctuation : .numberPad
        case .number: return (field.minimum ?? -1) < 0 ? .numbersAndPunctuation : .decimalPad
        default:
            switch field.format {
            case .email?: return .emailAddress
            case .uri?: return .URL
            default: return .default
            }
        }
    }

    private var placeholder: String {
        switch field.format {
        case .email?: return "name@example.com"
        case .uri?: return "https://"
        default: return field.kind == .text ? "" : "0"
        }
    }

    /// The description, plus the bounds a number or text must keep to.
    private var hint: String? {
        var parts: [String] = []
        if let detail = field.detail, !detail.isEmpty { parts.append(detail) }
        switch (field.minimum, field.maximum) {
        case let (lo?, hi?): parts.append("Between \(ElicitationField.format(lo)) and \(ElicitationField.format(hi)).")
        case let (lo?, nil): parts.append("At least \(ElicitationField.format(lo)).")
        case let (nil, hi?): parts.append("At most \(ElicitationField.format(hi)).")
        default: break
        }
        if let max = field.maxLength { parts.append("Up to \(max) characters.") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}
