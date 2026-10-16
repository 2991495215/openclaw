import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { SessionObserverDeps, SessionObserverRead } from "./session-observer-model.js";
import { defaultPersistDigest } from "./session-observer-model.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";

/** Display facts belong to the projection; digest writes retain their original physical target. */
export function captureSessionObserverRead(
  deps: Pick<
    SessionObserverDeps,
    "getConfig" | "getSessionRowProjection" | "readSession" | "persistDigest"
  >,
  sessionKey: string,
  agentId: string,
): SessionObserverRead {
  const cfg = deps.getConfig();
  const routing = captureSessionMutationRouting(cfg, undefined, [{ sessionKey, agentId }]);
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const projection = deps.getSessionRowProjection?.();
  const query = { key: sessionKey, agentId };
  let captured = projection?.capture(query);
  let target: Parameters<typeof defaultPersistDigest>[0]["target"];
  const assertCurrent = () => {
    routing(deps.getConfig());
    if (
      !deps.readSession &&
      (!projection ||
        deps.getSessionRowProjection?.() !== projection ||
        (captured && !projection.isCurrent(captured)))
    ) {
      throw new Error("Session observer source changed during observation");
    }
  };
  const reader: SessionObserverRead = {
    assertCurrent,
    async withRead(consume) {
      assertCurrent();
      if (deps.readSession) {
        const entry = deps.readSession(sessionKey, agentId);
        assertCurrent();
        return consume(entry);
      }
      if (!projection) {
        throw new Error("Session observer requires its session row projection");
      }
      return withReadySessionRows(
        projection,
        () => [query],
        (read) => {
          assertCurrent();
          const record = read.describe(query, captured);
          if (record) {
            captured ??= projection.capture(query);
            target ??= {
              agentId: record.agentId,
              storePath: record.storeTarget.storePath,
              readSource: read.readSource(record),
              target: { canonicalKey: record.key, storeKeys: [record.key] },
              env,
            };
          }
          return consume(record?.entry);
        },
      );
    },
    async persist(params) {
      assertCurrent();
      if (deps.persistDigest) {
        return deps.persistDigest(params);
      }
      if (!target) {
        // Legacy event adapters still prepare the original writer target before persistence.
        await reader.withRead(() => undefined);
        assertCurrent();
      }
      if (!target) {
        throw new Error("Session observer persistence requires an admitted source");
      }
      return defaultPersistDigest({
        ...params,
        storePath: target.storePath,
        target,
        stillCurrent: () => {
          assertCurrent();
          return params.stillCurrent?.() !== false;
        },
      });
    },
  };
  return reader;
}
