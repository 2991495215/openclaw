import type { Skill } from "../../skills/loading/session.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "./extensions/loader.js";
import type { Extension, ExtensionFactory, LoadExtensionsResult } from "./extensions/types.js";
import type { PromptTemplate } from "./prompt-templates.js";

export interface ResourceLoader {
  getExtensions(): LoadExtensionsResult;
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
  reload(): Promise<void>;
}

interface DefaultResourceLoaderOptions {
  cwd: string;
  extensionFactories?: ExtensionFactory[];
}

export class DefaultResourceLoader implements ResourceLoader {
  private cwd: string;
  private eventBus: EventBus;
  private extensionFactories: ExtensionFactory[];
  private extensionsResult: LoadExtensionsResult;
  private skills: ReturnType<ResourceLoader["getSkills"]> = { skills: [], diagnostics: [] };
  private prompts: ReturnType<ResourceLoader["getPrompts"]> = { prompts: [], diagnostics: [] };

  constructor(options: DefaultResourceLoaderOptions) {
    this.cwd = options.cwd;
    this.eventBus = createEventBus();
    this.extensionFactories = options.extensionFactories ?? [];

    this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getSkills(): ReturnType<ResourceLoader["getSkills"]> {
    return { skills: this.skills.skills, diagnostics: this.skills.diagnostics };
  }

  getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
    return { prompts: this.prompts.prompts, diagnostics: this.prompts.diagnostics };
  }

  async reload(): Promise<void> {
    const extensionsResult: LoadExtensionsResult = {
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    };
    for (const [index, factory] of this.extensionFactories.entries()) {
      const extensionPath = `<inline:${index + 1}>`;
      try {
        extensionsResult.extensions.push(
          await loadExtensionFromFactory(
            factory,
            this.cwd,
            this.eventBus,
            extensionsResult.runtime,
            extensionPath,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to load extension";
        extensionsResult.errors.push({ path: extensionPath, error: message });
      }
    }

    // Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
    const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
    for (const conflict of conflicts) {
      extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
    }

    this.extensionsResult = extensionsResult;
    this.skills = { skills: [], diagnostics: [] };
    this.prompts = { prompts: [], diagnostics: [] };
  }

  private detectExtensionConflicts(
    extensions: Extension[],
  ): Array<{ path: string; message: string }> {
    const conflicts: Array<{ path: string; message: string }> = [];

    const owners = { tools: new Map<string, string>(), flags: new Map<string, string>() };
    for (const ext of extensions) {
      for (const kind of ["tools", "flags"] as const) {
        for (const name of ext[kind].keys()) {
          const existingOwner = owners[kind].get(name);
          if (existingOwner && existingOwner !== ext.path) {
            const label = kind === "tools" ? `Tool "${name}"` : `Flag "--${name}"`;
            conflicts.push({ path: ext.path, message: `${label} conflicts with ${existingOwner}` });
          } else {
            owners[kind].set(name, ext.path);
          }
        }
      }
    }

    return conflicts;
  }
}
