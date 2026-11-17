/** Mirrors `src-tauri/src/models/connection.rs`. */
export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";
export type ColorTag = "none" | "green" | "yellow" | "red";
export type SafeMode = "off" | "confirm" | "touch-id" | "read-only";

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  color: ColorTag;
  group: string | null;
  safeMode: SafeMode;
}
