/** An SSH tunnel that stopped at the server's host key: what to ask the person, or to tell them. */
import type { AppError } from "@/bindings";

export interface HostKeyStop {
  /** `unknown`: not in known_hosts yet, may be trusted. `changed`: refused, never trusted here. */
  kind: "unknown" | "changed";
  /** `SHA256:…`, as `ssh` prints it. */
  fingerprint: string;
  /** `ssh-ed25519 · host:port` */
  summary: string;
  message: string;
}

const isAppError = (error: unknown): error is AppError =>
  typeof error === "object" && error !== null && "code" in error && "message" in error;

/** The host key problem inside an error, if that is what the error is. */
export function hostKeyStop(error: unknown): HostKeyStop | null {
  if (!isAppError(error)) return null;
  if (error.code !== "SSH_HOST_UNKNOWN" && error.code !== "SSH_HOST_CHANGED") return null;
  return {
    kind: error.code === "SSH_HOST_UNKNOWN" ? "unknown" : "changed",
    fingerprint: error.detail ?? "",
    summary: error.hint ?? "",
    message: error.message,
  };
}
