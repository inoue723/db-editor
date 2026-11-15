import type { CommandError_Serialize } from "../bindings";

/** A command failure, carrying the structured error returned by Rust. */
export class ApiError extends Error {
  readonly info: CommandError_Serialize;

  constructor(info: CommandError_Serialize) {
    super(info.message);
    this.name = "ApiError";
    this.info = info;
  }
}

function isCommandError(value: unknown): value is CommandError_Serialize {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof value.message === "string"
  );
}

/**
 * Awaits a tauri-specta command. Commands reject with the Rust `CommandError`;
 * this rethrows it as {@link ApiError} so callers get an `Error` with the details.
 */
export async function call<T>(result: Promise<T>): Promise<T> {
  try {
    return await result;
  } catch (error) {
    if (isCommandError(error)) {
      throw new ApiError(error);
    }
    throw error;
  }
}

/** A human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const { message, detail, hint } = error.info;
    return [message, detail && `DETAIL: ${detail}`, hint && `HINT: ${hint}`]
      .filter(Boolean)
      .join("\n");
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}
