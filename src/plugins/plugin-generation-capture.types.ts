import type { createPluginCaptureResolver } from "./plugin-capture-resolution.js";
import type { PluginGenerationReceipt } from "./plugin-generation-receipt.js";
import type { PluginSourceCustodyFork } from "./plugin-generation-source-lookup.js";
import type { AdmissionState } from "./plugin-native-admission-state.js";
import type { PluginNativeAdmissionCaptureState } from "./plugin-native-admission.js";
import type {
  createPluginSourceCapture,
  PluginDependencyResolution,
  PluginModuleCapture,
  PluginPackageCapture,
} from "./plugin-package-metadata-capture.js";

export type PluginNativeDependencyScopeState = {
  source: string;
  dependencies: string[];
  prepared: boolean;
};
export type PluginPackageMetadataState = {
  scopes: Map<
    string,
    {
      source: string;
      manifest?: Record<string, unknown> | null;
      aliasesPrepared: boolean;
    }
  >;
  pending: Set<string>;
};
export type PluginPackageScope = {
  source: string;
  manifest: Record<string, unknown>;
  aliases: Set<string>;
};
export type CapturedModuleState = {
  source: string;
  scope?: PluginPackageScope;
  tsconfigPaths: boolean;
  observed: Map<string, string | null | undefined>;
  dependencies: Map<string, boolean>;
  staticImports?: ReadonlySet<string>;
};
export type CapturedPackageState = {
  entry?: string;
  executableEntry: boolean;
  links: Set<string>;
  state: PluginPackageCapture["state"];
  missingTargets: Set<string>;
  sourceLinks: Set<string>;
  scopes: Map<string, string | undefined>;
  references: Map<string, Set<string>>;
  nativeScopes: Map<string, PluginNativeDependencyScopeState>;
  modules: Map<string, CapturedModuleState>;
};
/** Prepared facts cross isolates; acquisition and lazy execution use the same owners. */
export type PluginGenerationCaptureState = {
  sourceRoot: string;
  capturedRoot: string;
  sourceAliases: Record<string, string>;
  capturedPaths: Map<string, string>;
  originalSources: Map<string, string>;
  hardlinkedSources: Set<string>;
  packages: Map<string, CapturedPackageState>;
  dependencies: Map<string, PluginDependencyResolution | undefined>;
  metadata: PluginPackageMetadataState;
  native: PluginNativeAdmissionCaptureState;
  receipt: PluginGenerationReceipt;
};
export type PluginGenerationPreparationOwner = {
  admission: AdmissionState;
  sourceCapture: ReturnType<typeof createPluginSourceCapture>;
  resolution: ReturnType<typeof createPluginCaptureResolver>;
  state?: PluginGenerationCaptureState;
  prepared?(state: PluginGenerationCaptureState): void;
};
export type PluginGenerationArtifact = {
  sourceRoot: string;
  rootDir: string;
  boundaryRoot: string;
  sourceAliases: Record<string, string>;
  sourceDigest: string;
  linkHost: (hostRoot: string) => void;
  hasSource: (source: string) => boolean;
  resolve: (source: string, rejectHardlinks?: boolean) => string;
  captureRecoverySource: () => PluginSourceCustodyFork["source"];
  retainSourceCustody: () => PluginSourceCustodyFork;
  sourceForCaptured: (file: string) => string | undefined;
  moduleFacts: (importer: string) => Readonly<PluginModuleCapture> | undefined;
  moduleRoot: (filename: string) => string | undefined;
  assertModuleAvailable: (filename: string) => void;
  prepareModule: (filename: string) => string[];
  prepareDependency: (importer: string, specifier: string) => string[];
  prepareNativeScopes: (importer?: string) => { value: void; additions: string[] } | undefined;
  prepareNativeModule: (importer: string, specifier: string) => boolean;
  captureModule: (
    importer: string,
    specifier: string,
    conditions: readonly string[],
  ) => (({ target: URL } | { retryNative: true }) & { additions: string[] }) | undefined;
  captureResolvedModule: (filename: string) => string | undefined;
  dispose: () => void;
  disposeAsync: () => Promise<void>;
};
