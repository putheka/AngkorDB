import type { ConstraintInfo, TableStructure, TriggerInfo } from "@/bindings";
import { Badge, Empty, Table, Th } from "@/features/structure/table";
import { formatBytes } from "@/lib/format";

export function IndexesTable({ structure }: { structure: TableStructure }) {
  if (structure.indexes.length === 0) return <Empty>This has no indexes.</Empty>;
  return (
    <Table label="Indexes">
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Method</Th>
          <Th>Columns</Th>
          <Th>Definition</Th>
          <Th className="text-right">Size</Th>
        </tr>
      </thead>
      <tbody>
        {structure.indexes.map((index) => (
          <tr key={index.name} className="border-b border-border/50 align-top hover:bg-accent/30">
            <td className="px-2 py-1 font-medium">
              {index.name}
              <div className="mt-0.5">
                {index.primary && <Badge>primary key</Badge>}
                {index.unique && !index.primary && <Badge>unique</Badge>}
                {index.partial && <Badge>partial</Badge>}
                {!index.valid && <Badge tone="warn">invalid</Badge>}
              </div>
            </td>
            <td className="px-2 py-1">{index.method}</td>
            <td className="px-2 py-1 font-mono">{index.columns.join(", ")}</td>
            <td className="px-2 py-1 font-mono break-all text-muted-foreground">
              {index.definition}
              {index.comment && <div className="font-sans">{index.comment}</div>}
            </td>
            <td className="px-2 py-1 text-right tabular-nums">{formatBytes(index.sizeBytes)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const KIND_LABELS: Record<ConstraintInfo["kind"], string> = {
  primaryKey: "Primary key",
  foreignKey: "Foreign key",
  unique: "Unique",
  check: "Check",
  exclusion: "Exclusion",
};

export function ConstraintsTable({ structure }: { structure: TableStructure }) {
  if (structure.constraints.length === 0) return <Empty>This has no constraints.</Empty>;
  return (
    <Table label="Constraints">
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Type</Th>
          <Th>Columns</Th>
          <Th>Definition</Th>
        </tr>
      </thead>
      <tbody>
        {structure.constraints.map((c) => (
          <tr key={c.name} className="border-b border-border/50 align-top hover:bg-accent/30">
            <td className="px-2 py-1 font-medium">
              {c.name}
              <div className="mt-0.5">
                {c.deferrable && (
                  <Badge>{c.initiallyDeferred ? "deferrable, deferred" : "deferrable"}</Badge>
                )}
                {!c.validated && <Badge tone="warn">not validated</Badge>}
              </div>
            </td>
            <td className="px-2 py-1">{KIND_LABELS[c.kind]}</td>
            <td className="px-2 py-1 font-mono">{c.columns.join(", ")}</td>
            <td className="px-2 py-1 font-mono break-all text-muted-foreground">
              {c.definition}
              {c.comment && <div className="font-sans">{c.comment}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const STATE_LABELS: Record<TriggerInfo["state"], string | null> = {
  enabled: null,
  disabled: "disabled",
  replica: "replica only",
  always: "always",
};

export function TriggersTable({ structure }: { structure: TableStructure }) {
  if (structure.triggers.length === 0) return <Empty>This has no triggers.</Empty>;
  return (
    <Table label="Triggers">
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>When</Th>
          <Th>Function</Th>
          <Th>Definition</Th>
        </tr>
      </thead>
      <tbody>
        {structure.triggers.map((t) => {
          const state = STATE_LABELS[t.state];
          return (
            <tr key={t.name} className="border-b border-border/50 align-top hover:bg-accent/30">
              <td className="px-2 py-1 font-medium">
                {t.name}
                {state && (
                  <div className="mt-0.5">
                    <Badge tone={t.state === "disabled" ? "warn" : undefined}>{state}</Badge>
                  </div>
                )}
              </td>
              <td className="px-2 py-1">
                {t.timing} {t.events.join(" OR ")}
                <div className="text-muted-foreground">
                  {t.perRow ? "for each row" : "for each statement"}
                </div>
              </td>
              <td className="px-2 py-1 font-mono">{t.function}()</td>
              <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                {t.definition}
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
