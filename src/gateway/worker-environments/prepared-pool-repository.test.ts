import { describe, expect, it } from "vitest";
import {
  PROJECT_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

describe("repository prepared worker reserves", () => {
  const fixture = usePreparedPoolFixture();
  it("refills pinned repository facts with setup disabled across restart and cleanup", async () => {
    const runSetupScript = false;
    const repository: RepositoryWorkerProjectSnapshot = {
      key: PROJECT_KEY,
      baseCommit: "d".repeat(40),
      source: {
        kind: "repository",
        url: "https://github.com/openclaw/prepared-fixture.git",
        repositoryId: "R_prepared_fixture",
        owner: {
          agent: { agentId: "main", provenance: null },
          identity: {
            source: "agent-override",
            profileId: `ghp_${"a".repeat(32)}`,
            accountId: 123,
          },
        },
      },
    };
    await fixture.teardown(
      await fixture.attach(
        await fixture.ready(
          await fixture.seed("repository-source", { repository, runSetupScript }),
        ),
      ),
    );
    await fixture.reopenStore();
    const reconcile: PoolOptions["reconcile"] = async (record, _signal, beforeProvision) => {
      beforeProvision();
      if (record.state === "requested") {
        await fixture.ready(record);
      }
    };
    await fixture.schedule(fixture.pool({ reconcile }));
    const reserve = fixture.reserves()[0]!;
    expect(reserve.profileSnapshot.project).toMatchObject({
      ...repository,
      preparation: { runSetupScript },
    });
    expect(reserve.preparation).toMatchObject({ demandAtMs: 1_000, expiresAtMs: 2_000 });

    await fixture.reopenStore();
    fixture.nowMs = 1_100;
    await fixture.schedule(fixture.pool({ reconcile }));
    expect(fixture.store.get(reserve.environmentId)).toEqual(reserve);
    await fixture.destroy(fixture.store.get(reserve.environmentId)!);
    await fixture.schedule(fixture.pool({ reconcile }));
    expect(fixture.reserves()).toHaveLength(2);
    expect(fixture.reserves().find((record) => record.state === "ready")).toMatchObject({
      profileSnapshot: reserve.profileSnapshot,
      preparation: reserve.preparation,
    });
    expect(fixture.store.get(reserve.environmentId)).toMatchObject({
      state: "destroyed",
      destroyRequestedAtMs: 1_100,
      preparation: reserve.preparation,
    });
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
  });
});
