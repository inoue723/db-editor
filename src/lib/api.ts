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

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError_Serialize };

/** Unwraps a tauri-specta result, throwing {@link ApiError} on failure. */
export async function call<T>(result: Promise<Result<T>>): Promise<T> {
  const r = await result;
  if (r.status === "error") {
    throw new ApiError(r.error);
  }
  return r.data;
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
