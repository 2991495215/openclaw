import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";

function cloudWorkerConfigExamples(filePath: string): unknown[] {
  const markdown = fs.readFileSync(path.join(process.cwd(), filePath), "utf8");
  return Array.from(markdown.matchAll(/```(?:json5|json)\n([\s\S]*?)```/gu))
    .map((match) => match[1] ?? "")
    .filter((source) => /["']?cloudWorkers["']?\s*:/u.test(source))
    .map((source) => JSON5.parse(source));
}

describe("Cloud Workers documentation contract", () => {
  it("keeps canonical config examples schema-valid", () => {
    const examples = cloudWorkerConfigExamples("docs/gateway/config-cloud-workers.md");
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(OpenClawSchema.safeParse(example).success).toBe(true);
    }
  });
});
