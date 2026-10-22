import { formatUiError } from "../../lib/format-error.ts";
import { describeRealtimeTalkInputError } from "./talk/input.ts";

export function formatDictationError(error: unknown): string {
  return error instanceof DOMException
    ? describeRealtimeTalkInputError(error)
    : formatUiError(error);
}
