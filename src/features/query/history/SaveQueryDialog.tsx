import { useState, type FormEvent } from "react";

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
import type { SaveQueryDraft } from "@/features/query/history/saveDraft";
import { useSaveQuery } from "@/features/query/history/useHistory";
import { errorMessage } from "@/lib/errors";

interface Props {
  draft: SaveQueryDraft;
  connectionId: string;
  connectionName: string;
  /** Folders in use, offered as suggestions. */
  folders: string[];
  onClose: () => void;
}

/** Name and folder for a saved query. */
export function SaveQueryDialog({ draft, connectionId, connectionName, folders, onClose }: Props) {
  const [name, setName] = useState(draft.name);
  const [folder, setFolder] = useState(draft.folder);
  const [forThisConnection, setForThisConnection] = useState(draft.forThisConnection);
  const save = useSaveQuery();
  const editing = draft.id !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || save.isPending) return;
    save.mutate(
      {
        id: draft.id,
        connectionId: forThisConnection ? connectionId : null,
        name,
        folder,
        sql: draft.sql,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit saved query" : "Save query"}</DialogTitle>
            <DialogDescription className="line-clamp-2 font-mono text-xs break-all">
              {draft.sql.trim()}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="saved-name">Name</Label>
            <Input
              id="saved-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Orders placed today"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="saved-folder">Folder</Label>
            <Input
              id="saved-folder"
              list="saved-folders"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="None"
            />
            <datalist id="saved-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={forThisConnection}
              onChange={(e) => setForThisConnection(e.target.checked)}
            />
            Only for {connectionName}
          </label>

          {save.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(save.error)}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {editing ? "Save changes" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
