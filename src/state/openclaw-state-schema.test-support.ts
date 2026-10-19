import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { sha256Hex as sha256 } from "@openclaw/normalization-core/node-crypto";
import { captureFreshDoctorMigrationTables } from "../commands/doctor-migration-backup.js";
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "../infra/client-credential-schema.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { runWithDoctorMigrationBackup } from "../infra/update-doctor-migration-attribution.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { FIRST_USE_STATE_TABLES } from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { createSqliteSchemaShapeFromSql } from "./sqlite-schema-shape.test-support.js";

/** Current catalogs omit the credential tables retained by every pre-cutover source. */
export function addPreCutoverClientCredentialTablesForTest(
  database: Pick<DatabaseSync, "exec">,
): void {
  database.exec(CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
}

/** Historical schema success paths retain the real owner and Doctor's fresh table backup. */
export async function withStateMigrationBackupForTest<T>(
  options: OpenClawStateDatabaseOptions,
  operation: () => T,
): Promise<Awaited<T>> {
  const pathname = options.path ?? resolveOpenClawStateSqlitePath(options.env);
  const lease = acquireGatewayStateOwner({ databasePath: pathname });
  const resources = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: lease.assertCurrent,
    assertDatabaseAccess: lease.assertDatabaseAccess,
  });
  try {
    // Retain asynchronous work in the resource scope until process custody is released.
    return await resources.run(() =>
      runWithDoctorMigrationBackup(captureFreshDoctorMigrationTables, operation),
    );
  } finally {
    await resources.close();
    lease.release();
  }
}

export function createInitialStateSchemaShape(
  deletionJournal: "present" | "unavailable" = "present",
) {
  const shape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-state-schema.sql", import.meta.url),
  );
  for (const tableName of FIRST_USE_STATE_TABLES) {
    delete shape[tableName];
  }
  if (deletionJournal === "unavailable") {
    delete shape.agent_deletion_journal;
  }
  return shape;
}

const V2026_7_1_2_STATE_FIXTURE_URL = new URL(
  "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
  import.meta.url,
);
export const V2026_7_1_2_STATE_FIXTURE_GZIP_SHA256 =
  "c775499d9a46462ae2368090a0c4ec75877784c40694046dd3af63df77b8737c";
export const V2026_7_1_2_STATE_FIXTURE_RAW_SHA256 =
  "8511bb91f02d104f818c70b08397a678045d04741c931b0ee7ce6650b5519e85";

export function materializeV2026_7_1_2StateDatabase(stateDir: string): {
  compressedSha256: string;
  databasePath: string;
  rawSha256: string;
} {
  const compressed = fs.readFileSync(V2026_7_1_2_STATE_FIXTURE_URL);
  const raw = gunzipSync(compressed);
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, raw);
  return {
    compressedSha256: sha256(compressed),
    databasePath,
    rawSha256: sha256(raw),
  };
}
