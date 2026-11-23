import { useMutation } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, MinusIcon, TriangleAlertIcon } from "lucide-react";
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
      <DialogHeader className="items-center text-center">
        <DialogTitle>{connection ? "Edit connection" : "New connection"}</DialogTitle>
        <DialogDescription>
          PostgreSQL. Passwords are stored in the macOS Keychain, never in a file.
        </DialogDescription>
      </DialogHeader>

      <Panel>
        <Row label="URL" htmlFor="conn-url" error={urlError ?? undefined}>
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
              placeholder="Paste postgres://user:password@host:5432/database"
              autoComplete="off"
              spellCheck={false}
            />
            {urlText.trim() && (
              <Button type="button" variant="secondary" onClick={() => void importUrl(urlText)}>
                Fill
              </Button>
            )}
          </div>
        </Row>
        <Row label="Name" htmlFor="conn-name">
          <Input
            id="conn-name"
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder={
              form.database && form.host ? `${form.database} @ ${form.host}` : "My database"
            }
            autoComplete="off"
          />
        </Row>
        <Row label="Status color">
          <div className="flex items-center justify-between gap-3">
            <ColorPicker value={form.color} onChange={(color) => update(colorPatch(form, color))} />
            <div className="flex items-center gap-2">
              <Label htmlFor="conn-group" className="font-normal text-muted-foreground">
                Tag
              </Label>
              <Input
                id="conn-group"
                value={form.group}
                onChange={(e) => update({ group: e.target.value })}
                list="conn-groups"
                placeholder="Group"
                autoComplete="off"
                className="w-36"
              />
              <datalist id="conn-groups">
                {groups.map((group) => (
                  <option key={group} value={group} />
                ))}
              </datalist>
            </div>
          </div>
        </Row>
        <Row label="Safe mode" htmlFor="conn-safe">
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
        </Row>
      </Panel>

      <Panel>
        <Row
          label="Host/Socket"
          htmlFor="conn-host"
          error={fieldError("host") ?? fieldError("port")}
        >
          <div className="flex items-center gap-3">
            <Input
              id="conn-host"
              value={form.host}
              onChange={(e) => update({ host: e.target.value })}
              aria-invalid={!!fieldError("host")}
              autoComplete="off"
              spellCheck={false}
            />
            <Label htmlFor="conn-port" className="font-normal text-muted-foreground">
              Port
            </Label>
            <Input
              id="conn-port"
              value={form.port}
              onChange={(e) => update({ port: e.target.value })}
              inputMode="numeric"
              aria-invalid={!!fieldError("port")}
              autoComplete="off"
              className="w-24 shrink-0"
            />
          </div>
        </Row>
        <Row label="User" htmlFor="conn-user" error={fieldError("user")}>
          <Input
            id="conn-user"
            value={form.user}
            onChange={(e) => update({ user: e.target.value })}
            aria-invalid={!!fieldError("user")}
            autoComplete="off"
            spellCheck={false}
          />
        </Row>
        <Row label="Password" htmlFor="conn-password">
          <Input
            id="conn-password"
            type="password"
            value={form.password}
            onChange={(e) => update({ password: e.target.value })}
            placeholder={passwordPlaceholder}
            autoComplete="new-password"
          />
          {form.hasPassword && !form.password && (
            <LinkButton onClick={() => update({ removePassword: !form.removePassword })}>
              {form.removePassword ? "Keep the saved password" : "Remove saved password"}
            </LinkButton>
          )}
        </Row>
        <Row label="Database" htmlFor="conn-database" error={fieldError("database")}>
          <Input
            id="conn-database"
            value={form.database}
            onChange={(e) => update({ database: e.target.value })}
            aria-invalid={!!fieldError("database")}
            autoComplete="off"
            spellCheck={false}
          />
        </Row>
        <Row
          label="Statement timeout"
          htmlFor="conn-timeout"
          error={fieldError("statementTimeout")}
        >
          <Input
            id="conn-timeout"
            value={form.statementTimeout}
            onChange={(e) => update({ statementTimeout: e.target.value })}
            aria-invalid={!!fieldError("statementTimeout")}
            placeholder="Seconds. No limit if empty"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
          />
        </Row>
        <Row label="SSL mode" htmlFor="conn-ssl">
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
          <p className="text-xs text-muted-foreground">{SSL_MODE_HELP[form.sslMode]}</p>
        </Row>
        {form.sslMode !== "disable" && (
          <Row label="SSL keys" error={fieldError("sslClientCert")}>
            <div className="flex gap-2">
              {verifiesCertificate(form.sslMode) && (
                <FileButton
                  label="CA Cert…"
                  value={form.sslRootCert}
                  onChange={(sslRootCert) => update({ sslRootCert })}
                />
              )}
              <FileButton
                label="Cert…"
                value={form.sslClientCert}
                onChange={(sslClientCert) => update({ sslClientCert })}
              />
              <FileButton
                label="Key…"
                value={form.sslClientKey}
                onChange={(sslClientKey) => update({ sslClientKey })}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Clear the SSL files"
                title="Clear the SSL files"
                disabled={!form.sslRootCert && !form.sslClientCert && !form.sslClientKey}
                onClick={() => update({ sslRootCert: "", sslClientCert: "", sslClientKey: "" })}
              >
                <MinusIcon />
              </Button>
            </div>
          </Row>
        )}
        {form.sslMode !== "disable" && form.sslClientKey.trim() !== "" && (
          <Row label="Key passphrase" htmlFor="ssl-passphrase">
            <Input
              id="ssl-passphrase"
              type="password"
              value={form.sslKeySecret}
              onChange={(e) => update({ sslKeySecret: e.target.value })}
              placeholder={keyPassphrasePlaceholder}
              autoComplete="new-password"
            />
            {form.hasSslKeySecret && !form.sslKeySecret && (
              <LinkButton onClick={() => update({ removeSslKeySecret: !form.removeSslKeySecret })}>
                {form.removeSslKeySecret ? "Keep the saved passphrase" : "Remove saved passphrase"}
              </LinkButton>
            )}
          </Row>
        )}
      </Panel>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            aria-pressed={form.useSsh}
            onClick={() => update({ useSsh: !form.useSsh })}
            className={cn(
              "px-4 font-medium",
              form.useSsh
                ? "bg-orange-500 text-white hover:bg-orange-500/90"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
            )}
          >
            Over SSH
          </Button>
          {!form.useSsh && (
            <span className="text-xs text-muted-foreground">
              Reach a database through an SSH server
            </span>
          )}
        </div>

        {form.useSsh && (
          <Panel>
            <p className="text-xs text-muted-foreground">
              The host and port above are the database as the SSH server sees it:{" "}
              <span className="font-mono">localhost</span> is the SSH server itself.
            </p>
            <Row
              label="Server"
              htmlFor="ssh-host"
              error={fieldError("sshHost") ?? fieldError("sshPort")}
            >
              <div className="flex items-center gap-3">
                <Input
                  id="ssh-host"
                  value={form.sshHost}
                  onChange={(e) => update({ sshHost: e.target.value })}
                  aria-invalid={!!fieldError("sshHost")}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Label htmlFor="ssh-port" className="font-normal text-muted-foreground">
                  Port
                </Label>
                <Input
                  id="ssh-port"
                  value={form.sshPort}
                  onChange={(e) => update({ sshPort: e.target.value })}
                  inputMode="numeric"
                  aria-invalid={!!fieldError("sshPort")}
                  autoComplete="off"
                  className="w-24 shrink-0"
                />
              </div>
            </Row>
            <Row label="User" htmlFor="ssh-user" error={fieldError("sshUser")}>
              <Input
                id="ssh-user"
                value={form.sshUser}
                onChange={(e) => update({ sshUser: e.target.value })}
                aria-invalid={!!fieldError("sshUser")}
                autoComplete="off"
                spellCheck={false}
              />
            </Row>
            {form.sshAuth !== "agent" && (
              <Row
                label={form.sshAuth === "password" ? "Password" : "Passphrase"}
                htmlFor="ssh-secret"
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
                  <LinkButton onClick={() => update({ removeSshSecret: !form.removeSshSecret })}>
                    {form.removeSshSecret ? "Keep the saved secret" : "Remove saved secret"}
                  </LinkButton>
                )}
              </Row>
            )}
            <Row
              label={
                <label className="flex cursor-pointer items-center justify-end gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.sshAuth === "privateKey"}
                    onChange={(e) =>
                      // A saved secret belongs to the way it was saved for.
                      update({
                        sshAuth: e.target.checked ? "privateKey" : "password",
                        sshSecret: "",
                        removeSshSecret: form.hasSshSecret,
                      })
                    }
                  />
                  Use SSH key
                </label>
              }
              error={fieldError("sshKeyPath")}
            >
              {form.sshAuth === "privateKey" ? (
                <div className="flex gap-2">
                  <Input
                    id="ssh-key"
                    aria-label="Private key file"
                    value={form.sshKeyPath}
                    onChange={(e) => update({ sshKeyPath: e.target.value })}
                    placeholder="~/.ssh/id_ed25519"
                    aria-invalid={!!fieldError("sshKeyPath")}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <FileButton
                    label="Browse…"
                    value=""
                    title="Choose the private key file"
                    className="flex-none"
                    onChange={(sshKeyPath) => update({ sshKeyPath })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Clear the key file"
                    title="Clear the key file"
                    disabled={!form.sshKeyPath}
                    onClick={() => update({ sshKeyPath: "" })}
                  >
                    <MinusIcon />
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {form.sshAuth === "agent"
                    ? "The keys of the running ssh-agent (SSH_AUTH_SOCK) are tried in turn. Add yours with ssh-add."
                    : "Log in with the password above."}
                </p>
              )}
              <LinkButton
                onClick={() =>
                  update({
                    sshAuth: form.sshAuth === "agent" ? "password" : "agent",
                    sshSecret: "",
                    removeSshSecret: form.hasSshSecret,
                  })
                }
              >
                {form.sshAuth === "agent" ? "Use a password or key" : "Use the ssh-agent instead"}
              </LinkButton>
            </Row>

            <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={form.useJump}
                  onChange={(e) => update({ useJump: e.target.checked })}
                />
                Go through a jump host first
              </label>
              {form.useJump && (
                <>
                  <p className="text-xs text-muted-foreground">
                    You connect to the jump host (a bastion), and the SSH server above is reached
                    from it.
                  </p>
                  <Row
                    label="Jump host"
                    htmlFor="jump-host"
                    error={fieldError("jumpHost") ?? fieldError("jumpPort")}
                  >
                    <div className="flex items-center gap-3">
                      <Input
                        id="jump-host"
                        value={form.jumpHost}
                        onChange={(e) => update({ jumpHost: e.target.value })}
                        aria-invalid={!!fieldError("jumpHost")}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <Label htmlFor="jump-port" className="font-normal text-muted-foreground">
                        Port
                      </Label>
                      <Input
                        id="jump-port"
                        value={form.jumpPort}
                        onChange={(e) => update({ jumpPort: e.target.value })}
                        inputMode="numeric"
                        aria-invalid={!!fieldError("jumpPort")}
                        autoComplete="off"
                        className="w-24 shrink-0"
                      />
                    </div>
                  </Row>
                  <Row label="User" htmlFor="jump-user" error={fieldError("jumpUser")}>
                    <Input
                      id="jump-user"
                      value={form.jumpUser}
                      onChange={(e) => update({ jumpUser: e.target.value })}
                      aria-invalid={!!fieldError("jumpUser")}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Row>
                  <Row label="Log in with" htmlFor="jump-auth">
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
                  </Row>
                  {form.jumpAuth === "privateKey" && (
                    <Row label="Key file" error={fieldError("jumpKeyPath")}>
                      <div className="flex gap-2">
                        <Input
                          id="jump-key"
                          aria-label="Jump host private key file"
                          value={form.jumpKeyPath}
                          onChange={(e) => update({ jumpKeyPath: e.target.value })}
                          placeholder="~/.ssh/id_ed25519"
                          aria-invalid={!!fieldError("jumpKeyPath")}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <FileButton
                          label="Browse…"
                          value=""
                          title="Choose the private key file"
                          className="flex-none"
                          onChange={(jumpKeyPath) => update({ jumpKeyPath })}
                        />
                      </div>
                    </Row>
                  )}
                  {form.jumpAuth !== "agent" && (
                    <Row label={sshSecretLabel(form.jumpAuth)} htmlFor="jump-secret">
                      <Input
                        id="jump-secret"
                        type="password"
                        value={form.jumpSecret}
                        onChange={(e) => update({ jumpSecret: e.target.value })}
                        placeholder={jumpSecretPlaceholder}
                        autoComplete="new-password"
                      />
                      {form.hasJumpSecret && !form.jumpSecret && (
                        <LinkButton
                          onClick={() => update({ removeJumpSecret: !form.removeJumpSecret })}
                        >
                          {form.removeJumpSecret ? "Keep the saved secret" : "Remove saved secret"}
                        </LinkButton>
                      )}
                    </Row>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fillFromSshConfig()}
              >
                Fill from ~/.ssh/config
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleTestSsh}
                disabled={busy}
              >
                Test SSH
              </Button>
              {aliasNote && (
                <span role="status" className="text-xs text-muted-foreground">
                  {aliasNote}
                </span>
              )}
            </div>
          </Panel>
        )}
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

      <DialogFooter className="sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} disabled={busy}>
          Test
        </Button>
        <Button type="submit" disabled={busy}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A group of rows on a slightly raised panel, like the sections of TablePlus's form. */
function Panel({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4">{children}</div>;
}

/** One line of the form: its name right-aligned on the left, the control on the right. */
function Row(props: {
  label: ReactNode;
  htmlFor?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-x-3">
      {typeof props.label === "string" ? (
        <Label
          htmlFor={props.htmlFor}
          className="h-8 justify-end text-right font-normal text-muted-foreground"
        >
          {props.label}
        </Label>
      ) : (
        <div className="flex h-8 items-center justify-end text-muted-foreground">{props.label}</div>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        {props.children}
        {props.error && <span className="text-xs text-destructive">{props.error}</span>}
      </div>
    </div>
  );
}

function LinkButton(props: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {props.children}
    </button>
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

/** A button that picks a file with the system's dialog. Once one is chosen it shows its name. */
function FileButton(props: {
  label: string;
  value: string;
  title?: string;
  className?: string;
  onChange: (path: string) => void;
}) {
  async function browse() {
    try {
      const chosen = await pickFile(props.title ?? props.label.replace("…", ""));
      if (chosen) props.onChange(chosen);
    } catch {
      // No file dialog here (a plain browser).
    }
  }
  const name = props.value.split("/").filter(Boolean).pop();
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void browse()}
      title={props.value || props.title || props.label}
      className={cn("min-w-0 flex-1", name && "text-foreground", props.className)}
    >
      <span className="truncate">{name ?? props.label}</span>
    </Button>
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
