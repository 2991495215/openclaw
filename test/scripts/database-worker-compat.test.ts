import { expect, it } from "vitest";
import { inspectDatabaseWorkerBoundaries } from "../../scripts/lib/database-worker-compat.mts";

const compatFile = "extensions/matrix/auth-presence.ts";
const apiName = "hasAnyMatrixAuth";
const legacy = `
/** @deprecated Use the worker API; removal follows a stable deprecation window. */
export function ${apiName}() { return 1; }
`;

function inspect(extra: Record<string, string>, source = legacy) {
  return inspectDatabaseWorkerBoundaries(
    process.cwd(),
    new Map(Object.entries({ [compatFile]: source, ...extra })),
  );
}

it("retains deprecated-only operations through pure reexports and type-only references", () => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export { ${apiName} as oldQuery } from '../../extensions/matrix/auth-presence.js';`,
    "src/types.ts": `
      import type { oldQuery } from './plugin-sdk/barrel.js';
      export type Query = typeof oldQuery;
      export function unrelated(${apiName}: () => number) { return ${apiName}(); }
    `,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(compatFile)).toEqual(new Set([apiName]));
});

it.each([
  ["aliased barrel call", `import { oldQuery as read } from './plugin-sdk/barrel.js'; read();`],
  ["namespace call", `import * as legacy from './plugin-sdk/barrel.js'; legacy.oldQuery();`],
  [
    "namespace element call",
    `import * as legacy from './plugin-sdk/barrel.js'; legacy['oldQuery']();`,
  ],
  [
    "dynamic namespace import",
    `const legacy = await import('./plugin-sdk/barrel.js'); legacy.oldQuery();`,
  ],
  [
    "dynamic namespace rest binding",
    `const { ...legacy } = await import('./plugin-sdk/barrel.js'); legacy.oldQuery();`,
  ],
  [
    "dynamic nested namespace binding",
    `const { nested: { oldQuery } } = await import('./plugin-sdk/barrel.js'); oldQuery();`,
  ],
  [
    "dynamic computed namespace binding",
    `const key = 'oldQuery'; const { [key]: read } = await import('./plugin-sdk/barrel.js'); read();`,
  ],
  [
    "escaped callback",
    `import { oldQuery } from './plugin-sdk/barrel.js'; export function callback() { return oldQuery; }`,
  ],
  [
    "shorthand callback escape",
    `import { oldQuery } from './plugin-sdk/barrel.js'; export const callbacks = { oldQuery };`,
  ],
  [
    "escaped namespace",
    `import * as legacy from './plugin-sdk/barrel.js'; export const api = legacy;`,
  ],
  [
    "unregistered deprecated wrapper",
    `import { oldQuery } from './plugin-sdk/barrel.js';
     /** @deprecated Use workers. */
     export function wrapper() { return oldQuery(); }`,
  ],
])("rejects a bundled %s without allowing it to hide the live operation", (_name, consumer) => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export { ${apiName} as oldQuery } from '../../extensions/matrix/auth-presence.js';`,
    "src/consumer.ts": consumer,
  });
  expect(result.violations).toEqual([
    expect.stringMatching(/src\/consumer.ts:\d+:\d+: bundled runtime reference/),
  ]);
  expect(result.operations.has(compatFile)).toBe(false);
});

it("checks same-file calls and propagates reachability to discovered helpers", () => {
  const result = inspect(
    {
      "src/helper.ts": "export function helper() { return 1; }",
      "extensions/plugin/runtime.ts": `import { ${apiName} } from '../matrix/auth-presence.js'; ${apiName}();`,
    },
    `import { helper } from '../../src/helper.js';
    /** @deprecated Use workers. */
    export function ${apiName}() { return helper(); }
    function bundled() { return ${apiName}(); }`,
  );
  expect(result.operations.size).toBe(0);
  expect(result.violations).toEqual([
    expect.stringContaining(`${compatFile}:`),
    expect.stringContaining("extensions/plugin/runtime.ts:"),
  ]);
});

it("requires the reviewed declaration's deprecation marker", () => {
  const result = inspect({}, legacy.replace("@deprecated", "Legacy:"));
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.violations).toEqual([
    `${compatFile}:${apiName}: reviewed compatibility operation must be @deprecated`,
  ]);
});

it("does not classify deprecated methods or their unverified factory objects", () => {
  const result = inspect({
    "src/gateway/github-publication-coordinator-methods.ts": `
      import { ${apiName} } from '../../extensions/matrix/auth-presence.js';
      export function createGitHubPublicationCoordinatorMethods() {
        return {
          /** @deprecated Use the awaited replacement. */
          markReported() { return ${apiName}(); },
        };
      }
    `,
  });
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.operations.has("src/gateway/github-publication-coordinator-methods.ts")).toBe(
    false,
  );
  expect(result.violations).toEqual([
    expect.stringContaining("src/gateway/github-publication-coordinator-methods.ts:"),
  ]);
});

it("allows async-only members selected from a dynamic namespace import", () => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export { ${apiName} as oldQuery } from '../../extensions/matrix/auth-presence.js';
      export async function queryAsync() { return 1; }`,
    "src/consumer.ts": `const { queryAsync } = await import('./plugin-sdk/barrel.js'); await queryAsync();`,
  });
  expect(result.violations).toEqual([]);
});

it("follows renamed namespace reexports and default exports", () => {
  const result = inspect({
    "src/plugin-sdk/barrel.ts": `export * as old from '../../extensions/matrix/auth-presence.js';
      export { ${apiName} as default } from '../../extensions/matrix/auth-presence.js';`,
    "src/consumer.ts": `
      import query, { old as api } from './plugin-sdk/barrel.js';
      api.${apiName}();
      query();
    `,
  });
  expect(result.operations.size).toBe(0);
  expect(result.violations).toHaveLength(2);
});

it.each(["openclaw/plugin-sdk", "@openclaw/plugin-sdk"])(
  "resolves the root SDK alias %s",
  (specifier) => {
    const result = inspect({
      "src/plugin-sdk/index.ts": `export { ${apiName} as oldQuery } from '../../extensions/matrix/auth-presence.js';`,
      "src/consumer.ts": `import { oldQuery } from '${specifier}'; oldQuery();`,
    });
    expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
  },
);

it("retires deleted operations even when their module keeps other exports", () => {
  const result = inspect({}, `export function ${apiName}Async() { return 1; }`);
  expect(result.operations.size).toBe(0);
  expect(result.violations).toEqual([]);
});

it("does not read missing compatibility files from the current checkout", () => {
  expect(inspectDatabaseWorkerBoundaries(process.cwd(), new Map())).toEqual({
    operations: new Map(),
    callLocations: new Map(),
    nonRuntimeOperations: new Map(),
    nonRuntimeCallLocations: new Map(),
    violations: [],
  });
});

const kernelFile = "src/session-kernel.ts";
const kernel = `export function readKernel() { return 1; }`;
const sharedOwner = `
  import { readKernel } from '../../src/session-kernel.js';
  /** @deprecated Use workers. */
  export function ${apiName}() { return readKernel(); }
`;
const receiverOwner = `
  import { readKernel } from '../../src/session-kernel.js';
  /** @deprecated Use workers. */
  export function ${apiName}() { return { read() { return readKernel(); } }; }
`;

it("proves a transitive mixed kernel with only worker and deprecated callers", () => {
  const result = inspect({
    [compatFile]: sharedOwner,
    [kernelFile]: `import { leaf } from './leaf.js';
      export function readKernel() { return leaf(); }`,
    "src/leaf.ts": `export function leaf() { return 1; }`,
    "src/reader.worker.ts": `import { readKernel as read } from './session-kernel.js'; read();`,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get("src/leaf.ts")).toEqual(new Set(["leaf"]));
});

it.each([
  ["live call", "export function read() { return readKernel(); }"],
  ["escaped callback", "export const callback = readKernel;"],
  ["namespace escape", "export const callback = kernelApi;"],
])("keeps a mixed kernel live after a bundled %s", (_label, consumer) => {
  const result = inspect({
    [compatFile]: sharedOwner,
    [kernelFile]: `import { leaf } from './leaf.js';
      export function readKernel() { return leaf(); }`,
    "src/leaf.ts": `export function leaf() { return 1; }`,
    "src/consumer.ts": `import { readKernel } from './session-kernel.js';
      import * as kernelApi from './session-kernel.js'; ${consumer}`,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has("src/leaf.ts")).toBe(false);
  expect(result.operations.get(compatFile)).toEqual(new Set([apiName]));
});

it.each(["register(readKernel)", "register(() => readKernel())"])(
  "keeps an escaped worker callback live: %s",
  (registration) => {
    const result = inspect({
      [compatFile]: sharedOwner,
      [kernelFile]: kernel,
      "src/reader.worker.ts": `import { readKernel } from './session-kernel.js';
      ${registration};`,
    });
    expect(result.operations.has(kernelFile)).toBe(false);
  },
);

it.each([
  ["object method", "{ read() { return readKernel(); } }"],
  ["arrow property", "{ read: () => readKernel() }"],
  ["function property", "{ read: function () { return readKernel(); } }"],
  ["returned arrow", "() => readKernel()"],
  ["returned function", "function () { return readKernel(); }"],
])("proves kernels reached only through a deprecated factory's %s", (_label, value) => {
  const result = inspect({
    [compatFile]: `
      import { readKernel } from '../../src/session-kernel.js';
      /** @deprecated Use workers. */
      export function ${apiName}() { return ${value}; }`,
    [kernelFile]: kernel,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get(compatFile)?.has(apiName)).toBe(true);
});

it.each([
  [
    "direct factory call",
    `import { ${apiName} } from '../extensions/matrix/auth-presence.js'; ${apiName}().read();`,
  ],
  [
    "aliased factory call",
    `import { ${apiName} as create } from '../extensions/matrix/auth-presence.js'; create().read();`,
  ],
  [
    "reexported factory call",
    `import { create } from './plugin-sdk/receivers.js'; create().read();`,
  ],
  [
    "SDK subpath factory call",
    `import { create } from 'openclaw/plugin-sdk/receivers'; create().read();`,
  ],
  [
    "scoped SDK subpath factory call",
    `import { create } from '@openclaw/plugin-sdk/receivers'; create().read();`,
  ],
  [
    "dynamic factory call",
    `const { create } = await import('./plugin-sdk/receivers.js'); create().read();`,
  ],
  [
    "returned object escape",
    `import { ${apiName} } from '../extensions/matrix/auth-presence.js'; register(${apiName}());`,
  ],
])("keeps a receiver family live after a bundled %s", (_label, consumer) => {
  const result = inspect({
    [compatFile]: receiverOwner,
    [kernelFile]: kernel,
    "src/plugin-sdk/receivers.ts": `export { ${apiName} as create } from '../../extensions/matrix/auth-presence.js';`,
    "src/consumer.ts": consumer,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it("keeps a returned callback live when bundled code registers it", () => {
  const result = inspect({
    [compatFile]: `import { readKernel } from '../../src/session-kernel.js';
      /** @deprecated Use workers. */
      export function ${apiName}() { return () => readKernel(); }`,
    [kernelFile]: kernel,
    "src/consumer.ts": `import { ${apiName} } from '../extensions/matrix/auth-presence.js';
      register(${apiName}());`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it("keeps shared receiver methods live when an async factory also creates them", () => {
  const result = inspect({
    [compatFile]: `import { createReceiver } from '../../src/receiver.js';
      /** @deprecated Use workers. */
      export function ${apiName}() { return createReceiver(); }`,
    [kernelFile]: kernel,
    "src/receiver.ts": `import { readKernel } from './session-kernel.js';
      export function createReceiver() { return { read() { return readKernel(); } }; }
      export async function createReceiverAsync() { return createReceiver(); }`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has("src/receiver.ts")).toBe(false);
  expect(result.operations.get(compatFile)).toEqual(new Set([apiName]));
  expect(result.violations).toEqual([]);
});

it.each(["() => readKernel()", "function () { return readKernel(); }"])(
  "keeps a function-valued receiver property live when it escapes: %s",
  (value) => {
    const result = inspect({
      [compatFile]: `import { readKernel } from '../../src/session-kernel.js';
        /** @deprecated Use workers. */
        export function ${apiName}() {
          return { read: ${value}, start() { register(this.read); } };
        }`,
      [kernelFile]: kernel,
    });
    expect(result.operations.has(kernelFile)).toBe(false);
    expect(result.operations.has(compatFile)).toBe(false);
    expect(result.violations).toEqual([]);
  },
);

it("keeps unregistered nondeprecated receiver factories live", () => {
  const result = inspect({
    [kernelFile]: kernel,
    "src/receiver.ts": `import { readKernel } from './session-kernel.js';
      export function createReceiver() { return { read() { return readKernel(); } }; }`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has("src/receiver.ts")).toBe(false);
  expect(result.violations).toEqual([]);
});

it("keeps a receiver live when its reviewed wrapper escapes a method", () => {
  const result = inspect({
    [compatFile]: `import { createReceiver } from '../../src/receiver.js';
      /** @deprecated Use workers. */
      export function ${apiName}() {
        const receiver = createReceiver();
        register(receiver.read);
      }`,
    "src/receiver.ts": `import { readKernel } from './session-kernel.js';
      export function createReceiver() { return { read() { return readKernel(); } }; }`,
    [kernelFile]: kernel,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has("src/receiver.ts")).toBe(false);
  expect(result.violations).toEqual([]);
});

it("proves kernels reached only through a deprecated class receiver", () => {
  const result = inspect({
    [compatFile]: `import { readKernel } from '../../src/session-kernel.js';
      /** @deprecated Use workers. */
      export class ${apiName} {
        constructor() { readKernel(); }
        read() { return readKernel(); }
      }`,
    [kernelFile]: kernel,
  });
  expect(result.operations.get(kernelFile)).toEqual(new Set(["readKernel"]));
  expect(result.operations.get(compatFile)?.has(apiName)).toBe(true);
  expect(result.violations).toEqual([]);
});

it("rejects bundled construction of a deprecated class receiver", () => {
  const result = inspect({
    [compatFile]: `import { readKernel } from '../../src/session-kernel.js';
      /** @deprecated Use workers. */
      export class ${apiName} { read() { return readKernel(); } }`,
    [kernelFile]: kernel,
    "src/consumer.ts": `import { ${apiName} as Receiver } from '../extensions/matrix/auth-presence.js';
      new Receiver().read();`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it("keeps a deprecated receiver live when a bundled class extends it", () => {
  const result = inspect({
    [compatFile]: `import { readKernel } from '../../src/session-kernel.js';
      /** @deprecated Use workers. */
      export class ${apiName} { read() { return readKernel(); } }`,
    [kernelFile]: kernel,
    "src/consumer.ts": `import { ${apiName} as Receiver } from '../extensions/matrix/auth-presence.js';
      export class ActiveReceiver extends Receiver {}`,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/consumer.ts:")]);
});

it.each([
  ["inheritance", "extends Base", "read() { return readKernel(); }"],
  ["field initializer", "", "read = () => readKernel();"],
  ["computed member name", "", "[readKernel()]() { return readKernel(); }"],
  ["static block", "", "static { readKernel(); } read() { return readKernel(); }"],
  ["decorated member", "", "@decorate read() { return readKernel(); }"],
  [
    "decorated parameter",
    "",
    "constructor(@decorate value: unknown) {} read() { return readKernel(); }",
  ],
])("keeps deprecated classes with %s live", (_label, heritage, member) => {
  const result = inspect({
    [compatFile]: `import { readKernel } from '../../src/session-kernel.js';
      class Base {}
      /** @deprecated Use workers. */
      export class ${apiName} ${heritage} { ${member} }`,
    [kernelFile]: kernel,
  });
  expect(result.operations.has(kernelFile)).toBe(false);
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.violations).toEqual([]);
});

it("rejects a reviewed API reached through a live receiver method", () => {
  const result = inspect({
    [kernelFile]: kernel,
    "src/receiver.ts": `import { readKernel } from './session-kernel.js';
      import { ${apiName} } from '../extensions/matrix/auth-presence.js';
      export function createReceiver() {
        return { read() { ${apiName}(); return readKernel(); } };
      }
      export async function createReceiverAsync() { return createReceiver(); }`,
  });
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/receiver.ts:")]);
});

it("records SQL inside a closed receiver method as compatibility-only", () => {
  const result = inspect({
    [compatFile]: `/** @deprecated Use workers. */
export function ${apiName}() {
  return { read() { return executeSqliteQuerySync(query); } };
}`,
  });
  expect(result.operations.get(compatFile)?.has(`${apiName}.read`)).toBe(true);
  expect(result.callLocations.get(compatFile)).toEqual(new Set(["3:28"]));
  expect(result.violations).toEqual([]);
});

it.each(["register(() => readKernel())", "return register(() => readKernel())"])(
  "does not inherit a compatibility scope through callback arguments: %s",
  (registration) => {
    const result = inspect({
      [compatFile]: `import { readKernel } from '../../src/session-kernel.js';
      /** @deprecated Use workers. */
      export function ${apiName}() { ${registration}; }`,
      [kernelFile]: kernel,
    });
    expect(result.operations.has(kernelFile)).toBe(false);
  },
);

it("rejects a reviewed API escaped by a discovered helper", () => {
  const result = inspect({
    [compatFile]: `import { helper } from '../../src/helper.js';
      /** @deprecated Use workers. */
      export function ${apiName}() { helper(); }`,
    "src/helper.ts": `import { ${apiName} } from '../extensions/matrix/auth-presence.js';
      export function helper() { register(${apiName}); }`,
  });
  expect(result.operations.has(compatFile)).toBe(false);
  expect(result.violations).toEqual([expect.stringContaining("src/helper.ts:")]);
});

it("records direct call locations but excludes nested callback SQL", () => {
  const result = inspect(
    {},
    `/** @deprecated Use workers. */
export function ${apiName}() {
  executeSqliteQuerySync(query);
  register(() => executeSqliteQuerySync(query));
}`,
  );
  expect(result.callLocations.get(compatFile)).toEqual(new Set(["3:3", "4:3"]));
});

it("does not confuse a nested function path with a live top-level namesake", () => {
  const result = inspect({
    [compatFile]: `import { wrapper } from '../../src/wrapper.js';
      /** @deprecated Use workers. */
      export function ${apiName}() { wrapper(); }`,
    "src/wrapper.ts": `export function wrapper() {
      const local = () => { function same() { return 1; } return 1; };
      return local;
    }
    export function same() { return 2; }`,
  });
  expect(result.operations.get("src/wrapper.ts")?.has("same")).toBe(false);
});

const maintenanceFile = "src/state/openclaw-state-db-maintenance.ts";
const maintenanceSource = `
export function writeCurrentStateSchemaMetadata() { return persistSchema(); }
function persistSchema() { return executeSqliteQuerySync(query); }
export function runStateSchemaMigrationTransaction(db, path, operation) { return operation(); }
`;
const doctorSource = `
  import { writeCurrentStateSchemaMetadata, runStateSchemaMigrationTransaction } from '../state/openclaw-state-db-maintenance.js';
  export function doctor() {
    return runStateSchemaMigrationTransaction(db, path, () => writeCurrentStateSchemaMetadata());
  }
`;

function inspectMaintenance(extra: Record<string, string> = {}) {
  return inspectDatabaseWorkerBoundaries(
    process.cwd(),
    new Map(
      Object.entries({
        [maintenanceFile]: maintenanceSource,
        "src/commands/doctor.ts": doctorSource,
        ...extra,
      }),
    ),
    (file) =>
      file.startsWith("src/commands/") || file.includes("migration") || file.endsWith(".worker.ts"),
    (file) =>
      file === "src/commands/doctor.ts" ? "T3" : file === "src/read.worker.ts" ? "W" : undefined,
  );
}

it("proves maintenance-only kernels through the exact synchronous migration scope", () => {
  const result = inspectMaintenance({
    "src/read.worker.ts": `import { writeCurrentStateSchemaMetadata } from './state/openclaw-state-db-maintenance.js';
      writeCurrentStateSchemaMetadata();`,
  });
  expect(result.violations).toEqual([]);
  expect(result.operations.size).toBe(0);
  expect(result.nonRuntimeOperations.get(maintenanceFile)).toEqual(
    new Map([
      ["writeCurrentStateSchemaMetadata", "T3"],
      ["persistSchema", "T3"],
    ]),
  );
  expect(result.nonRuntimeCallLocations.get(maintenanceFile)).toEqual(new Set(["2:60", "3:35"]));
});

it.each([
  [
    "Gateway caller",
    "src/gateway/consumer.ts",
    `import { writeCurrentStateSchemaMetadata as write } from '../state/openclaw-state-db-maintenance.js';
    export function handle() { return write(); }`,
  ],
  [
    "escaped Doctor callback",
    "src/commands/doctor.ts",
    `import { writeCurrentStateSchemaMetadata as write } from '../state/openclaw-state-db-maintenance.js';
    export function doctor() { return () => write(); }`,
  ],
  [
    "migration filename lead",
    "src/infra/state-migrations.unreviewed.ts",
    `import { writeCurrentStateSchemaMetadata as write } from '../state/openclaw-state-db-maintenance.js';
    export function migrate() { return write(); }`,
  ],
  [
    "SDK reexport",
    "src/plugin-sdk/schema.ts",
    `export { writeCurrentStateSchemaMetadata } from '../state/openclaw-state-db-maintenance.js';`,
  ],
])("keeps maintenance candidates live after a %s", (_label, file, source) => {
  const result = inspectMaintenance({ [file]: source });
  expect(result.violations).toEqual([]);
  expect(result.nonRuntimeOperations.has(maintenanceFile)).toBe(false);
});

it("does not trust a same-named callback scope from another module", () => {
  const result = inspectMaintenance({
    "src/commands/doctor.ts":
      doctorSource.replace(
        "writeCurrentStateSchemaMetadata, runStateSchemaMigrationTransaction",
        "writeCurrentStateSchemaMetadata",
      ) + `import { runStateSchemaMigrationTransaction } from '../impostor.js';`,
    "src/impostor.ts": `export function runStateSchemaMigrationTransaction(db, path, operation) { return operation; }`,
  });
  expect(result.nonRuntimeOperations.has(maintenanceFile)).toBe(false);
});

it("keeps a kernel live through an unreviewed worker-named wrapper called by the Gateway", () => {
  const result = inspectMaintenance({
    "src/unregistered.worker.ts": `import { writeCurrentStateSchemaMetadata } from './state/openclaw-state-db-maintenance.js';
      export function writeSchema() { return writeCurrentStateSchemaMetadata(); }`,
    "src/gateway/consumer.ts": `import { writeSchema } from '../unregistered.worker.js';
      export function handle() { return writeSchema(); }`,
  });
  expect(result.nonRuntimeOperations.has(maintenanceFile)).toBe(false);
});

it("classifies a shared kernel with exclusively worker callers as worker-owned", () => {
  const result = inspectMaintenance({
    "src/commands/doctor.ts": "export {};",
    "src/read.worker.ts": `import { writeCurrentStateSchemaMetadata } from './state/openclaw-state-db-maintenance.js';
      writeCurrentStateSchemaMetadata();`,
  });
  expect(result.nonRuntimeOperations.get(maintenanceFile)).toEqual(
    new Map([
      ["writeCurrentStateSchemaMetadata", "W"],
      ["persistSchema", "W"],
    ]),
  );
});
