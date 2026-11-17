/** Mirrors `src-tauri/src/commands/app.rs::AppInfo`. */
export interface AppInfo {
  name: string;
  version: string;
}

/** Mirrors `src-tauri/src/error.rs::AppError` serialization. */
export interface AppError {
  code: string;
  message: string;
}
