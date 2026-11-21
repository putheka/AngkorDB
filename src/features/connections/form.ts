import type {
  ColorTag,
  ConnectionConfig,
  ParsedConnectionUrl,
  PasswordChange,
  SafeMode,
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
};

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
  };
}

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
  Record<"host" | "port" | "user" | "database" | "statementTimeout", string>
>;

export function validateForm(form: ConnectionForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.host.trim()) errors.host = "Required";
  const port = Number(form.port.trim());
  if (!/^\d+$/.test(form.port.trim()) || port < 1 || port > 65535) errors.port = "1 to 65535";
  if (!form.user.trim()) errors.user = "Required";
  if (!form.database.trim()) errors.database = "Required";
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
  c: Pick<ConnectionConfig, "user" | "host" | "port" | "database">,
) {
  return `${c.user}@${c.host}:${c.port}/${c.database}`;
}
