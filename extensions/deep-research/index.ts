import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry, type PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { researchToolDefinition } from "./src/contract.js";
import type { ResearchJobs } from "./src/jobs.js";

const loadTool = createLazyRuntimeModule(() => import("./src/tool.js"));
const loadJobs = createLazyRuntimeModule(() => import("./src/jobs.js"));

export default definePluginEntry({
  id: "deep-research",
  name: "Deep Research",
  description: "Bounded, evidence-backed research",
  register(api) {
    let service: { scheduler: PluginServiceSchedulerV1; jobs?: ResearchJobs } | undefined;
    api.registerService({
      apiVersion: 2,
      id: "deep-research-jobs",
      start(context) {
        // Startup installs ownership only. State, models and retrieval remain invocation-lazy.
        service = { scheduler: context.scheduler };
      },
      stop() {
        service = undefined;
      },
    });
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          ...researchToolDefinition,
          execute: async (id, params, signal, onUpdate) => {
            context.assertInvocationCurrent();
            const owner = service;
            if (!owner) {
              throw new Error("Deep research requires the running Gateway job service.");
            }
            owner.scheduler.signal.throwIfAborted();
            const { ResearchJobs } = await loadJobs();
            owner.scheduler.signal.throwIfAborted();
            context.assertInvocationCurrent();
            const jobs = (owner.jobs ??= new ResearchJobs(api, owner.scheduler));
            return (await loadTool())
              .createResearchTool(api, context, jobs)
              .execute(id, params, signal, (message) =>
                onUpdate?.({
                  content: [{ type: "text", text: message }],
                  details: { progress: message },
                }),
              );
          },
        }),
      },
      { names: ["deep_research"], workspaceAccess: false },
    );
  },
});
