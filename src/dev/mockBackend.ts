/**
 * Fake Rust backend for plain-browser development (`npm run dev`, no Tauri window).
 * Installed only in dev builds when `window.__TAURI_INTERNALS__` is missing, so the UI can be
 * built and checked without the native app. State lives in memory and resets on reload.
 */
import type {
  ConnectionConfig,
  PrivilegeChange,
  PrivilegeTarget,
  RoleOperation,
  ConnectionInfo,
  ParsedConnectionUrl,
  PasswordChange,
  ObjectOperation,
  SslMode,
  StructureChange,
} from "@/bindings";

import { mockCancelBackend, mockListActivity, mockTerminateBackend } from "@/dev/mockActivity";
import {
  mockDefaultPrivileges,
  mockMatrix,
  mockPrivilegeApply,
  mockPrivilegePreview,
  mockRoleApply,
  mockRoleList,
  mockRolePreview,
} from "@/dev/mockRoles";
import { createChangeHandlers } from "@/dev/mockChanges";
import { createHistoryHandlers } from "@/dev/mockHistory";
import { createQueryHandlers } from "@/dev/mockQuery";
import { createRowHandlers } from "@/dev/mockRows";
import { createSchemaHandlers } from "@/dev/mockSchema";
import { mockDatabases } from "@/dev/mockSchema";
import {
  mockDefinition,
  mockObjectApply,
  mockObjectPreview,
  mockSequenceInfo,
} from "@/dev/mockObjects";
import { mockApply, mockPreview, mockTableStructure } from "@/dev/mockStructure";
import { appError, sleep, type Handler } from "@/dev/mockSupport";

/** Connections opened with `connect_connection`; schema commands need one. */
const openConnections = new Set<string>();

const base: Omit<ConnectionConfig, "id" | "name" | "host" | "port" | "user" | "database"> = {
  sslMode: "prefer",
  color: "none",
  group: null,
  safeMode: "off",
  statementTimeoutMs: null,
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

function requireOpen(id: string) {
  if (!openConnections.has(id)) throw appError("NOT_CONNECTED", `not connected to ${id}`);
}

function requireWritable(id: string) {
  if (connections.find((c) => c.id === id)?.safeMode === "read-only") {
    throw appError("VALIDATION", "This connection is read-only (safe mode).");
  }
}

const handlers: Record<string, Handler> = {
  app_info: () => ({ name: "AngkorDB", version: "0.1.0 (browser mock)" }),

  // Quitting and the window's edited dot only exist in the native app.
  set_unsaved_changes: (args) => {
    (window as unknown as { __unsavedChanges?: number }).__unsavedChanges = Number(args["count"]);
    return null;
  },
  quit_app: () => null,

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
    openConnections.add(String(args["id"]));
    return { serverVersion: "16.4", latencyMs: 8 };
  },

  disconnect_connection: (args) => {
    openConnections.delete(String(args["id"]));
    return null;
  },

  ...createSchemaHandlers(requireOpen),
  table_structure: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockTableStructure(String(args["schema"]), String(args["table"]));
  },
  list_activity: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockListActivity();
  },
  cancel_backend: (args) => {
    requireOpen(String(args["connectionId"]));
    requireWritable(String(args["connectionId"]));
    return mockCancelBackend(Number(args["pid"]));
  },
  terminate_backend: (args) => {
    requireOpen(String(args["connectionId"]));
    requireWritable(String(args["connectionId"]));
    return mockTerminateBackend(Number(args["pid"]));
  },
  list_roles: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockRoleList();
  },
  preview_role_operation: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockRolePreview(args["operation"] as RoleOperation);
  },
  apply_role_operation: async (args) => {
    requireOpen(String(args["connectionId"]));
    requireWritable(String(args["connectionId"]));
    await sleep(120);
    return mockRoleApply(args["operation"] as RoleOperation);
  },
  object_privileges: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockMatrix(args["target"] as PrivilegeTarget);
  },
  default_privileges: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockDefaultPrivileges();
  },
  preview_privilege_changes: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockPrivilegePreview(args["changes"] as PrivilegeChange[]);
  },
  apply_privilege_changes: async (args) => {
    requireOpen(String(args["connectionId"]));
    requireWritable(String(args["connectionId"]));
    await sleep(120);
    return mockPrivilegeApply(args["changes"] as PrivilegeChange[]);
  },
  database_options: (args) => {
    requireOpen(String(args["connectionId"]));
    return {
      roles: ["angkor", "app", "readonly"],
      templates: ["template0", "template1", ...mockDatabases()],
      encodings: ["EUC_JP", "LATIN1", "SQL_ASCII", "UTF8", "WIN1252"],
      currentRole: "angkor",
    };
  },
  database_connections: (args) => {
    requireOpen(String(args["connectionId"]));
    return String(args["name"]) === "postgres" ? 2 : 0;
  },
  object_definition: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockDefinition(String(args["kind"]), String(args["schema"]), String(args["name"]));
  },
  sequence_info: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockSequenceInfo(String(args["schema"]), String(args["name"]));
  },
  preview_object_operation: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockObjectPreview(args["operation"] as ObjectOperation);
  },
  apply_object_operation: async (args) => {
    requireOpen(String(args["connectionId"]));
    await sleep(120);
    const target = connections.find((c) => c.id === String(args["connectionId"]));
    if (target?.safeMode === "read-only") {
      throw appError("VALIDATION", "This connection is read-only (safe mode).");
    }
    return mockObjectApply(args["operation"] as ObjectOperation);
  },
  preview_structure_changes: (args) => {
    requireOpen(String(args["connectionId"]));
    return mockPreview(
      String(args["schema"]),
      String(args["table"]),
      args["changes"] as StructureChange[],
    );
  },
  apply_structure_changes: async (args) => {
    requireOpen(String(args["connectionId"]));
    await sleep(150);
    const target = connections.find((c) => c.id === String(args["connectionId"]));
    if (target?.safeMode === "read-only") {
      throw appError("VALIDATION", "This connection is read-only (safe mode).");
    }
    return mockApply(
      String(args["schema"]),
      String(args["table"]),
      args["changes"] as StructureChange[],
    );
  },
  ...createRowHandlers(requireOpen),
  ...createChangeHandlers(requireOpen, (id) => connections.find((c) => c.id === id)?.safeMode),
  ...createQueryHandlers(requireOpen),
  ...createHistoryHandlers(),
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
