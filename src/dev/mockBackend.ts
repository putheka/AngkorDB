/**
 * Fake Rust backend for plain-browser development (`npm run dev`, no Tauri window).
 * Installed only in dev builds when `window.__TAURI_INTERNALS__` is missing, so the UI can be
 * built and checked without the native app. State lives in memory and resets on reload.
 */
import type {
  ExportRequest,
  ExportStatus,
  ConnectionConfig,
  SshTestResult,
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
import { cancelMockExport, mockExportStatus, startMockExport } from "@/dev/mockExport";
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

/** What the server's certificate would say, for hosts with a name that asks for it. */
function checkTls(config: ConnectionConfig) {
  const verifying = config.sslMode === "verify-ca" || config.sslMode === "verify-full";
  if (!verifying) return;
  if (config.host.includes("selfsigned") && !config.sslFiles?.rootCert) {
    throw appError(
      "CONNECTION",
      "TLS: The server's certificate was signed by an authority this Mac doesn't trust. Choose the root certificate (CA) file of the server, or set SSL to Require if you only need encryption.",
    );
  }
  if (config.host.includes("wrongname") && config.sslMode === "verify-full") {
    throw appError(
      "CONNECTION",
      `TLS: The server's certificate is for db.example.org, not for ${config.host}. Connect with the name in the certificate, or use Verify CA.`,
    );
  }
}

/** SSH servers the person trusted; the first time a host is seen the connection stops there. */
const trustedHosts = new Set<string>();
const pendingHostKeys = new Map<string, string>();

const fingerprintOf = (host: string) =>
  `SHA256:${btoa(host).replace(/=+$/, "").padEnd(43, "x").slice(0, 43)}`;

/** What opening the SSH tunnel of this connection would say. */
function checkSsh(config: ConnectionConfig) {
  const ssh = config.ssh;
  if (!ssh) return;
  const where = `${ssh.host}:${ssh.port}`;
  if (ssh.host.includes("bad")) {
    throw appError("SSH", `could not connect to ${where}: Connection refused (os error 61)`);
  }
  const fingerprint = fingerprintOf(ssh.host);
  if (ssh.host.includes("changed")) {
    throw appError(
      "SSH_HOST_CHANGED",
      `The SSH host key of ${where} has changed (line 3). It is not the one in known_hosts: the server may have been reinstalled, or someone may be intercepting the connection. Connection refused.`,
      { detail: fingerprint, hint: `ssh-ed25519 · ${where}` },
    );
  }
  if (!trustedHosts.has(where)) {
    pendingHostKeys.set(fingerprint, where);
    throw appError(
      "SSH_HOST_UNKNOWN",
      `The authenticity of the SSH host ${where} can't be established: it is not in known_hosts yet.`,
      { detail: fingerprint, hint: `ssh-ed25519 · ${where}` },
    );
  }
  if (ssh.auth.kind === "password" && !ssh.hasSecret && !secretTyped) {
    throw appError("VALIDATION", "Enter the SSH password.");
  }
  if (ssh.auth.kind === "password" && sshSecretValue === "wrong") {
    throw appError("SSH", `the SSH server ${where} refused the login of ${ssh.user} (password)`);
  }
}

/** The SSH secret of the request being handled, for `checkSsh`. */
let secretTyped = false;
let sshSecretValue: string | null = null;
function noteSshSecret(change: PasswordChange | null | undefined) {
  secretTyped = change?.kind === "set";
  sshSecretValue = change?.kind === "set" ? change.value : null;
}

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
    const { config, password, sshSecret, sslKeySecret } = args as {
      config: ConnectionConfig;
      password: PasswordChange;
      sshSecret: PasswordChange | null;
      sslKeySecret: PasswordChange | null;
    };
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
      sslFiles: config.sslFiles
        ? {
            ...config.sslFiles,
            hasKeySecret: !config.sslFiles.clientKey
              ? false
              : sslKeySecret?.kind === "set"
                ? true
                : sslKeySecret?.kind === "clear"
                  ? false
                  : !!previous?.sslFiles?.hasKeySecret,
          }
        : null,
      ssh: config.ssh
        ? {
            ...config.ssh,
            hasSecret:
              config.ssh.auth.kind === "agent"
                ? false
                : sshSecret?.kind === "set"
                  ? true
                  : sshSecret?.kind === "clear"
                    ? false
                    : !!previous?.ssh?.hasSecret,
          }
        : null,
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
    const { config, password, sshSecret } = args as {
      config: ConnectionConfig;
      password: PasswordChange;
      sshSecret: PasswordChange | null;
    };
    await sleep(600);
    noteSshSecret(sshSecret);
    checkSsh(config);
    checkTls(config);
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

  test_ssh: async (args): Promise<SshTestResult> => {
    const { config, sshSecret } = args as {
      config: ConnectionConfig;
      sshSecret: PasswordChange | null;
    };
    await sleep(500);
    if (!config.ssh) {
      throw appError("VALIDATION", "This connection does not use an SSH tunnel.");
    }
    noteSshSecret(sshSecret);
    checkSsh(config);
    const unreachable = config.host.includes("unreachable");
    return {
      fingerprint: fingerprintOf(config.ssh.host),
      keyType: "ssh-ed25519",
      reachesDatabase: !unreachable,
      databaseProblem: unreachable
        ? `the SSH server could not open ${config.host}:${config.port} (ConnectFailed)`
        : null,
    };
  },

  // The system file dialog: a fixed path stands in for what the person would pick.
  "plugin:dialog|open": (args) =>
    (args["options"] as { directory?: boolean } | undefined)?.directory
      ? "/Users/me/Downloads"
      : "/Users/me/certs/server-ca.pem",
  "plugin:dialog|save": (args) =>
    `/Users/me/Downloads/${String(
      (args["options"] as { defaultPath?: string } | undefined)?.defaultPath ?? "export.csv",
    )}`,
  "plugin:opener|reveal_item_in_dir": () => null,

  start_export: (args) => {
    requireOpen(String(args["connectionId"]));
    return startMockExport(args["request"] as ExportRequest);
  },
  export_status: (args): ExportStatus => mockExportStatus(String(args["id"])),
  cancel_export: (args) => cancelMockExport(String(args["id"])),

  trust_ssh_host: (args) => {
    const where = pendingHostKeys.get(String(args["fingerprint"]));
    if (!where) {
      throw appError(
        "VALIDATION",
        "That host key is not waiting to be trusted. Try connecting again.",
      );
    }
    pendingHostKeys.delete(String(args["fingerprint"]));
    trustedHosts.add(where);
    return null;
  },

  parse_connection_url: (args) => parseUrl(String(args["url"])),

  connect_connection: async (args): Promise<ConnectionInfo> => {
    await sleep(500);
    const target = connections.find((c) => c.id === args["id"]);
    if (target) {
      secretTyped = !!target.ssh?.hasSecret;
      sshSecretValue = null;
      checkSsh(target);
    }
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
