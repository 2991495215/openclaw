export const retirementCuts: readonly string[];
export function sha256(bytes: string | Uint8Array): string;
export function fileDigest(file: string): string;
export function fileIdentity(file: string): string;
export function startInstalledRecoveryRun(artifacts: string): {
  directory: string;
  summary: string;
};
export function readActivation(journal: string): Record<string, string | number | null>;
export function packageTreeDigest(root: string): string;
export function parseRecoveryCommand(output: string): {
  node: string;
  helper: string;
  anchor: string;
  operation: string;
};
export function assertRetirementCut(
  cut: string,
  evidence: {
    cut: string;
    row: { phase: string; intent_json: string };
    effect: string;
    synced?: boolean;
  },
  anchor: string,
  helper: string,
): void;
