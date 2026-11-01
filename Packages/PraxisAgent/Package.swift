// swift-tools-version: 6.2
import PackageDescription

/// On-device agent runtime for Praxis Chat. Provider-agnostic loop
/// (Anthropic- and OpenAI-compatible), tools (JS runner, remote MCP,
/// skills). No UI here: the app maps `AgentEvent`s onto its transcript.
let package = Package(
    name: "PraxisAgent",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "AgentCore", targets: ["AgentCore"]),
        .library(name: "AgentProviders", targets: ["AgentProviders"]),
        .library(name: "AgentSkills", targets: ["AgentSkills"]),
        .library(name: "AgentJS", targets: ["AgentJS"]),
        .library(name: "AgentMCP", targets: ["AgentMCP"]),
        .library(name: "AgentRuntime", targets: ["AgentRuntime"]),
        .library(name: "AgentTestSupport", targets: ["AgentTestSupport"]),
    ],
    targets: [
        .target(name: "AgentCore"),
        .target(name: "AgentProviders", dependencies: ["AgentCore"]),
        .target(name: "AgentSkills", dependencies: ["AgentCore"]),
        // --- JS runner: owned by the AgentJS work stream ---
        // Vendored quickjs-ng (see Sources/CQuickJS/VENDORED.md) + Swift shim.
        .target(
            name: "CQuickJS",
            path: "Sources/CQuickJS",
            exclude: ["LICENSE", "VENDORED.md"],
            cSettings: [
                .define("_GNU_SOURCE"),
                .define("QUICKJS_NG_BUILD"),
                // Release builds drop the engine's internal asserts (as upstream's CMake does).
                .define("NDEBUG", .when(configuration: .release)),
                // Upstream builds with unsigned `char`; `-w` silences vendored-code warnings.
                // The interpreter is always optimized: time budgets are wall-clock based and an
                // -O0 interpreter would make debug runs several times slower than release.
                .unsafeFlags(["-funsigned-char", "-w", "-O2"]),
            ]
        ),
        .target(name: "AgentJS", dependencies: ["AgentCore", "CQuickJS"]),
        // --- end JS runner ---
        .target(name: "AgentMCP", dependencies: ["AgentCore"]),
        .target(name: "AgentRuntime", dependencies: ["AgentCore", "AgentProviders", "AgentSkills", "AgentJS", "AgentMCP"]),
        .target(name: "AgentTestSupport", dependencies: ["AgentCore"]),

        .testTarget(name: "AgentCoreTests", dependencies: ["AgentCore", "AgentTestSupport"]),
        .testTarget(name: "AgentProvidersTests", dependencies: ["AgentProviders", "AgentTestSupport"],
                    resources: [.copy("Fixtures")]),
        .testTarget(name: "AgentSkillsTests", dependencies: ["AgentSkills", "AgentTestSupport"]),
        .testTarget(name: "AgentJSTests", dependencies: ["AgentJS", "AgentTestSupport"]),
        .testTarget(name: "AgentMCPTests", dependencies: ["AgentMCP", "AgentTestSupport"]),
        .testTarget(name: "AgentRuntimeTests", dependencies: ["AgentRuntime", "AgentTestSupport"]),
    ],
    swiftLanguageModes: [.v6]
)
