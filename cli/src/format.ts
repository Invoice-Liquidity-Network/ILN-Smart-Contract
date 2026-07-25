/**
 * Shared output formatting utilities for the ILN CLI.
 *
 * When the global --json flag is set, all commands output machine-readable
 * JSON instead of human-friendly formatted text.
 */

export interface JsonError {
  error: string;
  code: string;
}

/**
 * Return true when the current CLI invocation has --json enabled.
 * Reads from the parent (root) program options via Commander's hierarchy.
 */
export function isJsonMode(parentOpts?: Record<string, unknown>): boolean {
  return parentOpts?.json === true;
}

/**
 * Output data in the appropriate format based on --json flag.
 * - JSON mode: prints valid JSON to stdout (no ANSI, no extra text).
 * - Human mode: calls the provided `human` callback to print formatted output.
 */
export function formatOutput<T>(
  data: T,
  json: boolean,
  human?: () => void
): void {
  if (json) {
    console.log(JSON.stringify(data));
  } else {
    human?.();
  }
}

/**
 * Output a structured error as JSON when --json mode is active,
 * otherwise print a plain-text error and exit.
 */
export function formatError(
  message: string,
  code: string,
  json: boolean
): void {
  if (json) {
    const err: JsonError = { error: message, code };
    console.log(JSON.stringify(err));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}
