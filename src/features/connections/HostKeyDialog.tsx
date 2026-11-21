import { ShieldQuestionIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSessionStore } from "@/stores/session";

/**
 * "The authenticity of host … can't be established": the SSH server's host key is new. Shown when
 * connecting stopped there; trusting it records the key in known_hosts and connects again.
 */
export function HostKeyDialog() {
  const hostKey = useSessionStore((s) => s.hostKey);
  const trust = useSessionStore((s) => s.trustHostKey);
  const dismiss = useSessionStore((s) => s.dismissHostKey);
  const [working, setWorking] = useState(false);

  if (!hostKey) return null;
  const { connection, stop } = hostKey;

  return (
    <Dialog open onOpenChange={(open) => !open && !working && dismiss()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldQuestionIcon className="size-5" /> Trust this SSH server?
          </DialogTitle>
          <DialogDescription>
            “{connection.name}” goes through an SSH server this Mac has not seen before.
          </DialogDescription>
        </DialogHeader>
        <HostKeyDetails summary={stop.summary} fingerprint={stop.fingerprint} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={dismiss} disabled={working}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={working}
            onClick={() => {
              setWorking(true);
              void trust().finally(() => setWorking(false));
            }}
          >
            {working ? "Connecting…" : "Trust and connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The key's type, address and fingerprint, to compare with what the server's owner gave you. */
export function HostKeyDetails({ summary, fingerprint }: { summary: string; fingerprint: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 text-xs">
      {summary && <p className="text-muted-foreground">{summary}</p>}
      <p className="font-mono break-all select-text">{fingerprint}</p>
      <p className="text-muted-foreground">
        Compare this fingerprint with the one the server's owner gave you (
        <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the server). Trusting it
        adds the server to <code>~/.ssh/known_hosts</code>.
      </p>
    </div>
  );
}
