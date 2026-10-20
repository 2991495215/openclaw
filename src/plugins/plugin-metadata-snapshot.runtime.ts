/**
 * Lazy bridge for plugin metadata snapshot reads. The snapshot modules pull
 * the control-plane context (installed-plugin index/kysely), which light
 * shared modules and doctor closures must not cold-load at import time.
 *
 * The snapshot module registers its reader here at eval time, so any process
 * that published or scoped a snapshot serves reads through the registered
 * instance. Required resolution lives in plugin-metadata-snapshot-required;
 * current reads never start discovery.
 */
import {
  snapshotReaderSlot,
  type CurrentSnapshotModule,
} from "./plugin-metadata-snapshot-readers.js";

/** Reads the already-published snapshot without waking a cold metadata graph. */
export function getCurrentPluginMetadataSnapshotRuntime(
  params: Parameters<CurrentSnapshotModule["getCurrentPluginMetadataSnapshot"]>[0],
): ReturnType<CurrentSnapshotModule["getCurrentPluginMetadataSnapshot"]> {
  return snapshotReaderSlot.getCurrentPluginMetadataSnapshot?.(params);
}

/** Publishes through the loaded lifecycle owner without waking a cold metadata system. */
export function adoptCurrentPluginMetadataSnapshotIfAbsentRuntime(
  snapshot: Parameters<CurrentSnapshotModule["adoptCurrentPluginMetadataSnapshotIfAbsent"]>[0],
  options: Parameters<CurrentSnapshotModule["adoptCurrentPluginMetadataSnapshotIfAbsent"]>[1],
): void {
  snapshotReaderSlot.adoptCurrentPluginMetadataSnapshotIfAbsent?.(snapshot, options);
}
