import { randomUUID } from "node:crypto";
import { createObjectIdAllocator } from "../shared/object-id.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const rowId = createObjectIdAllocator(1);
const revisions = new WeakMap<GatewaySessionRow[], string>();

export type SessionRowGeneration = { revision: string; ids: Float64Array };

export function sessionRowId(row: GatewaySessionRow): number {
  return rowId(row);
}

export function sessionRowsRevision(rows: GatewaySessionRow[]): string {
  let revision = revisions.get(rows);
  if (revision === undefined) {
    revision = randomUUID();
    revisions.set(rows, revision);
  }
  return revision;
}

export function captureSessionRowGeneration(rows: GatewaySessionRow[]): SessionRowGeneration {
  // Float64 preserves integer identities past 2^32 without retaining their row objects.
  return { revision: sessionRowsRevision(rows), ids: Float64Array.from(rows, sessionRowId) };
}
