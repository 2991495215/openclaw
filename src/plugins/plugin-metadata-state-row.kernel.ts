import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { ConfigMachineStateDatabase } from "../state/config-machine-state.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type {
  PluginMetadataStateKey,
  PluginMetadataStateRow,
} from "./installed-plugin-index-row.js";

export const INSTALLED_PLUGIN_INDEX_STATE_KEY = "plugins.installedIndex";

export function readPluginMetadataStateRowsInDatabase(
  database: DatabaseSync,
  stateKeys: readonly PluginMetadataStateKey[],
): PluginMetadataStateRow[] {
  if (!tableExists(database, "config_machine_state")) {
    return [];
  }
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<ConfigMachineStateDatabase>(database)
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json"])
      .where("state_key", "in", stateKeys),
  ).rows;
}
