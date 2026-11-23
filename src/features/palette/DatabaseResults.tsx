import { DatabaseIcon } from "lucide-react";
import { useMemo } from "react";

import { CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { recentDatabases } from "@/features/palette/databasePick";
import { useDatabaseRecents } from "@/features/palette/databaseRecents";
import { Highlighted } from "@/features/sidebar/Highlighted";
import { matchLabels, type Match } from "@/features/palette/items";
import { useDatabases, useSwitchDatabase } from "@/features/sidebar/useSchema";
import { errorMessage } from "@/lib/errors";
import { usePaletteStore } from "@/stores/palette";

const NO_RECENTS: string[] = [];

/** The databases of the server: the ones switched to last, then all of them; typing narrows. */
export function DatabaseResults({
  connectionId,
  query,
  onError,
}: {
  connectionId: string;
  query: string;
  onError: (message: string | null) => void;
}) {
  const close = usePaletteStore((s) => s.close);
  const databases = useDatabases(connectionId);
  const switchDatabase = useSwitchDatabase(connectionId);
  const saved = useDatabaseRecents((s) => s.byConnection[connectionId]) ?? NO_RECENTS;

  const names = useMemo(() => (databases.data ?? []).map((d) => d.name), [databases.data]);
  const current = databases.data?.find((d) => d.isCurrent)?.name;
  const recent = useMemo(() => recentDatabases(saved, names, current), [saved, names, current]);
  const matches = useMemo(() => matchLabels(names, (n) => n, query), [names, query]);

  const choose = (name: string) => {
    onError(null);
    if (name === current) {
      close();
      return;
    }
    // Stay open until the switch works, so a failure can be shown here.
    switchDatabase.mutate(name, {
      onSuccess: () => close(),
      onError: (e) => onError(errorMessage(e)),
    });
  };
  const plain = (name: string): Match<string> => ({ item: name, indices: [], score: 0 });
  const row = (group: string, match: Match<string>) => (
    <CommandItem
      key={`${group}:${match.item}`}
      value={`${group}:${match.item}`}
      onSelect={() => choose(match.item)}
    >
      <DatabaseIcon className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        <Highlighted text={match.item} indices={match.indices} />
      </span>
      {match.item === current && <span className="text-xs text-muted-foreground">current</span>}
    </CommandItem>
  );

  if (databases.isPending) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (query.trim() === "") {
    return (
      <>
        {recent.length > 0 && (
          <CommandGroup heading="Recent">{recent.map((n) => row("recent", plain(n)))}</CommandGroup>
        )}
        <CommandGroup heading={`All databases (${names.length})`}>
          {names.map((n) => row("all", plain(n)))}
        </CommandGroup>
      </>
    );
  }
  return matches.length === 0 ? (
    <CommandEmpty>No database matches.</CommandEmpty>
  ) : (
    <CommandGroup heading="Results">{matches.map((m) => row("hit", m))}</CommandGroup>
  );
}
