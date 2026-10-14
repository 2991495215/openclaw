import CryptoKit
import Foundation
import Testing
@testable import OpenClaw

extension BundledRuntimeTests {
    @Test(arguments: ["valid", "corrupt", "missing-digest"])
    func `archive seeding verifies bytes before publishing and preserves native payload`(
        condition: String) async throws
    {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let app = home.appendingPathComponent("Archived.app")
        let dist = try self.makeBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "archive-build", command: "unused")
        let resources = app.appendingPathComponent("Contents/Resources")
        let payload = home.appendingPathComponent("payload")
        try FileManager.default.createDirectory(at: payload, withIntermediateDirectories: true)
        let package = dist.deletingLastPathComponent()
        try FileManager.default.moveItem(at: package, to: payload.appendingPathComponent("package"))
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
        try FileManager.default.copyItem(
            at: payload.appendingPathComponent("package/dist/build-info.json"),
            to: dist.appendingPathComponent("build-info.json"))
        // Archive paths match the runtime root, as they do in the production packager.
        let stagedPackage = payload.appendingPathComponent("lib/node_modules/openclaw")
        try FileManager.default.createDirectory(
            at: stagedPackage.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: payload.appendingPathComponent("package"), to: stagedPackage)
        try FileManager.default.removeItem(at: stagedPackage.appendingPathComponent("dist/build-info.json"))
        let archive = resources.appendingPathComponent("runtime.zip")
        let result = await ShellExecutor.runDetailed(
            command: ["/usr/bin/ditto", "-c", "-k", "--norsrc", payload.path, archive.path],
            cwd: nil, env: [:], timeout: 5)
        #expect(result.success)
        let data = try Data(contentsOf: archive)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let plist = app.appendingPathComponent("Contents/Info.plist")
        var info = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: plist), format: nil) as? [String: Any])
        if condition != "missing-digest" { info["OpenClawRuntimeArchiveSHA256"] = digest }
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: plist)
        if condition == "corrupt" { try Data("corrupt".utf8).write(to: archive) }
        let bundle = try #require(Bundle(url: app))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "archive-fixture"])
        if condition != "valid" {
            await #expect(throws: BundledRuntime.SeedError.self) {
                try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
            }
            #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home) == nil)
            #expect(try FileManager.default.contentsOfDirectory(
                atPath: profile.stateDirectoryURL(homeDirectory: home).appendingPathComponent("runtime").path).isEmpty)
        } else {
            let seeded = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
            #expect(try Data(contentsOf: seeded.packageRoot.appendingPathComponent("openclaw.mjs")) ==
                Data(contentsOf: stagedPackage.appendingPathComponent("openclaw.mjs")))
            #expect(FileManager.default.isExecutableFile(atPath: seeded.bun.path))
            #expect(try String(contentsOf: seeded.root.appendingPathComponent("version-probes"), encoding: .utf8)
                == "probe\n")
        }
    }
}
