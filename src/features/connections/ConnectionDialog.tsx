import { useMutation } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";

import type { ColorTag, ConnectionConfig, SafeMode, SshAuth, SslMode } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  applyParsedUrl,
  COLOR_TAGS,
  colorPatch,
  CONNECTION_URL_PATTERN,
  emptyForm,
  formFromConnection,
  formToConfig,
  formToPasswordChange,
  applySshAlias,
  formToJumpSecretChange,
  formToSshSecretChange,
  formToSslKeySecretChange,
  SAFE_MODES,
  SSH_AUTH_METHODS,
  sshSecretLabel,
  SSL_MODE_HELP,
  SSL_MODES,
  validateForm,
  verifiesCertificate,
  type ConnectionForm,
} from "@/features/connections/form";
import { HostKeyDetails } from "@/features/connections/HostKeyDialog";
import { hostKeyStop, type HostKeyStop } from "@/features/connections/hostKey";
import { useGeneral } from "@/stores/general";
import { useSaveConnection } from "@/features/connections/useConnections";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { pickFile } from "@/lib/pickFile";
import { cn } from "@/lib/utils";

interface ConnectionDialogProps {
  /** The connection to edit, or null to create one. */
  connection: ConnectionConfig | null;
  /** Group names already in use, offered as suggestions. */
  groups: string[];
  onClose: () => void;
}

/** Mount this only while it should be visible: the form state resets each time it opens. */
export function ConnectionDialog({ connection, groups, onClose }: ConnectionDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <ConnectionFormBody connection={connection} groups={groups} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function ConnectionFormBody({ connection, groups, onClose }: ConnectionDialogProps) {
  const [form, setForm] = useState<ConnectionForm>(() =>
    connection
      ? formFromConnection(connection)
      : { ...emptyForm, safeMode: useGeneral.getState().defaultSafeMode },
  );
  const [showErrors, setShowErrors] = useState(false);
  const [urlText, setUrlText] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [aliasNote, setAliasNote] = useState<string | null>(null);

  const save = useSaveConnection();
  const test = useMutation({
    mutationFn: (values: ConnectionForm) =>
      commands.testConnection(
        formToConfig(values),
        formToPasswordChange(values),
        formToSshSecretChange(values),
        formToSslKeySecretChange(values),
        formToJumpSecretChange(values),
      ),
  });
  const sshTest = useMutation({
    mutationFn: (values: ConnectionForm) =>
      commands.testSsh(
        formToConfig(values),
        formToSshSecretChange(values),
        formToJumpSecretChange(values),
      ),
  });
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState<unknown>(null);

  const errors = validateForm(form);
  const isValid = Object.keys(errors).length === 0;
  const fieldError = (key: keyof typeof errors) => (showErrors ? errors[key] : undefined);

  /** Change fields. Any edit makes an earlier test result stale. */
  function update(patch: Partial<ConnectionForm>) {
    setForm((current) => ({ ...current, ...patch }));
    test.reset();
    sshTest.reset();
    setTrustError(null);
  }

  async function importUrl(text: string) {
    try {
      const parsed = await commands.parseConnectionUrl(text.trim());
      setForm((current) => applyParsedUrl(current, parsed));
      setUrlText("");
      setUrlError(null);
      test.reset();
      sshTest.reset();
    } catch (error) {
      setUrlError(errorMessage(error));
    }
  }

  /** Pasting a postgres:// URL anywhere in the form fills the whole form. */
  function handlePaste(event: ClipboardEvent<HTMLFormElement>) {
    const text = event.clipboardData.getData("text");
    if (CONNECTION_URL_PATTERN.test(text)) {
      event.preventDefault();
      void importUrl(text);
    }
  }

  /** Fill the SSH section from the entry of `~/.ssh/config` for the host typed in it. */
  async function fillFromSshConfig() {
    const name = form.sshHost.trim();
    if (!name) return setAliasNote("Type the host name or alias first.");
    try {
      const alias = await commands.resolveSshAlias(name);
      if (!alias) return setAliasNote(`No entry for "${name}" in ~/.ssh/config.`);
      setForm((current) => applySshAlias(current, alias));
      test.reset();
      sshTest.reset();
      setAliasNote(
        alias.jump
          ? `Filled from ~/.ssh/config, with its jump host ${alias.jump.host}.`
          : "Filled from ~/.ssh/config.",
      );
    } catch (error) {
      setAliasNote(errorMessage(error));
    }
  }

  function handleTest() {
    if (!isValid) return setShowErrors(true);
    sshTest.reset();
    test.mutate(form);
  }

  function handleTestSsh() {
    if (!isValid) return setShowErrors(true);
    test.reset();
    sshTest.mutate(form);
  }

  /** The host key the last test stopped at is trusted; the same test runs again. */
  async function trustAndRetry(stop: HostKeyStop, again: "connection" | "ssh") {
    setTrusting(true);
    setTrustError(null);
    try {
      await commands.trustSshHost(stop.fingerprint);
      if (again === "ssh") sshTest.mutate(form);
      else test.mutate(form);
    } catch (error) {
      (again === "ssh" ? sshTest : test).reset();
      setTrustError(error);
    } finally {
      setTrusting(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!isValid) return setShowErrors(true);
    try {
      await save.mutateAsync({
        config: formToConfig(form),
        password: formToPasswordChange(form),
        sshSecret: formToSshSecretChange(form),
        sslKeySecret: formToSslKeySecretChange(form),
        sshJumpSecret: formToJumpSecretChange(form),
      });
      onClose();
    } catch {
      // The error is shown under the buttons.
    }
  }

  const busy = save.isPending || test.isPending || sshTest.isPending || trusting;
  const keyPassphrasePlaceholder = form.removeSslKeySecret
    ? "The saved passphrase will be removed"
    : form.hasSslKeySecret
      ? "Saved in Keychain. Type to replace"
      : "Only if the key has one";
  const sshSecretPlaceholder = form.removeSshSecret
    ? "The saved secret will be removed"
    : form.hasSshSecret
      ? "Saved in Keychain. Type to replace"
      : form.sshAuth === "password"
        ? "Required"
        : "Only if the key has one";
  const jumpSecretPlaceholder = form.removeJumpSecret
    ? "The saved secret will be removed"
    : form.hasJumpSecret
      ? "Saved in Keychain. Type to replace"
      : form.jumpAuth === "password"
        ? "Required"
        : "Only if the key has one";
  const passwordPlaceholder = form.removePassword
    ? "The saved password will be removed"
    : form.hasPassword
      ? "Saved in Keychain. Type to replace"
      : "Optional";

  return (
    <form onSubmit={handleSave} onPaste={handlePaste} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{connection ? "Edit connection" : "New connection"}</DialogTitle>
        <DialogDescription>
          Passwords are stored in the macOS Keychain, never in a file.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="conn-url">Connection URL</Label>
        <div className="flex gap-2">
          <Input
            id="conn-url"
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && urlText.trim()) {
                e.preventDefault();
                void importUrl(urlText);
              }
            }}
            placeholder="Paste postgres://user:password@host:5432/database to fill the form"
            autoComplete="off"
            spellCheck={false}
          />
          {urlText.trim() && (
            <Button type="button" variant="secondary" onClick={() => void importUrl(urlText)}>
              Fill
            </Button>
          )}
        </div>
        {urlError && (
          <p role="alert" className="text-xs text-destructive">
            {urlError}
          </p>
        )}
      </div>

      <div className="grid grid-cols-6 gap-x-3 gap-y-3">
        <Field label="Name" htmlFor="conn-name" className="col-span-6">
          <Input
            id="conn-name"
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder={
              form.database && form.host ? `${form.database} @ ${form.host}` : "My database"
            }
            autoComplete="off"
          />
        </Field>

        <Field label="Host" htmlFor="conn-host" error={fieldError("host")} className="col-span-4">
          <Input
            id="conn-host"
            value={form.host}
            onChange={(e) => update({ host: e.target.value })}
            aria-invalid={!!fieldError("host")}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Port" htmlFor="conn-port" error={fieldError("port")} className="col-span-2">
          <Input
            id="conn-port"
            value={form.port}
            onChange={(e) => update({ port: e.target.value })}
            inputMode="numeric"
            aria-invalid={!!fieldError("port")}
            autoComplete="off"
          />
        </Field>

        <Field label="User" htmlFor="conn-user" error={fieldError("user")} className="col-span-3">
          <Input
            id="conn-user"
            value={form.user}
            onChange={(e) => update({ user: e.target.value })}
            aria-invalid={!!fieldError("user")}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Password" htmlFor="conn-password" className="col-span-3">
          <Input
            id="conn-password"
            type="password"
            value={form.password}
            onChange={(e) => update({ password: e.target.value })}
            placeholder={passwordPlaceholder}
            autoComplete="new-password"
          />
          {form.hasPassword && !form.password && (
            <button
              type="button"
              onClick={() => update({ removePassword: !form.removePassword })}
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {form.removePassword ? "Keep the saved password" : "Remove saved password"}
            </button>
          )}
        </Field>

        <Field
          label="Database"
          htmlFor="conn-database"
          error={fieldError("database")}
          className="col-span-3"
        >
          <Input
            id="conn-database"
            value={form.database}
            onChange={(e) => update({ database: e.target.value })}
            aria-invalid={!!fieldError("database")}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="SSL" htmlFor="conn-ssl" className="col-span-3">
          <Select value={form.sslMode} onValueChange={(v) => update({ sslMode: v as SslMode })}>
            <SelectTrigger id="conn-ssl" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SSL_MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="col-span-6 -mt-1 flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{SSL_MODE_HELP[form.sslMode]}</p>
          {form.sslMode !== "disable" && (
            <div className="grid grid-cols-6 gap-x-3 gap-y-3 rounded-lg border p-3">
              {verifiesCertificate(form.sslMode) && (
                <FileField
                  id="ssl-root"
                  label="Root certificate (CA)"
                  value={form.sslRootCert}
                  placeholder="The system's trusted roots"
                  help="When chosen, it is the only authority trusted."
                  onChange={(sslRootCert) => update({ sslRootCert })}
                />
              )}
              <FileField
                id="ssl-cert"
                label="Client certificate"
                value={form.sslClientCert}
                placeholder="Only if the server asks for one"
                error={fieldError("sslClientCert")}
                onChange={(sslClientCert) => update({ sslClientCert })}
              />
              <FileField
                id="ssl-key"
                label="Client key"
                value={form.sslClientKey}
                placeholder="The private key of that certificate"
                onChange={(sslClientKey) => update({ sslClientKey })}
              />
              {form.sslClientKey.trim() !== "" && (
                <Field label="Key passphrase" htmlFor="ssl-passphrase" className="col-span-6">
                  <Input
                    id="ssl-passphrase"
                    type="password"
                    value={form.sslKeySecret}
                    onChange={(e) => update({ sslKeySecret: e.target.value })}
                    placeholder={keyPassphrasePlaceholder}
                    autoComplete="new-password"
                  />
                  {form.hasSslKeySecret && !form.sslKeySecret && (
                    <button
                      type="button"
                      onClick={() => update({ removeSslKeySecret: !form.removeSslKeySecret })}
                      className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {form.removeSslKeySecret
                        ? "Keep the saved passphrase"
                        : "Remove saved passphrase"}
                    </button>
                  )}
                </Field>
              )}
            </div>
          )}
        </div>

        <div className="col-span-6 flex flex-col gap-3 rounded-lg border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={form.useSsh}
              onChange={(e) => update({ useSsh: e.target.checked })}
            />
            Connect through an SSH tunnel
          </label>
          {form.useSsh && (
            <div className="grid grid-cols-6 gap-x-3 gap-y-3">
              <p className="col-span-6 text-xs text-muted-foreground">
                The host and port above are the database as the SSH server sees it:{" "}
                <span className="font-mono">localhost</span> is the SSH server itself.
              </p>
              <div className="col-span-6 flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void fillFromSshConfig()}
                >
                  Fill from ~/.ssh/config
                </Button>
                {aliasNote && (
                  <span role="status" className="text-xs text-muted-foreground">
                    {aliasNote}
                  </span>
                )}
              </div>
              <Field
                label="SSH host"
                htmlFor="ssh-host"
                error={fieldError("sshHost")}
                className="col-span-4"
              >
                <Input
                  id="ssh-host"
                  value={form.sshHost}
                  onChange={(e) => update({ sshHost: e.target.value })}
                  aria-invalid={!!fieldError("sshHost")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="SSH port"
                htmlFor="ssh-port"
                error={fieldError("sshPort")}
                className="col-span-2"
              >
                <Input
                  id="ssh-port"
                  value={form.sshPort}
                  onChange={(e) => update({ sshPort: e.target.value })}
                  inputMode="numeric"
                  aria-invalid={!!fieldError("sshPort")}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="SSH user"
                htmlFor="ssh-user"
                error={fieldError("sshUser")}
                className="col-span-3"
              >
                <Input
                  id="ssh-user"
                  value={form.sshUser}
                  onChange={(e) => update({ sshUser: e.target.value })}
                  aria-invalid={!!fieldError("sshUser")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Log in with" htmlFor="ssh-auth" className="col-span-3">
                <Select
                  value={form.sshAuth}
                  onValueChange={(v) =>
                    // A saved secret belongs to the way it was saved for.
                    update({
                      sshAuth: v as SshAuth["kind"],
                      sshSecret: "",
                      removeSshSecret: form.hasSshSecret,
                    })
                  }
                >
                  <SelectTrigger id="ssh-auth" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SSH_AUTH_METHODS.map((method) => (
                      <SelectItem key={method.value} value={method.value}>
                        {method.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {form.sshAuth === "privateKey" && (
                <Field
                  label="Private key file"
                  htmlFor="ssh-key"
                  error={fieldError("sshKeyPath")}
                  className="col-span-6"
                >
                  <Input
                    id="ssh-key"
                    value={form.sshKeyPath}
                    onChange={(e) => update({ sshKeyPath: e.target.value })}
                    placeholder="~/.ssh/id_ed25519"
                    aria-invalid={!!fieldError("sshKeyPath")}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              )}
              {form.sshAuth !== "agent" && (
                <Field
                  label={sshSecretLabel(form.sshAuth)}
                  htmlFor="ssh-secret"
                  className="col-span-6"
                >
                  <Input
                    id="ssh-secret"
                    type="password"
                    value={form.sshSecret}
                    onChange={(e) => update({ sshSecret: e.target.value })}
                    placeholder={sshSecretPlaceholder}
                    autoComplete="new-password"
                  />
                  {form.hasSshSecret && !form.sshSecret && (
                    <button
                      type="button"
                      onClick={() => update({ removeSshSecret: !form.removeSshSecret })}
                      className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {form.removeSshSecret ? "Keep the saved secret" : "Remove saved secret"}
                    </button>
                  )}
                </Field>
              )}
              {form.sshAuth === "agent" && (
                <p className="col-span-6 text-xs text-muted-foreground">
                  The keys of the running ssh-agent (
                  <span className="font-mono">SSH_AUTH_SOCK</span>) are tried in turn. Add yours
                  with <span className="font-mono">ssh-add</span>.
                </p>
              )}
              <div className="col-span-6 flex flex-col gap-3 rounded-md border border-dashed p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={form.useJump}
                    onChange={(e) => update({ useJump: e.target.checked })}
                  />
                  Go through a jump host first
                </label>
                {form.useJump && (
                  <div className="grid grid-cols-6 gap-x-3 gap-y-3">
                    <p className="col-span-6 text-xs text-muted-foreground">
                      You connect to the jump host (a bastion), and the SSH server above is reached
                      from it.
                    </p>
                    <Field
                      label="Jump host"
                      htmlFor="jump-host"
                      error={fieldError("jumpHost")}
                      className="col-span-4"
                    >
                      <Input
                        id="jump-host"
                        value={form.jumpHost}
                        onChange={(e) => update({ jumpHost: e.target.value })}
                        aria-invalid={!!fieldError("jumpHost")}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                    <Field
                      label="Port"
                      htmlFor="jump-port"
                      error={fieldError("jumpPort")}
                      className="col-span-2"
                    >
                      <Input
                        id="jump-port"
                        value={form.jumpPort}
                        onChange={(e) => update({ jumpPort: e.target.value })}
                        inputMode="numeric"
                        aria-invalid={!!fieldError("jumpPort")}
                        autoComplete="off"
                      />
                    </Field>
                    <Field
                      label="User"
                      htmlFor="jump-user"
                      error={fieldError("jumpUser")}
                      className="col-span-3"
                    >
                      <Input
                        id="jump-user"
                        value={form.jumpUser}
                        onChange={(e) => update({ jumpUser: e.target.value })}
                        aria-invalid={!!fieldError("jumpUser")}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                    <Field label="Log in with" htmlFor="jump-auth" className="col-span-3">
                      <Select
                        value={form.jumpAuth}
                        onValueChange={(v) =>
                          update({
                            jumpAuth: v as SshAuth["kind"],
                            jumpSecret: "",
                            removeJumpSecret: form.hasJumpSecret,
                          })
                        }
                      >
                        <SelectTrigger id="jump-auth" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SSH_AUTH_METHODS.map((method) => (
                            <SelectItem key={method.value} value={method.value}>
                              {method.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    {form.jumpAuth === "privateKey" && (
                      <Field
                        label="Private key file"
                        htmlFor="jump-key"
                        error={fieldError("jumpKeyPath")}
                        className="col-span-6"
                      >
                        <Input
                          id="jump-key"
                          value={form.jumpKeyPath}
                          onChange={(e) => update({ jumpKeyPath: e.target.value })}
                          placeholder="~/.ssh/id_ed25519"
                          aria-invalid={!!fieldError("jumpKeyPath")}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </Field>
                    )}
                    {form.jumpAuth !== "agent" && (
                      <Field
                        label={sshSecretLabel(form.jumpAuth)}
                        htmlFor="jump-secret"
                        className="col-span-6"
                      >
                        <Input
                          id="jump-secret"
                          type="password"
                          value={form.jumpSecret}
                          onChange={(e) => update({ jumpSecret: e.target.value })}
                          placeholder={jumpSecretPlaceholder}
                          autoComplete="new-password"
                        />
                        {form.hasJumpSecret && !form.jumpSecret && (
                          <button
                            type="button"
                            onClick={() => update({ removeJumpSecret: !form.removeJumpSecret })}
                            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            {form.removeJumpSecret
                              ? "Keep the saved secret"
                              : "Remove saved secret"}
                          </button>
                        )}
                      </Field>
                    )}
                  </div>
                )}
              </div>
              <div className="col-span-6">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleTestSsh}
                  disabled={busy}
                >
                  Test SSH
                </Button>
              </div>
            </div>
          )}
        </div>

        <Field label="Group" htmlFor="conn-group" className="col-span-3">
          <Input
            id="conn-group"
            value={form.group}
            onChange={(e) => update({ group: e.target.value })}
            list="conn-groups"
            placeholder="Optional"
            autoComplete="off"
          />
          <datalist id="conn-groups">
            {groups.map((group) => (
              <option key={group} value={group} />
            ))}
          </datalist>
        </Field>
        <Field label="Color" className="col-span-3">
          <ColorPicker value={form.color} onChange={(color) => update(colorPatch(form, color))} />
        </Field>

        <Field
          label="Statement timeout (seconds)"
          htmlFor="conn-timeout"
          error={fieldError("statementTimeout")}
          className="col-span-6"
        >
          <Input
            id="conn-timeout"
            value={form.statementTimeout}
            onChange={(e) => update({ statementTimeout: e.target.value })}
            aria-invalid={!!fieldError("statementTimeout")}
            placeholder="No limit"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field label="Safe mode" htmlFor="conn-safe" className="col-span-6">
          <Select value={form.safeMode} onValueChange={(v) => update({ safeMode: v as SafeMode })}>
            <SelectTrigger id="conn-safe" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SAFE_MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div aria-live="polite" className="min-h-5 text-sm">
        {test.isPending && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Testing…
          </p>
        )}
        {test.isSuccess && (
          <p className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-4" />
            Connected · PostgreSQL {test.data.serverVersion} · {test.data.latencyMs} ms
          </p>
        )}
        {sshTest.isPending && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Testing SSH…
          </p>
        )}
        {sshTest.isSuccess && (
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <CheckIcon className="size-4" />
              SSH login works · host key {sshTest.data.fingerprint || "known"}
            </p>
            {sshTest.data.reachesDatabase ? (
              <p className="pl-6 text-xs text-muted-foreground">
                The SSH server can reach {form.host}:{form.port}.
              </p>
            ) : (
              <p className="flex items-start gap-2 pl-0.5 text-xs text-amber-700 dark:text-amber-300">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                {sshTest.data.databaseProblem ?? "The SSH server can't reach the database."}
              </p>
            )}
          </div>
        )}
        <TestFailure
          error={test.error}
          busy={trusting}
          onTrust={(stop) => void trustAndRetry(stop, "connection")}
        />
        <TestFailure
          error={sshTest.error}
          busy={trusting}
          onTrust={(stop) => void trustAndRetry(stop, "ssh")}
        />
        {trustError !== null && <ErrorNote error={trustError} />}
        {save.isError && <ErrorNote error={save.error} />}
      </div>

      <DialogFooter className="sm:justify-between">
        <Button type="button" variant="outline" onClick={handleTest} disabled={busy}>
          Test connection
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

function Field(props: {
  label: string;
  htmlFor?: string;
  error?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", props.className)}>
      <Label htmlFor={props.htmlFor} className="flex justify-between">
        {props.label}
        {props.error && <span className="text-xs font-normal text-destructive">{props.error}</span>}
      </Label>
      {props.children}
    </div>
  );
}

const SWATCH: Record<ColorTag, string> = {
  none: "border-muted-foreground/40",
  green: "border-emerald-500 bg-emerald-500",
  yellow: "border-amber-400 bg-amber-400",
  red: "border-red-500 bg-red-500",
};

function ColorPicker({
  value,
  onChange,
}: {
  value: ColorTag;
  onChange: (color: ColorTag) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Color tag" className="flex h-8 items-center gap-2.5">
      {COLOR_TAGS.map((tag) => (
        <button
          key={tag.value}
          type="button"
          role="radio"
          aria-checked={value === tag.value}
          aria-label={tag.label}
          title={tag.label}
          onClick={() => onChange(tag.value)}
          className={cn(
            "size-5 rounded-full border-2 outline-offset-2 transition-shadow focus-visible:outline-2 focus-visible:outline-ring",
            SWATCH[tag.value],
            value === tag.value && "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
        />
      ))}
    </div>
  );
}

/** A path to a file: typed, or picked with the system's file dialog. */
function FileField(props: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  help?: string;
  error?: string | undefined;
  onChange: (path: string) => void;
}) {
  async function browse() {
    try {
      const chosen = await pickFile(props.label);
      if (chosen) props.onChange(chosen);
    } catch {
      // No file dialog here (a plain browser): the path can still be typed.
    }
  }
  return (
    <Field label={props.label} htmlFor={props.id} error={props.error} className="col-span-6">
      <div className="flex gap-2">
        <Input
          id={props.id}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          aria-invalid={!!props.error}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="button" variant="outline" onClick={() => void browse()}>
          Browse…
        </Button>
      </div>
      {props.help && <p className="text-xs text-muted-foreground">{props.help}</p>}
    </Field>
  );
}

/** A failed test: a new SSH host key asks to be trusted; anything else is shown as an error. */
function TestFailure({
  error,
  busy,
  onTrust,
}: {
  error: unknown;
  busy: boolean;
  onTrust: (stop: HostKeyStop) => void;
}) {
  if (error === null || error === undefined) return null;
  const stop = hostKeyStop(error);
  if (stop?.kind !== "unknown") return <ErrorNote error={error} />;
  return (
    <div role="alert" className="flex flex-col gap-2">
      <p className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        {stop.message}
      </p>
      <HostKeyDetails summary={stop.summary} fingerprint={stop.fingerprint} />
      <div>
        <Button type="button" size="sm" disabled={busy} onClick={() => onTrust(stop)}>
          {busy ? "Working…" : "Trust and test again"}
        </Button>
      </div>
    </div>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  const details = errorDetails(error);
  return (
    <div role="alert" className="text-destructive">
      <p>✗ {errorMessage(error)}</p>
      {details.map((line) => (
        <p key={line} className="pl-4 text-xs text-destructive/80">
          {line}
        </p>
      ))}
    </div>
  );
}
