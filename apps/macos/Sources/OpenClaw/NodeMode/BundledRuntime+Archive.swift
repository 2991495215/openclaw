import CryptoKit
import Foundation

extension BundledRuntime {
    /// Only signed build metadata selects extraction; a missing/corrupt archive fails closed.
    static func extractArchive(bundle: Bundle, to destination: URL) async throws {
        let archive = bundle.bundleURL.appendingPathComponent("Contents/Resources/runtime.zip")
        guard let expected = bundle.infoDictionary?["OpenClawRuntimeArchiveSHA256"] as? String else {
            guard !FileManager.default.fileExists(atPath: archive.path) else {
                throw SeedError.archive("Missing integrity metadata. Reinstall OpenClaw.app.")
            }
            return
        }
        let source = try FileHandle(forReadingFrom: archive)
        defer { try? source.close() }
        var hash = SHA256()
        while let data = try source.read(upToCount: 1024 * 1024), !data.isEmpty {
            try Task.checkCancellation()
            hash.update(data: data)
        }
        let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == expected else {
            throw SeedError.archive("Integrity check failed. Reinstall OpenClaw.app.")
        }
        let result = await ShellExecutor.runDetailed(
            command: ["/usr/bin/ditto", "-x", "-k", archive.path, destination.path],
            cwd: nil,
            env: [:],
            timeout: 300)
        guard result.success else {
            throw SeedError.archive("Extraction failed: \(result.errorMessage ?? result.stderr)")
        }
    }
}
