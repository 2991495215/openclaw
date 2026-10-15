import Foundation

/// A chat whose own turn has ended while a helper session it started is still running.
struct ChatSubagentWait: Equatable {
    struct Child: Equatable {
        let key: String
        let name: String
    }

    /// Name a single known unfinished helper; the roster may still be partial.
    let child: Child?

    static func resolve(
        session: OpenClawChatSessionEntry?,
        sessions: [OpenClawChatSessionEntry],
        runActive: Bool) -> ChatSubagentWait?
    {
        guard let session, !runActive, session.archived != true,
              session.hasActiveSubagentRun == true, !ChatSessionSidebarModel.isRunning(session)
        else { return nil }
        let running = sessions.filter { row in
            guard row.key != session.key, row.archived != true,
                  ChatSessionSidebarModel.isRunning(row) || row.hasActiveSubagentRun == true
            else { return false }
            if let parent = row.parentSessionKey ?? row.spawnedBy { return parent == session.key }
            return session.childSessions?.contains(row.key) == true
        }
        let child = running.count == 1 ? running.first : nil
        return ChatSubagentWait(child: child.map {
            Child(key: $0.key, name: ChatSessionSidebarModel.displayName(for: $0))
        })
    }
}

extension OpenClawChatViewModel {
    var subagentWait: ChatSubagentWait? {
        ChatSubagentWait.resolve(
            session: self.currentSessionEntry(),
            sessions: self.sessions,
            runActive: self.hasBlockingRunActivity)
    }
}
