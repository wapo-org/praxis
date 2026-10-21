import SwiftUI

struct SettingsView: View {
    @AppStorage(APIClient.baseURLDefaultsKey) private var baseURL = ""
    @AppStorage("Wapo-API-Token") private var token = ""
    @AppStorage("Claude-Color-Scheme-Preference") private var schemePref = "system"
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://localhost:8000", text: $baseURL)
                        .font(Tokens.codeMono)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("settings.baseURL")
                    SecureField("Bearer token (optional)", text: $token)
                        .font(Tokens.codeMono)
                        .accessibilityIdentifier("settings.token")
                } header: {
                    Text("Local API")
                } footer: {
                    Text("Empty uses \(APIClient.defaultBaseURL.absoluteString). Key name mirrors the reference override.")
                        .font(Tokens.captionSans)
                }
                Section("Appearance") {
                    Picker("Color scheme", selection: $schemePref) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .font(Tokens.bodySans)
                }
                Section("About") {
                    LabeledContent("Client", value: "Wapo reconstruction")
                    LabeledContent("Reference", value: "1.261007.20 (37720259229)")
                    LabeledContent("Min OS", value: "iOS 18.0")
                }
                .font(Tokens.bodySans)
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("settings.done")
                }
            }
        }
    }
}
