import SwiftUI

/// Header names may be returned by the API; header values are write-only,
/// short-lived editor drafts, cleared when the editor disappears or saves.
struct CloudSettingsHeaderDraft: Identifiable {
    var id = UUID()
    var name = ""
    var value = ""

    static func values(_ rows: [Self]) throws -> [String: String] {
        var result: [String: String] = [:]
        var names: Set<String> = []
        let token = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "!#$%&'*+-.^_`|~"))
        for row in rows {
            let name = row.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.unicodeScalars.allSatisfy(token.contains),
                  !row.value.unicodeScalars.contains("\r"), !row.value.unicodeScalars.contains("\n"), names.insert(name.lowercased()).inserted else {
                throw CloudSettingsHeaderError.invalid
            }
            result[name] = row.value
        }
        return result
    }
}

private enum CloudSettingsHeaderError: Error, LocalizedError {
    case invalid
    var errorDescription: String? { "Use unique HTTP header names and values without line breaks." }
}

struct CloudSettingsHeaderFields: View {
    @Binding var replace: Bool
    @Binding var headers: [CloudSettingsHeaderDraft]
    var savedNames: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionTitle("Extra headers")
            if !savedNames.isEmpty {
                Text("Saved names: " + savedNames.joined(separator: ", ")).font(Type.mono(12, .caption)).foregroundStyle(Praxis.mutedInk)
            }
            SettingsCard {
                Toggle("Replace saved headers", isOn: $replace).font(Type.inter(14, .body)).tint(Praxis.ink).padding(14)
                if replace {
                    ForEach($headers) { $header in
                        SettingsDivider()
                        HStack {
                            TextField("Header name", text: $header.name).font(Type.mono(12, .body))
                                .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("Header name")
                            SecureField("New value", text: $header.value).font(Type.mono(12, .body))
                                .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("Header value")
                            Button { headers.removeAll { $0.id == header.id } } label: { Image(systemName: "minus.circle") }
                                .accessibilityLabel("Remove header")
                        }.padding(14)
                    }
                    SettingsDivider()
                    Button { headers.append(CloudSettingsHeaderDraft()) } label: { CloudSettingsRow(title: "Add header", symbol: "plus") }
                        .buttonStyle(PressHighlightStyle())
                }
            }
            Text("Leaving replacement off keeps the server's saved headers. Replacing with an empty list removes them.")
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
        }
    }
}
