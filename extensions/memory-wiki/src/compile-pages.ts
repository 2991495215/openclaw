import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { retryTransientMemoryRead } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { listMemoryWikiPagePaths } from "./bounded-walk.js";
import { projectMemoryWikiImportInsight } from "./import-insights.js";
import { scanWikiPageSummary, WIKI_PAGE_GROUPS } from "./markdown.js";
import { projectMemoryWikiOverviewItem } from "./wiki-overview.js";

export function prepareWikiPage(bytes: Buffer, scan: ReturnType<typeof scanWikiPageSummary>) {
  const digest = createHash("sha256").update(bytes).digest();
  if (scan.status !== "valid") {
    return { digest, scan, importInsight: null, overviewItem: null };
  }
  // Only normalized facts survive the parse; never retain source text or parsed YAML.
  const { parsed, ...summaryScan } = scan;
  return {
    digest,
    scan: summaryScan,
    importInsight: projectMemoryWikiImportInsight(scan.page, parsed),
    overviewItem: projectMemoryWikiOverviewItem(scan.page, parsed.body),
  };
}

export type PreparedWikiPages = Map<string, ReturnType<typeof prepareWikiPage>>;

export async function readWikiPages(
  rootDir: string,
  signal?: AbortSignal,
): Promise<PreparedWikiPages> {
  const filePaths = (
    await Promise.all(
      WIKI_PAGE_GROUPS.map(async (group) =>
        (await listMemoryWikiPagePaths(rootDir, group.dir)).toSorted((left, right) =>
          left.localeCompare(right),
        ),
      ),
    )
  ).flat();
  signal?.throwIfAborted();
  const readResult = await runTasksWithConcurrency({
    tasks: filePaths.map((relativePath) => async () => {
      signal?.throwIfAborted();
      const absolutePath = path.join(rootDir, relativePath);
      const bytes = await retryTransientMemoryRead(
        () => fs.readFile(absolutePath),
        `read wiki page ${absolutePath}`,
      );
      signal?.throwIfAborted();
      // Yield between large imported pages so background compilation cannot starve Gateway ticks.
      await yieldToEventLoop();
      signal?.throwIfAborted();
      return [
        relativePath,
        prepareWikiPage(
          bytes,
          scanWikiPageSummary({ absolutePath, relativePath, raw: bytes.toString("utf8") }),
        ),
      ] as const;
    }),
    limit: 16,
    errorMode: "stop",
  });
  if (readResult.hasError) {
    throw readResult.firstError;
  }
  signal?.throwIfAborted();
  return new Map(readResult.results);
}

export function collectWikiPages(prepared: PreparedWikiPages) {
  // New reports are inserted in writer order; preserve the scanner's group/path tie order.
  const entries = [...prepared];
  const records = WIKI_PAGE_GROUPS.flatMap((group) =>
    entries
      .filter(([relativePath]) => relativePath.startsWith(`${group.dir}/`))
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, record]) => record),
  );
  return {
    pages: records
      .flatMap(({ scan }) => (scan.status === "valid" ? [scan.page] : []))
      .toSorted((left, right) => left.title.localeCompare(right.title)),
    frontmatterErrors: records.flatMap(({ scan }) =>
      scan.status === "invalid-frontmatter" ? [scan.error] : [],
    ),
    importInsights: records.flatMap(({ importInsight }) => (importInsight ? [importInsight] : [])),
    overviewItems: records.flatMap(({ overviewItem }) => (overviewItem ? [overviewItem] : [])),
  };
}
