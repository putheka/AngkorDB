/**
 * Fake Rust backend for plain-browser development (`npm run dev`, no Tauri window).
 * Installed only in dev builds when `window.__TAURI_INTERNALS__` is missing, so the UI can be
 * built and checked without the native app. State lives in memory and resets on reload.
 */
import type {
  AppError,
  ConnectionConfig,
  ConnectionInfo,
  ParsedConnectionUrl,
  PasswordChange,
  SslMode,
} from "@/bindings";

type Handler = (args: Record<string, unknown>) => unknown;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function appError(code: string, message: string, extra: Partial<AppError> = {}): AppError {
  return { code, message, pgCode: null, detail: null, hint: null, position: null, ...extra };
}

const base: Omit<ConnectionConfig, "id" | "name" | "host" | "port" | "user" | "database"> = {
  sslMode: "prefer",
  color: "none",
  group: null,
  safeMode: "off",
  hasPassword: false,
};

let connections: ConnectionConfig[] = [
  {
    ...base,
    id: "1",
    name: "Local dev",
    host: "localhost",
    port: 54329,
    user: "angkor",
    database: "angkordb_dev",
    color: "green",
    group: "Local",
    hasPassword: true,
  },
  {
    ...base,
    id: "2",
    name: "Staging",
    host: "db.staging.example.com",
    port: 5432,
    user: "app",
    database: "shop",
    color: "yellow",
    group: "Work",
    sslMode: "require",
    hasPassword: true,
  },
  {
    ...base,
    id: "3",
    name: "Production",
    host: "db.example.com",
    port: 5432,
    user: "readonly",
    database: "shop",
    color: "red",
    group: "Work",
    sslMode: "verify-full",
    safeMode: "read-only",
    hasPassword: true,
  },
  {
    ...base,
    id: "4",
    name: "Scratch",
    host: "127.0.0.1",
    port: 5433,
    user: "postgres",
    database: "postgres",
  },
];

function parseUrl(text: string): ParsedConnectionUrl {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw appError("VALIDATION", "This is not a valid connection URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw appError("VALIDATION", "The URL must start with postgres:// or postgresql://");
  }
  if (!url.hostname) throw appError("VALIDATION", "The URL has no host");

  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || user;
  const mode = url.searchParams.get("sslmode") ?? "prefer";
  const modes: Record<string, SslMode> = {
    disable: "disable",
    allow: "prefer",
    prefer: "prefer",
    require: "require",
    "verify-ca": "verify-ca",
    "verify-full": "verify-full",
  };
  const sslMode = modes[mode];
  if (!sslMode) throw appError("VALIDATION", `Unsupported sslmode '${mode}'`);

  return {
    name: `${database} @ ${url.hostname}`,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 5432,
    user,
    password: url.password ? decodeURIComponent(url.password) : null,
    database,
    sslMode,
  };
}

const handlers: Record<string, Handler> = {
  app_info: () => ({ name: "AngkorDB", version: "0.1.0 (browser mock)" }),

  list_connections: () => structuredClone(connections),

  save_connection: async (args) => {
    const { config, password } = args as { config: ConnectionConfig; password: PasswordChange };
    await sleep(150);
    const previous = connections.find((c) => c.id === config.id);
    const saved: ConnectionConfig = {
      ...config,
      id: config.id || crypto.randomUUID(),
      name: config.name.trim() || `${config.database} @ ${config.host}`,
      group: config.group?.trim() || null,
      hasPassword:
        password.kind === "set"
          ? true
          : password.kind === "clear"
            ? false
            : !!previous?.hasPassword,
    };
    connections = previous
      ? connections.map((c) => (c.id === saved.id ? saved : c))
      : [...connections, saved];
    return saved;
  },

  delete_connection: (args) => {
    connections = connections.filter((c) => c.id !== args["id"]);
    return null;
  },

  duplicate_connection: (args) => {
    const original = connections.find((c) => c.id === args["id"]);
    if (!original) throw appError("CONNECTION_NOT_FOUND", "connection not found");
    const copy = { ...original, id: crypto.randomUUID(), name: `${original.name} copy` };
    connections = [...connections, copy];
    return copy;
  },

  test_connection: async (args): Promise<ConnectionInfo> => {
    const { config, password } = args as { config: ConnectionConfig; password: PasswordChange };
    await sleep(600);
    if (config.host.includes("bad")) {
      throw appError("CONNECTION", "error connecting to server: Connection refused (os error 61)");
    }
    if (password.kind === "set" && password.value === "wrong") {
      throw appError("POSTGRES", `password authentication failed for user "${config.user}"`, {
        pgCode: "28P01",
      });
    }
    return { serverVersion: "16.4", latencyMs: 12 };
  },

  parse_connection_url: (args) => parseUrl(String(args["url"])),

  connect_connection: async (args): Promise<ConnectionInfo> => {
    await sleep(500);
    const target = connections.find((c) => c.id === args["id"]);
    if (target?.host.includes("example.com")) {
      throw appError("CONNECTION", "error connecting to server: Connection timed out");
    }
    return { serverVersion: "16.4", latencyMs: 8 };
  },

  disconnect_connection: () => null,
};

export function installMockBackend() {
  const internals = {
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      const handler = handlers[command];
      if (!handler) throw appError("INTERNAL", `mock backend: unknown command ${command}`);
      return handler(args);
    },
  };
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: internals, configurable: true });
  console.info("[AngkorDB] Running with the in-browser mock backend (no Tauri window detected).");
}
