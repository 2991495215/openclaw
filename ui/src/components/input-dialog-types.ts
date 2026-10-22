import type { ApplicationGateway } from "../app/gateway.ts";

export type InputDialogOptions = {
  title: string;
  label?: string;
  /** Set null to omit the default field description. */
  description?: string | null;
  /** Multiline fields preserve raw whitespace when submitted. */
  multiline?: { name: string; rows: number };
  defaultValue?: string;
  submitLabel?: string;
  cancelLabel?: string;
  signal?: AbortSignal;
  /** Keep the draft editable while Gateway-backed submission is unavailable. */
  gateway?: ApplicationGateway;
  /**
   * Trims single-line values and blocks blank submission. Callers that treat
   * an empty entry as meaningful (clearing a custom session label) leave this
   * off and keep receiving the raw value.
   */
  requireValue?: boolean;
  /**
   * Holds submission closed while the entry still equals `defaultValue`, so a
   * rename that would change nothing cannot be submitted.
   */
  requireChange?: boolean;
  /** Explicit admission may allow a same-identity deferred action while offline. */
  canSubmit?: () => boolean;
  /**
   * Runs the operation the dialog was opened for. `null` resolves the dialog; a
   * message keeps it open with the typed value, so a rejected attempt stays
   * visible and retryable instead of discarding what the operator wrote.
   */
  submit?: (value: string) => Promise<string | null>;
};
