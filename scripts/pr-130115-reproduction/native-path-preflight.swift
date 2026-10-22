import Darwin
import Foundation

// Run before the product build, using the exact HOME/profile/state planned for XCTest.
// Path suffixes are source-audited in MacControlProfile, MacControlAuthentication,
// MacControlServer and ExecApprovalsStore; this probe does not start these owners.
let environment = ProcessInfo.processInfo.environment
func required(_ key: String) throws -> String {
    guard let value = environment[key], !value.isEmpty else {
        throw NSError(domain: "NativePathPreflight", code: 1, userInfo: [NSLocalizedDescriptionKey: key])
    }
    return value
}
func canonical(_ value: String) -> URL {
    URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
}
guard try required("GITHUB_ACTIONS") == "true",
      try required("RUNNER_ENVIRONMENT") == "github-hosted",
      try required("OPENCLAW_PROFILE") == "default" else {
    fatalError("Only the isolated default profile on the disposable runner is permitted")
}
let runner = canonical(try required("RUNNER_TEMP"))
let expectedHome = canonical(try required("HOME"))
let fixedHome = canonical(try required("CFFIXED_USER_HOME"))
let nativeHome = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.resolvingSymlinksInPath()
let state = canonical(try required("OPENCLAW_STATE_DIR"))
let applicationSupport = try FileManager.default.url(
    for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
guard expectedHome == fixedHome, nativeHome == expectedHome,
      expectedHome.path.hasPrefix(runner.path + "/"), state.path.hasPrefix(runner.path + "/"),
      applicationSupport.path.hasPrefix(nativeHome.path + "/") else {
    fatalError("Foundation HOME or state root differs from the isolated fixture")
}
let socketPaths = [
    nativeHome.appendingPathComponent(".openclaw/mac-control.sock").path,
    state.appendingPathComponent("exec-approvals.sock").path,
    applicationSupport.appendingPathComponent("OpenClaw/cua/0000000000000000/cua.sock").path,
]
let maximum = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
let safe = socketPaths.allSatisfy { $0.utf8.count < maximum }
let receipt: [String: Any] = [
    "nativeHome": nativeHome.path, "stateRoot": state.path, "sunPathCapacity": maximum,
    "sockets": socketPaths.map { ["path": $0, "utf8Bytes": $0.utf8.count] as [String: Any] },
    "status": safe ? "paths_fit" : "path_too_long", "proofVerdict": "not_assessed",
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]))
guard safe else { exit(2) }
