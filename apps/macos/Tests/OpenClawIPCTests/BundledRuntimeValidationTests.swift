import Foundation
import Testing
@testable import OpenClaw

struct BundledRuntimeValidationTests {
    @Test(arguments: [false, true])
    func `routine identity lookup leaves full payload validation to seed admission`(existingSeed: Bool) async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let app = home.appendingPathComponent("Fixture.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "validation-build", command: "unused")
        let bundle = try #require(Bundle(url: app))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "validation-fixture"])
        let runtime: BundledRuntime = if existingSeed {
            try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        } else {
            try BundledRuntime.resolve(bundle: bundle)
        }
        let nested = runtime.packageRoot.appendingPathComponent("dist/nested/resource")
        try FileManager.default.createDirectory(
            at: nested.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Data("changed payload".utf8).write(to: nested)

        let discovered = try #require(try BundledRuntime.validatedStandaloneManifest(executable: runtime.executable))
        #expect(discovered.buildId == "validation-build")
        let selected = try BundledRuntime.forAppHosting(bundle: bundle, profile: profile, homeDirectory: home)
        #expect(selected.root.resolvingSymlinksInPath().path == runtime.root.resolvingSymlinksInPath().path)
        await #expect(throws: BundledRuntime.ValidationError.self) {
            try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        }
        let current = profile.stateDirectoryURL(homeDirectory: home).appendingPathComponent("runtime/current")
        #expect(FileManager.default.fileExists(atPath: current.path) == existingSeed)
    }
}
