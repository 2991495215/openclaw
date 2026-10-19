import type { DatabaseSync } from "node:sqlite";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { invalidateSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX } from "./openclaw-state-db-schema-migration-required.js";
const LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX_SQL =
  "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)";

function normalizeSqliteCatalogSql(sql: string): string {
  return sql
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim();
}

export function withSqliteWritableSchema<T>(database: DatabaseSync, operation: () => T): T {
  database.enableDefensive?.(false);
  // sqlite-allow-raw -- Exact legacy catalog admission requires SQLite's writable-schema pragma.
  database.exec("PRAGMA writable_schema = ON;");
  try {
    return operation();
  } finally {
    try {
      // sqlite-allow-raw -- OFF retains the schema loaded while malformed rows were ignored.
      database.exec("PRAGMA writable_schema = RESET;");
    } finally {
      database.enableDefensive?.(true);
    }
  }
}

/** Detect only the known v15 review index left behind after its column was retired. */
export function hasDanglingSkillWorkshopCollectionReviewIndex(database: DatabaseSync): boolean {
  return withSqliteWritableSchema(database, () =>
    inspectSkillWorkshopCollectionReviewIndex(database),
  );
}

function inspectSkillWorkshopCollectionReviewIndex(database: DatabaseSync): boolean {
  const index = database // sqlite-allow-raw -- Inspect the exact malformed catalog row before ordinary schema parsing.
    .prepare("SELECT tbl_name, rootpage, sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
    .get(LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX);
  if (
    index?.tbl_name !== "skill_workshop_collection_reviews" ||
    typeof index.rootpage !== "number" ||
    index.rootpage <= 0 ||
    typeof index.sql !== "string" ||
    normalizeSqliteCatalogSql(index.sql) !==
      normalizeSqliteCatalogSql(LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX_SQL)
  ) {
    return false;
  }
  const columns = database // sqlite-allow-raw -- Validate physical columns without parsing the malformed index.
    .prepare("PRAGMA table_info(skill_workshop_collection_reviews)")
    .all();
  return (
    columns.some((column) => column.name === "owner_agent_id") &&
    !columns.some((column) => column.name === "workspace_dir")
  );
}

/** Doctor can inspect the exact legacy defect before its repair transaction. */
export function openDoctorStateSchemaReadAdmission(
  database: EngineConnection,
): (() => void) | undefined {
  // PostgreSQL readers already hold catalog admission; damaged SQLite indexes do not apply.
  if (isPostgresSqlConnection(database)) {
    return undefined;
  }
  invalidateSqliteSchemaFacts(database);
  if (!hasDanglingSkillWorkshopCollectionReviewIndex(database)) {
    return undefined;
  }
  database.enableDefensive?.(false);
  try {
    // sqlite-allow-raw -- Hold exact legacy catalog admission for a bounded read-only operation.
    database.exec("PRAGMA writable_schema = ON;");
  } catch (error) {
    database.enableDefensive?.(true);
    throw error;
  }
  let open = true;
  return () => {
    if (!open) {
      return;
    }
    open = false;
    try {
      // sqlite-allow-raw -- Restore ordinary schema parsing before releasing the read-only handle.
      database.exec("PRAGMA writable_schema = RESET;");
    } finally {
      database.enableDefensive?.(true);
    }
  };
}

/**
 * Make the known malformed index parseable, then let SQLite drop and reclaim it
 * in the caller's transaction. A failed repair rolls both catalog edits back.
 */
export function repairDanglingSkillWorkshopCollectionReviewIndex(database: DatabaseSync): boolean {
  if (!hasDanglingSkillWorkshopCollectionReviewIndex(database)) {
    return false;
  }
  return withSqliteWritableSchema(database, () => {
    database // sqlite-allow-raw -- Repair the exact malformed catalog row before ordinary schema parsing.
      .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'index' AND name = ?")
      .run(
        `CREATE INDEX ${LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX} ON skill_workshop_collection_reviews(create_time DESC, review_id DESC)`,
        LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX,
      );
    // SAFETY: the pragma result is treated as unknown and validated before arithmetic.
    const row = database // sqlite-allow-raw -- Read SQLite's schema cookie before reloading the repaired catalog.
      .prepare("PRAGMA schema_version")
      .get() as {
      schema_version?: unknown;
    };
    const schemaVersion = typeof row.schema_version === "number" ? row.schema_version : 0;
    // sqlite-allow-raw -- Bump the schema cookie and reparse the repaired catalog.
    database.exec(`PRAGMA schema_version = ${schemaVersion + 1}; PRAGMA writable_schema = OFF;`);
    // sqlite-allow-raw -- Drop the repaired legacy index inside the caller's transaction.
    database.exec(`DROP INDEX ${LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX};`);
    return true;
  });
}
