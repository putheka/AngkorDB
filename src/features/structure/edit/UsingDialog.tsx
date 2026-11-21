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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { suggestUsing } from "@/features/structure/edit/structureEdits";

interface Props {
  column: string;
  from: string;
  to: string;
  onConfirm: (using: string) => void;
  onCancel: () => void;
}

/**
 * A column's type is being changed: ask how to turn the values it has into the new type. Postgres
 * converts some by itself (`integer` to `bigint`) and needs a `USING` for the rest (`text` to
 * `integer`); an empty one leaves it to Postgres, which says so if that is not enough.
 */
export function UsingDialog({ column, from, to, onConfirm, onCancel }: Props) {
  const [using, setUsing] = useState(() => suggestUsing(column, to));
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(using.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Change the type of {column} to {to}?
            </DialogTitle>
            <DialogDescription>
              It is {from} now. PostgreSQL can convert some types by itself (integer to bigint). For
              others (text to integer) it needs to be told how: write it as an expression that uses
              the column and gives the new type.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="using-expression">USING</Label>
            <Input
              id="using-expression"
              autoFocus
              value={using}
              onChange={(e) => setUsing(e.target.value)}
              className="font-mono"
              placeholder="leave empty to let PostgreSQL convert it"
            />
            <p className="text-xs text-muted-foreground">
              Nothing is changed until you press Save. The preview shows the whole statement.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Change the type</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
