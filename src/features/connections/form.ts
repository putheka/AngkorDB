import type {
  ColorTag,
  ConnectionConfig,
  ParsedConnectionUrl,
  PasswordChange,
  SafeMode,
  SshAuth,
  SslMode,
} from "@/bindings";

/** Form state: everything is a string so inputs stay editable while half-typed. */
export interface ConnectionForm {
  /** Empty for a new connection. */
  id: string;
  name: string;
  host: string;
  port: string;
  user: string;
  /** What the user typed. Empty means "leave the saved password alone". */
  password: string;
  database: string;
  sslMode: SslMode;
  color: ColorTag;
  group: string;
  safeMode: SafeMode;
  /** Seconds, as typed. Empty: no limit. */
  statementTimeout: string;
  /** A password is already saved in the Keychain. */
  hasPassword: boolean;
  /** The user asked to remove the saved password. */
  removePassword: boolean;
  /** Reach the database through an SSH server. */
  useSsh: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuth["kind"];
  /** The private key file, when `sshAuth` is `privateKey`. */
  sshKeyPath: string;
  /** What the user typed: the SSH password, or the key's passphrase. Empty: leave the saved one. */
  sshSecret: string;
  /** An SSH secret is already saved in the Keychain. */
  hasSshSecret: boolean;
  /** The user asked to remove the saved SSH secret. */
  removeSshSecret: boolean;
  /** Certificate files for TLS: paths, as typed or picked. Empty: none. */
  sslRootCert: string;
  sslClientCert: string;
  sslClientKey: string;
  /** The passphrase of the client key, as typed. Empty: leave the saved one. */
  sslKeySecret: string;
  /** A passphrase for the client key is already saved in the Keychain. */
  hasSslKeySecret: boolean;
  /** The user asked to remove the saved passphrase. */
  removeSslKeySecret: boolean;
}

export const emptyForm: ConnectionForm = {
  id: "",
  name: "",
  host: "localhost",
  port: "5432",
  user: "",
  password: "",
  database: "",
  sslMode: "prefer",
  color: "none",
  group: "",
  safeMode: "off",
  statementTimeout: "",
  hasPassword: false,
  removePassword: false,
  useSsh: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuth: "privateKey",
  sshKeyPath: "",
  sshSecret: "",
  hasSshSecret: false,
  removeSshSecret: false,
  sslRootCert: "",
  sslClientCert: "",
  sslClientKey: "",
  sslKeySecret: "",
  hasSslKeySecret: false,
  removeSslKeySecret: false,
};

export const SSH_AUTH_METHODS: { value: SshAuth["kind"]; label: string }[] = [
  { value: "privateKey", label: "Private key file" },
  { value: "password", label: "Password" },
  { value: "agent", label: "SSH agent" },
];

/** What each SSL mode checks, in a line. They mean what they mean for `psql`. */
export const SSL_MODE_HELP: Record<SslMode, string> = {
  disable: "No encryption.",
  prefer: "Encrypts if the server offers it. The server's certificate is not checked.",
  require: "Always encrypts. The server's certificate is not checked.",
  "verify-ca": "Always encrypts, and the certificate must be signed by a trusted authority.",
  "verify-full":
    "Always encrypts, the certificate must be signed by a trusted authority and be for this host.",
};

/** Does this mode look at the server's certificate (so a root certificate file matters)? */
export const verifiesCertificate = (mode: SslMode) =>
  mode === "verify-ca" || mode === "verify-full";

export const SSL_MODES: { value: SslMode; label: string }[] = [
  { value: "disable", label: "Disable" },
  { value: "prefer", label: "Prefer" },
  { value: "require", label: "Require" },
  { value: "verify-ca", label: "Verify CA" },
  { value: "verify-full", label: "Verify full" },
];

export const SAFE_MODES: { value: SafeMode; label: string }[] = [
  { value: "off", label: "Off: reads and writes" },
  { value: "confirm", label: "Confirm: ask before saving or running changes" },
  { value: "touch-id", label: "Touch ID: ask for Touch ID or your Mac password" },
  { value: "read-only", label: "Read-only: the server refuses writes" },
];

/**
 * What changes when a color is picked: red (production) starts on Confirm, unless a safe mode
 * was already chosen. Picking another color never takes a safe mode away.
 */
export function colorPatch(form: ConnectionForm, color: ColorTag): Partial<ConnectionForm> {
  return color === "red" && form.safeMode === "off" ? { color, safeMode: "confirm" } : { color };
}

export const COLOR_TAGS: { value: ColorTag; label: string }[] = [
  { value: "none", label: "No color" },
  { value: "green", label: "Green" },
  { value: "yellow", label: "Yellow" },
  { value: "red", label: "Red (production)" },
];

/** Text that looks like a connection URL, e.g. pasted from a dashboard. */
export const CONNECTION_URL_PATTERN = /^\s*postgres(ql)?:\/\//i;

export function formFromConnection(connection: ConnectionConfig): ConnectionForm {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    user: connection.user,
    password: "",
    database: connection.database,
    sslMode: connection.sslMode,
    color: connection.color,
    group: connection.group ?? "",
    safeMode: connection.safeMode,
    statementTimeout: secondsText(connection.statementTimeoutMs),
    hasPassword: connection.hasPassword,
    removePassword: false,
    useSsh: Boolean(connection.ssh),
    sshHost: connection.ssh?.host ?? "",
    sshPort: String(connection.ssh?.port ?? 22),
    sshUser: connection.ssh?.user ?? "",
    sshAuth: connection.ssh?.auth.kind ?? "privateKey",
    sshKeyPath: connection.ssh?.auth.kind === "privateKey" ? connection.ssh.auth.path : "",
    sshSecret: "",
    hasSshSecret: connection.ssh?.hasSecret ?? false,
    removeSshSecret: false,
    sslRootCert: connection.sslFiles?.rootCert ?? "",
    sslClientCert: connection.sslFiles?.clientCert ?? "",
    sslClientKey: connection.sslFiles?.clientKey ?? "",
    sslKeySecret: "",
    hasSslKeySecret: connection.sslFiles?.hasKeySecret ?? false,
    removeSslKeySecret: false,
  };
}

export function formToConfig(form: ConnectionForm): ConnectionConfig {
  return {
    id: form.id,
    name: form.name,
    host: form.host,
    port: Number(form.port),
    user: form.user,
    database: form.database,
    sslMode: form.sslMode,
    color: form.color,
    group: form.group,
    safeMode: form.safeMode,
    statementTimeoutMs: timeoutMs(form.statementTimeout),
    hasPassword: form.hasPassword,
    ssh: form.useSsh
      ? {
          host: form.sshHost,
          port: Number(form.sshPort),
          user: form.sshUser,
          auth: sshAuthOf(form),
          hasSecret: form.hasSshSecret,
        }
      : null,
    sslFiles: sslFilesOf(form),
  };
}

/** The files the form names, or none when every path is blank. */
function sslFilesOf(form: ConnectionForm): ConnectionConfig["sslFiles"] {
  const path = (text: string) => (text.trim() === "" ? null : text.trim());
  const rootCert = path(form.sslRootCert);
  const clientCert = path(form.sslClientCert);
  const clientKey = path(form.sslClientKey);
  if (!rootCert && !clientCert && !clientKey) return null;
  return { rootCert, clientCert, clientKey, hasKeySecret: form.hasSslKeySecret };
}

/** What to do with the saved passphrase of the client key. */
export function formToSslKeySecretChange(form: ConnectionForm): PasswordChange {
  if (form.sslClientKey.trim() === "") return { kind: "keep" };
  if (form.sslKeySecret !== "") return { kind: "set", value: form.sslKeySecret };
  if (form.removeSslKeySecret) return { kind: "clear" };
  return { kind: "keep" };
}

function sshAuthOf(form: ConnectionForm): SshAuth {
  switch (form.sshAuth) {
    case "privateKey":
      return { kind: "privateKey", path: form.sshKeyPath };
    case "password":
      return { kind: "password" };
    case "agent":
      return { kind: "agent" };
  }
}

/** What to do with the saved SSH password or passphrase. The agent has none. */
export function formToSshSecretChange(form: ConnectionForm): PasswordChange {
  if (!form.useSsh || form.sshAuth === "agent") return { kind: "keep" };
  if (form.sshSecret !== "") return { kind: "set", value: form.sshSecret };
  if (form.removeSshSecret) return { kind: "clear" };
  return { kind: "keep" };
}

/** What the secret field is for, in words. */
export const sshSecretLabel = (auth: SshAuth["kind"]) =>
  auth === "password" ? "SSH password" : "Key passphrase";

export function formToPasswordChange(form: ConnectionForm): PasswordChange {
  if (form.password !== "") return { kind: "set", value: form.password };
  if (form.removePassword) return { kind: "clear" };
  return { kind: "keep" };
}

/** 30000 ms → "30", 500 ms → "0.5", none → "". */
export function secondsText(ms: number | null | undefined): string {
  return ms === null || ms === undefined || ms === 0 ? "" : String(ms / 1000);
}

const MAX_TIMEOUT_SECONDS = 86_400; // a day

/** What was typed (seconds) as milliseconds; blank, 0 and anything unreadable mean no limit. */
export function timeoutMs(text: string): number | null {
  const seconds = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.round(seconds * 1000), MAX_TIMEOUT_SECONDS * 1000);
}

export type FormErrors = Partial<
  Record<
    | "host"
    | "port"
    | "user"
    | "database"
    | "statementTimeout"
    | "sshHost"
    | "sshPort"
    | "sshUser"
    | "sshKeyPath"
    | "sslClientCert",
    string
  >
>;

export function validateForm(form: ConnectionForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.host.trim()) errors.host = "Required";
  const port = Number(form.port.trim());
  if (!/^\d+$/.test(form.port.trim()) || port < 1 || port > 65535) errors.port = "1 to 65535";
  if (!form.user.trim()) errors.user = "Required";
  if (!form.database.trim()) errors.database = "Required";
  if (form.useSsh) {
    if (!form.sshHost.trim()) errors.sshHost = "Required";
    const sshPort = Number(form.sshPort.trim());
    if (!/^\d+$/.test(form.sshPort.trim()) || sshPort < 1 || sshPort > 65535) {
      errors.sshPort = "1 to 65535";
    }
    if (!form.sshUser.trim()) errors.sshUser = "Required";
    if (form.sshAuth === "privateKey" && !form.sshKeyPath.trim()) errors.sshKeyPath = "Required";
  }
  if ((form.sslClientCert.trim() === "") !== (form.sslClientKey.trim() === "")) {
    errors.sslClientCert = "Both, or neither";
  }
  const timeout = form.statementTimeout.trim();
  if (timeout !== "") {
    const seconds = Number(timeout);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIMEOUT_SECONDS) {
      errors.statementTimeout = "0 to 86400";
    }
  }
  return errors;
}

/** Fill the form from a parsed URL. Keeps the user's own name if they already typed one. */
export function applyParsedUrl(form: ConnectionForm, parsed: ParsedConnectionUrl): ConnectionForm {
  return {
    ...form,
    name: form.name.trim() ? form.name : parsed.name,
    host: parsed.host,
    port: String(parsed.port),
    user: parsed.user,
    database: parsed.database,
    sslMode: parsed.sslMode,
    password: parsed.password ?? form.password,
    removePassword: parsed.password ? false : form.removePassword,
  };
}

/** What the connection looks like in a list: user@host:port/database */
export function describeConnection(
  c: Pick<ConnectionConfig, "user" | "host" | "port" | "database"> &
    Partial<Pick<ConnectionConfig, "ssh">>,
) {
  const base = `${c.user}@${c.host}:${c.port}/${c.database}`;
  return c.ssh ? `${base} · via ${c.ssh.user}@${c.ssh.host}` : base;
}
