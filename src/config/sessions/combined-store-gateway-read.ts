import { expectDefined } from "@openclaw/normalization-core";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import { resolveStoredSessionKeyForAgentStore } from "../../gateway/session-store-key.js";
import { createGatewaySessionLineageReaderAsync } from "../../gateway/session-utils-store-lineage.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../../state/agent-deletion-journal.read.js";
import { listOpenIncognitoAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  applyGatewaySessionStoreAdmission,
  mergeCombinedSessionStore,
  type GatewayCombinedSessionStore,
  type GatewaySessionStoreOptions,
} from "./combined-store-gateway.js";
import type { GatewaySessionLineageReader } from "./combined-store-model-sources.js";
import { storeTargetKey } from "./combined-store-paths.js";
import type {
  CombinedSessionStoreTopologyResult,
  PreparedCombinedSessionStore,
} from "./combined-store.types.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import {
  captureIncognitoSessionTopology,
  withIncognitoSessionStoreEntries,
} from "./session-incognito-binding.js";
import {
  captureSessionStoreReadCandidates,
  prepareSessionStoreTargetInventory,
} from "./session-store-target-inventory.js";
import {
  targetDiscoveryLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";
import { listConfiguredSessionStoreAgentIds, type SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

type CombinedReadOptions = Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded">;

export async function loadCombinedSessionStoreForGatewayCoreAsync(
  cfg: OpenClawConfig,
  opts: CombinedReadOptions = {},
): Promise<GatewayCombinedSessionStore> {
  const topology = opts.includeIncognito === false ? undefined : captureIncognitoSessionTopology();
  const env = cloneEnvWithPlatformSemantics(opts.discovery?.env ?? topology?.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  if (topology && env.OPENCLAW_STATE_DIR !== resolveStateDir(topology.env)) {
    throw new Error("Combined discovery belongs to another incognito state root");
  }
  const options = { ...opts, ...(opts.discovery && { discovery: { ...opts.discovery, env } }) };
  const inventory = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    env,
    "recovery",
  );
  const nativeIncognitoTargets =
    !topology && opts.includeIncognito !== false ? listOpenIncognitoAgentDatabases() : [];
  const read = (stores?: readonly IncognitoStore[]) =>
    loadCombinedSessionStore(inventory, options, stores, nativeIncognitoTargets);
  return topology ? withIncognitoSessionStoreEntries(read, options.projection ?? "list") : read();
}

type IncognitoStore = {
  agentId: string;
  storePath: string;
  entries: SessionEntrySummary[];
};

/** Capture missing owners' lineage before synchronous display and model projection. */
export async function prepareCombinedSessionStoreLineage(
  cfg: OpenClawConfig,
  prepared: PreparedCombinedSessionStore,
  readEntries: (target: SessionStoreTarget) => SessionEntrySummary[],
  incognitoStores: readonly IncognitoStore[] = [],
): Promise<GatewaySessionLineageReader> {
  const owners = new Set(prepared.targets.preparedAgentIds);
  const rows: Array<{ agentId: string; sessionKey: string; entry: SessionEntry }> = [];
  for (const { target, storeTarget } of prepared.reads) {
    const shared = prepared.targets.sharedStoreRowOwner;
    const rowAgentId =
      shared?.target.storePath === target.storePath && shared.target.agentId === target.agentId
        ? shared.agentId
        : target.agentId;
    owners.add(target.agentId);
    owners.add(storeTarget.agentId);
    owners.add(rowAgentId);
    for (const row of readEntries(storeTarget)) {
      const agentId = normalizeAgentId(parseAgentSessionKey(row.sessionKey)?.agentId ?? rowAgentId);
      owners.add(agentId);
      rows.push({ ...row, agentId });
    }
  }
  for (const store of incognitoStores) {
    for (const row of store.entries) {
      rows.push({ ...row, agentId: store.agentId });
    }
  }
  const identity = (agentId: string, key: string) => JSON.stringify([agentId, key]);
  const parents = new Map<
    string,
    { agentId: string; parentKey: string; owner: string; storedKey: string }
  >();
  for (const { agentId, sessionKey, entry } of rows) {
    for (const parent of [
      entry.parentSessionKey,
      entry.spawnedBy,
      resolveSessionParentSessionKey(sessionKey),
    ]) {
      const parentKey = parent?.trim();
      const parsed = parentKey ? parseAgentSessionKey(parentKey) : undefined;
      if (!parentKey || !parsed) {
        continue;
      }
      const owner = normalizeAgentId(parsed.agentId);
      if (!owners.has(owner)) {
        parents.set(identity(agentId, parentKey), {
          agentId,
          parentKey,
          owner,
          storedKey: resolveStoredSessionKeyForAgentStore({
            cfg,
            agentId: owner,
            sessionKey: parentKey,
            preserveQualifiedAddress: true,
          }),
        });
      }
    }
  }
  const reader = createGatewaySessionLineageReaderAsync(cfg);
  const stored = new Map<string, Promise<SessionEntry | undefined>>();
  for (const { owner, storedKey } of parents.values()) {
    const key = identity(owner, storedKey);
    if (!stored.has(key)) {
      stored.set(key, reader.readStored(owner, storedKey));
    }
  }
  const entries = new Map(
    await Promise.all([...stored].map(async ([key, row]) => [key, await row] as const)),
  );
  const aliases = new Map(
    await Promise.all(
      [...parents].map(
        async ([key, parent]) =>
          [
            key,
            entries.get(identity(parent.owner, parent.storedKey)) === undefined
              ? await reader.readAlias(parent.parentKey, parent.agentId)
              : undefined,
          ] as const,
      ),
    ),
  );
  return {
    readStored: (agentId, key) => entries.get(identity(agentId, key)),
    readAlias: (key, agentId) => aliases.get(identity(agentId, key)),
  };
}

/** Prepare durable topology in one worker request before a synchronous projection publication. */
export async function prepareCombinedSessionStoreForGatewayAsync(
  cfg: OpenClawConfig,
  options: CombinedReadOptions,
  scopeAgentIds?: readonly string[],
): Promise<CombinedSessionStoreTopologyResult> {
  const env = options.discovery?.env ?? process.env;
  const inventory = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    env,
    "recovery",
  );
  return readCombinedSessionStoreTopology(inventory, options, scopeAgentIds);
}

async function readCombinedSessionStoreTopology(
  inventory: ReturnType<typeof prepareSessionStoreTargetInventory>,
  options: CombinedReadOptions,
  scopeAgentIds?: readonly string[],
): Promise<CombinedSessionStoreTopologyResult> {
  const { config, env } = inventory;
  const discovery = options.discovery ?? {
    env,
    snapshot: (await prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime").read()).snapshot,
  };
  const candidates = [
    ...inventory.candidates,
    ...(discovery.snapshot?.registeredAgentDatabases ?? []).flatMap(({ path }) =>
      captureSessionStoreReadCandidates(path),
    ),
  ];
  return withSessionHistoryWorkerReadCandidates(
    candidates,
    async (owner) => {
      const result = await owner.readCombinedTopology({
        config,
        options: { ...options, includeIncognito: false, discovery },
        scopeAgentIds,
      });
      result.prepared.targets = applyGatewaySessionStoreAdmission(
        config,
        options,
        result.prepared.targets,
      );
      result.prepared.reads = result.prepared.targets.durableTargets.map((target) => ({
        target,
        storeTarget: expectDefined(
          result.prepared.targets.physicalTargets.get(storeTargetKey(target)),
          "physical store",
        ),
      }));
      return result;
    },
    targetDiscoveryLane,
  );
}

/** Descriptive listings consume one captured topology; later changes belong to the next read. */
async function loadCombinedSessionStore(
  inventory: ReturnType<typeof prepareSessionStoreTargetInventory>,
  options: CombinedReadOptions,
  incognitoStores?: readonly IncognitoStore[],
  nativeIncognitoTargets: ReturnType<typeof listOpenIncognitoAgentDatabases> = [],
): Promise<GatewayCombinedSessionStore> {
  const { config, env } = inventory;
  const { prepared } = await readCombinedSessionStoreTopology(inventory, options);
  // Unbound private stores remain with their existing process-local owner.
  prepared.targets.incognitoTargets = (incognitoStores ?? nativeIncognitoTargets).filter(
    (store) =>
      !prepared.targets.requestedAgentId || store.agentId === prepared.targets.requestedAgentId,
  );
  // Windows environment proxies cannot cross the worker boundary.
  const transferEnv = { ...env, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR };
  return withSessionHistoryWorkerDatabases(
    prepared.reads.map(({ storeTarget }) => ({
      agentId: storeTarget.agentId,
      path: storeTarget.storePath,
      env,
    })),
    async (owners) => {
      const rows = await Promise.all(
        prepared.reads.map(async ({ storeTarget }, index) => {
          const source = expectDefined(owners[index], "retained session store");
          const { entries } = await source.readEntries({
            ...storeTarget,
            env: transferEnv,
            projection: prepared.projection,
            clone: false,
          });
          return [storeTargetKey(storeTarget), entries] as const;
        }),
      );
      const entries = new Map(rows);
      const readEntries = (target: SessionStoreTarget) =>
        expectDefined(entries.get(storeTargetKey(target)), "prepared session entries");
      const lineage = await prepareCombinedSessionStoreLineage(
        config,
        prepared,
        readEntries,
        incognitoStores,
      );
      return mergeCombinedSessionStore(
        config,
        options,
        prepared,
        readEntries,
        lineage,
        incognitoStores &&
          ((target) =>
            expectDefined(
              incognitoStores.find((store) => store.storePath === target.storePath),
              "captured actor",
            ).entries),
      );
    },
  );
}
