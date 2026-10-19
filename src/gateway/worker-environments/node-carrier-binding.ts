import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { isUsableWorkerEnvironmentState } from "./state.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export type WorkerNodeCarrierBinding = {
  environmentId: string;
  leaseId: string;
  nodeDeviceId: string;
  ownerEpoch: number;
};

export type WorkerNodeCarrierRuntime = {
  transport: NodeWorkerSupervisorTransport;
  streamBroker: NodeDesktopStreamBroker;
};

export function snapshotWorkerNodeCarrierBinding(
  record: WorkerEnvironmentRecord | undefined,
  message: string,
  ownerEpoch = record?.ownerEpoch,
): WorkerNodeCarrierBinding {
  if (
    !record ||
    !isUsableWorkerEnvironmentState(record.state) ||
    record.destroyRequestedAtMs !== null ||
    !record.leaseId ||
    !record.nodeDeviceId ||
    record.sshEndpoint !== null ||
    record.ownerEpoch !== ownerEpoch
  ) {
    throw new Error(message);
  }
  return {
    environmentId: record.environmentId,
    leaseId: record.leaseId,
    nodeDeviceId: record.nodeDeviceId,
    ownerEpoch: record.ownerEpoch,
  };
}

export function isWorkerNodeCarrierBindingCurrent(
  current: WorkerEnvironmentRecord | undefined,
  binding: WorkerNodeCarrierBinding,
): boolean {
  return Boolean(
    current &&
    isUsableWorkerEnvironmentState(current.state) &&
    current.destroyRequestedAtMs === null &&
    current.leaseId === binding.leaseId &&
    current.nodeDeviceId === binding.nodeDeviceId &&
    current.sshEndpoint === null &&
    current.ownerEpoch === binding.ownerEpoch,
  );
}
