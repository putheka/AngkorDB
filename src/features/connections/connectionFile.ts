/** Choosing connections for a file, and the secrets typed for the ones imported. */
import type { ImportEntry, SharedConnection, SshAuth } from "../../bindings.ts";

export interface Secrets {
  password: string;
  sshSecret: string;
  sslKeySecret: string;
  sshJumpSecret: string;
}

export const noSecrets: Secrets = {
  password: "",
  sshSecret: "",
  sslKeySecret: "",
  sshJumpSecret: "",
};

/** `connections-2026-01-02.json`: a name for the save dialog. */
export function defaultFileName(now: Date): string {
  return `connections-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * The entries to import: the ticked connections of the file, each with what was typed for it
 * (blank: none). They carry the settings that were shown, so what is saved is what the person
 * saw, whatever happened to the file since.
 */
export function entriesOf(
  items: readonly SharedConnection[],
  ticked: ReadonlySet<number>,
  secrets: ReadonlyMap<number, Secrets>,
): ImportEntry[] {
  const entries: ImportEntry[] = [];
  items.forEach((connection, index) => {
    if (!ticked.has(index)) return;
    const typed = secrets.get(index) ?? noSecrets;
    const orNull = (text: string) => (text === "" ? null : text);
    entries.push({
      connection,
      password: orNull(typed.password),
      sshSecret: orNull(typed.sshSecret),
      sslKeySecret: orNull(typed.sslKeySecret),
      sshJumpSecret: orNull(typed.sshJumpSecret),
    });
  });
  return entries;
}

/** What a connection of a file will ask for, in words. */
export function asksFor(connection: SharedConnection): string[] {
  const asks: string[] = [];
  if (connection.needsPassword) asks.push("password");
  if (connection.needsSshSecret) {
    asks.push(connection.ssh?.auth.kind === "password" ? "SSH password" : "key passphrase");
  }
  if (connection.needsSshJumpSecret) {
    asks.push(
      connection.ssh?.jump?.auth.kind === "password"
        ? "jump host password"
        : "jump host key passphrase",
    );
  }
  if (connection.needsSslKeySecret) asks.push("TLS key passphrase");
  return asks;
}

const authText = (auth: SshAuth) =>
  auth.kind === "privateKey"
    ? `key ${auth.path}`
    : auth.kind === "agent"
      ? "ssh-agent"
      : "password";

/**
 * Everything of a connection that decides where its secrets go, one line each, for the person to
 * read before typing a password for it: the database, the SSH servers it passes through (in the
 * order they are connected to), how it is encrypted and the files it reads.
 */
export function routeOf(c: SharedConnection): string[] {
  const lines = [`Database ${c.user}@${c.host}:${c.port}/${c.database}`];
  if (c.ssh?.jump) {
    const j = c.ssh.jump;
    lines.push(`SSH jump host ${j.user}@${j.host}:${j.port} (${authText(j.auth)})`);
  }
  if (c.ssh) {
    lines.push(`SSH server ${c.ssh.user}@${c.ssh.host}:${c.ssh.port} (${authText(c.ssh.auth)})`);
  }
  lines.push(`SSL mode ${c.sslMode}`);
  const files = c.sslFiles;
  if (files?.rootCert) lines.push(`Root certificate ${files.rootCert}`);
  if (files?.clientCert) lines.push(`Client certificate ${files.clientCert}`);
  if (files?.clientKey) lines.push(`Client key ${files.clientKey}`);
  return lines;
}

/**
 * What to be careful about in a file from someone else: a secret typed here is sent to the
 * hosts above, and an SSH tunnel or an unchecked certificate gives a stranger's server the
 * chance to receive it.
 */
export function warningsOf(c: SharedConnection): string[] {
  const warnings: string[] = [];
  if (c.ssh) {
    warnings.push(
      c.ssh.jump
        ? "Goes through two SSH servers: your SSH passwords and key go to them."
        : "Goes through an SSH server: your SSH password or key goes to it.",
    );
  }
  if (c.sslMode === "disable") warnings.push("Not encrypted.");
  else if (c.sslMode === "prefer" || c.sslMode === "require") {
    warnings.push("The server's certificate is not checked.");
  }
  return warnings;
}
