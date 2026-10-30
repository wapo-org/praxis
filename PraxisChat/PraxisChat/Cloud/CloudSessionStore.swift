import Foundation
import Security

/// The only persisted cloud secret. Keychain account is the canonical server
/// origin, so changing servers can never forward another server's token.
actor CloudSessionStore {
    private let service: String
    private let inMemory: Bool
    private var memory: [String: String] = [:]

    init(service: String = "com.praxis.chat.cloud-session", inMemory: Bool = false) {
        self.service = service
        self.inMemory = inMemory
    }

    func token(for origin: String) throws -> String? {
        if inMemory { return memory[origin] }
        var query = query(origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else { throw CloudSessionError.keychain(status) }
        return token
    }

    func setToken(_ token: String?, for origin: String) throws {
        if inMemory { memory[origin] = token; return }
        let query = query(origin)
        guard let token else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw CloudSessionError.keychain(status) }
            return
        }
        let values = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var item = query.merging(values) { _, new in new }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw CloudSessionError.keychain(added) }
        } else if status != errSecSuccess { throw CloudSessionError.keychain(status) }
    }

    private func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: origin]
    }
}

enum CloudSessionError: Error, LocalizedError {
    case keychain(OSStatus), missingToken
    var errorDescription: String? {
        switch self {
        case .keychain: "Couldn't access the cloud session on this device."
        case .missingToken: "The server did not return a session token."
        }
    }
}
