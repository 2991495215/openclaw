import type { DatabaseSync } from "node:sqlite";
import type { Compilable, Kysely, QueryResult } from "kysely";
import * as queries from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase as openNativeDatabase } from "../infra/node-sqlite.js";
import * as transactions from "../infra/sqlite-transaction.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

const legacy = {
  family: "sqlite-runtime-native-access",
  replacement: "openOpenClawAgentSqliteWorkerStoreV2 or the owning domain's awaited operations",
  compatibility:
    "Native SQL and callbacks retain their current completion and transaction ordering.",
} as const;

/** @deprecated Writable runtime handles use openOpenClawAgentSqliteWorkerStoreV2; removed in a later release after the deprecation period. Explicit readOnly inspection remains supported. */
function sdkOpenNodeSqliteDatabase(...args: Parameters<typeof openNativeDatabase>) {
  if (!args[1]?.readOnly) {
    warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.openNodeSqliteDatabase" });
  }
  return openNativeDatabase(...args);
}

/** @deprecated Use sqlite-worker-runtime.getNodeSqliteKysely inside a worker backend; removed in a later release after the deprecation period. */
function sdkGetNodeSqliteKysely<Database>(database: DatabaseSync): Kysely<Database> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.getNodeSqliteKysely" });
  return queries.getNodeSqliteKysely<Database>(database);
}

/** @deprecated Use sqlite-worker-runtime.executeSqliteQuerySync inside a worker backend; removed in a later release after the deprecation period. */
function sdkExecuteSqliteQuerySync<Row>(
  database: DatabaseSync,
  query: Compilable<Row>,
): QueryResult<Row> {
  warnPluginSdkDeprecation({ ...legacy, method: "sqlite-runtime.executeSqliteQuerySync" });
  return queries.executeSqliteQuerySync(database, query);
}

/** @deprecated Use sqlite-worker-runtime.runSqliteImmediateTransactionSync inside a worker backend; removed in a later release after the deprecation period. */
function sdkRunSqliteImmediateTransactionSync<T>(
  database: DatabaseSync,
  operation: () => T,
  options?: transactions.SqliteTransactionOptions,
): T {
  warnPluginSdkDeprecation({
    ...legacy,
    method: "sqlite-runtime.runSqliteImmediateTransactionSync",
  });
  return transactions.runSqliteImmediateTransactionSync(database, operation, options);
}

export {
  sdkOpenNodeSqliteDatabase as openNodeSqliteDatabase,
  sdkGetNodeSqliteKysely as getNodeSqliteKysely,
  sdkExecuteSqliteQuerySync as executeSqliteQuerySync,
  sdkRunSqliteImmediateTransactionSync as runSqliteImmediateTransactionSync,
};
