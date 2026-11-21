/** Choosing connections for a file, and the secrets typed for the ones imported. */
import type { ImportEntry, SharedConnection } from "../../bindings.ts";

export interface Secrets {
  password: string;
  sshSecret: string;
  sslKeySecret: string;
}

export const noSecrets: Secrets = { password: "", sshSecret: "", sslKeySecret: "" };

/** `connections-2026-01-02.json`: a name for the save dialog. */
export function defaultFileName(now: Date): string {
  return `connections-${now.toISOString().slice(0, 10)}.json`;
}

/** The entries to import: the ticked connections, each with what was typed for it (blank: none). */
export function entriesOf(
  count: number,
  ticked: ReadonlySet<number>,
  secrets: ReadonlyMap<number, Secrets>,
): ImportEntry[] {
  const entries: ImportEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (!ticked.has(index)) continue;
    const typed = secrets.get(index) ?? noSecrets;
    entries.push({
      index,
      password: typed.password === "" ? null : typed.password,
      sshSecret: typed.sshSecret === "" ? null : typed.sshSecret,
      sslKeySecret: typed.sslKeySecret === "" ? null : typed.sslKeySecret,
    });
  }
  return entries;
}

/** What a connection of a file will ask for, in words. */
export function asksFor(connection: SharedConnection): string[] {
  const asks: string[] = [];
  if (connection.needsPassword) asks.push("password");
  if (connection.needsSshSecret) {
    asks.push(connection.ssh?.auth.kind === "password" ? "SSH password" : "key passphrase");
  }
  if (connection.needsSslKeySecret) asks.push("TLS key passphrase");
  return asks;
}
