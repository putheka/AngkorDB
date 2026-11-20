import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";

import type { ColumnInfo } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FkPicker } from "@/features/grid/detail/FkPicker";
import { JsonEditor } from "@/features/grid/detail/JsonEditor";
import type { ForeignKeyGroup } from "@/features/grid/foreignKeys";
import type { CellValue } from "@/features/grid/editing/changes";
import { editorKindOf, normalize, validate } from "@/features/grid/editing/editorKind";
import { commands } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** `bytea` as Postgres prints it: `\x` and hex digits. */
const BYTEA_OID = 17;
const HEX = /^\\x([0-9a-fA-F]{2})*$/;

interface DetailFieldProps {
  connectionId: string;
  column: ColumnInfo;
  /** What the cell holds now: a staged edit if there is one, else what the server sent. */
  value: CellValue;
  edited: boolean;
  /** The column can be written and the row is not going away. */
  editable: boolean;
  onChange: (value: CellValue) => void;
  onRevert: () => void;
  /** The column is part of a foreign key: link to the row it points at, and pick another. */
  foreignKey?: {
    group: ForeignKeyGroup;
    /** The key has a value in every column, so there is a row to open. */
    canFollow: boolean;
    onFollow: () => void;
    /** Write the picked row's values into the columns of the key. */
    onPick: (values: Record<string, string | null>) => void;
  };
}

/** `4 bytes`, from the hex text of a bytea value. */
function byteSize(hex: string): string {
  const bytes = Math.max(0, Math.floor((hex.length - 2) / 2));
  return `${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"}`;
}

/** One column of the row, laid out as a form field with the editor its type needs. */
export function DetailField(props: DetailFieldProps) {
  const { column, value, edited, editable, onChange, onRevert, foreignKey } = props;
  const [picking, setPicking] = useState(false);
  const kind = editorKindOf(column);
  const isBytea = column.typeOid === BYTEA_OID;

  return (
    <div className="flex flex-col gap-1" data-field={column.name}>
      <div className="flex items-baseline gap-1.5 text-xs">
        <label className="truncate font-medium" title={column.name}>
          {column.name}
        </label>
        <span className="truncate text-muted-foreground">{column.typeName}</span>
        {column.isPrimaryKey && <Tag>PK</Tag>}
        {!column.nullable && <Tag>NOT NULL</Tag>}
        {edited && (
          <span
            role="img"
            aria-label="Edited"
            className="size-1.5 shrink-0 self-center rounded-full bg-yellow-500"
          />
        )}
        <span className="ml-auto flex shrink-0 gap-0.5">
          {foreignKey && (
            <Button
              size="xs"
              variant="ghost"
              className="h-5 gap-0.5 px-1.5"
              disabled={!foreignKey.canFollow}
              title={`Open ${foreignKey.group.table}`}
              onClick={foreignKey.onFollow}
            >
              {foreignKey.group.table}
              <ArrowRightIcon className="size-3" />
            </Button>
          )}
          {foreignKey && editable && (
            <Button
              size="xs"
              variant={picking ? "secondary" : "ghost"}
              className="h-5 px-1.5"
              aria-expanded={picking}
              onClick={() => setPicking((open) => !open)}
            >
              Pick
            </Button>
          )}
          {edited && editable && (
            <Button size="xs" variant="ghost" className="h-5 px-1.5" onClick={onRevert}>
              Revert
            </Button>
          )}
          {editable && column.nullable && value.kind !== "null" && (
            <Button
              size="xs"
              variant="ghost"
              className="h-5 px-1.5"
              onClick={() => onChange({ kind: "null" })}
            >
              NULL
            </Button>
          )}
          {editable && value.kind !== "default" && (
            <Button
              size="xs"
              variant="ghost"
              className="h-5 px-1.5"
              onClick={() => onChange({ kind: "default" })}
            >
              DEFAULT
            </Button>
          )}
        </span>
      </div>

      {foreignKey && editable && picking && (
        <FkPicker
          connectionId={props.connectionId}
          group={foreignKey.group}
          onPick={(values) => {
            foreignKey.onPick(values);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {kind === "json" ? (
        <JsonField {...props} />
      ) : kind === "bool" ? (
        <BoolField value={value} editable={editable} onChange={onChange} />
      ) : kind === "userType" ? (
        <EnumOrText {...props} />
      ) : (
        <TextField
          column={column}
          value={value}
          editable={editable}
          onChange={onChange}
          multiline={kind === "text"}
          hint={isBytea ? (v) => byteSize(v) : undefined}
          validateText={
            isBytea
              ? (t) => (HEX.test(t) ? null : "A bytea value is \\x followed by hex digits.")
              : undefined
          }
          mono={isBytea || kind !== "text"}
        />
      )}
    </div>
  );
}

function Tag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

/** What to show in a box that has no text of its own. */
const placeholderFor = (value: CellValue) =>
  value.kind === "null" ? "NULL" : value.kind === "default" ? "DEFAULT" : "";

interface TextFieldProps {
  column: ColumnInfo;
  value: CellValue;
  editable: boolean;
  onChange: (value: CellValue) => void;
  multiline: boolean;
  mono: boolean;
  hint?: ((text: string) => string) | undefined;
  validateText?: ((text: string) => string | null) | undefined;
}

/**
 * Numbers, dates, UUIDs, text, bytea: a text box. The change is staged when the box loses focus
 * (or Enter, ⌘↵ in a tall box) and the text is valid; Esc puts the old text back.
 */
function TextField({
  column,
  value,
  editable,
  onChange,
  multiline,
  mono,
  hint,
  validateText,
}: TextFieldProps) {
  const kind = editorKindOf(column);
  const current = value.kind === "value" ? value.text : "";
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = draft ?? current;

  const commit = () => {
    if (draft === null) return;
    if (draft === current) {
      setDraft(null);
      setError(null);
      return;
    }
    const problem = validateText?.(draft) ?? validate(kind, column.typeOid, draft);
    if (problem) return setError(problem);
    onChange({ kind: "value", text: normalize(kind, draft) });
    setDraft(null);
    setError(null);
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
  };

  const shared = {
    value: text,
    readOnly: !editable,
    placeholder: placeholderFor(value),
    spellCheck: false,
    "aria-label": column.name,
    "aria-invalid": error !== null,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    className: cn(
      "text-xs placeholder:italic",
      (mono || kind !== "text") && "font-mono",
      !editable && "bg-muted/30",
    ),
  };

  return (
    <>
      {multiline ? (
        <Textarea
          {...shared}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          className={cn(shared.className, "max-h-64 min-h-8 overflow-y-auto py-1.5")}
        />
      ) : (
        <Input
          {...shared}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
            else if (e.key === "Enter") commit();
          }}
          className={cn(shared.className, "h-7")}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!error && value.kind === "value" && (hint || text.length > 200) && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {hint ? hint(text) : `${text.length.toLocaleString("en-US")} characters`}
        </p>
      )}
    </>
  );
}

function BoolField({
  value,
  editable,
  onChange,
}: {
  value: CellValue;
  editable: boolean;
  onChange: (value: CellValue) => void;
}) {
  const shown = value.kind === "value" ? value.text : "";
  return (
    <Select
      value={shown}
      disabled={!editable}
      onValueChange={(v) => onChange({ kind: "value", text: v })}
    >
      <SelectTrigger size="sm" className="w-full font-mono text-xs">
        <SelectValue placeholder={placeholderFor(value)} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="true">true</SelectItem>
        <SelectItem value="false">false</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** A user-made type is an enum when the catalog has labels for it, else plain text. */
function EnumOrText(props: DetailFieldProps) {
  const { connectionId, column, value, editable, onChange } = props;
  const labels = useQuery({
    queryKey: ["schema", connectionId, "enum", column.typeOid],
    queryFn: () => commands.listEnumValues(connectionId, column.typeOid),
    staleTime: 60_000,
  });
  if (!labels.data || labels.data.length === 0) {
    return (
      <TextField
        column={column}
        value={value}
        editable={editable}
        onChange={onChange}
        multiline={false}
        mono={false}
      />
    );
  }
  return (
    <Select
      value={value.kind === "value" ? value.text : ""}
      disabled={!editable}
      onValueChange={(v) => onChange({ kind: "value", text: v })}
    >
      <SelectTrigger size="sm" className="w-full text-xs">
        <SelectValue placeholder={placeholderFor(value)} />
      </SelectTrigger>
      <SelectContent>
        {labels.data.map((label) => (
          <SelectItem key={label} value={label}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function JsonField({ value, editable, onChange }: DetailFieldProps) {
  if (value.kind !== "value") {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground italic">
          {placeholderFor(value)}
        </span>
        {editable && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onChange({ kind: "value", text: "{}" })}
          >
            Set to {"{}"}
          </Button>
        )}
      </div>
    );
  }
  return (
    <JsonEditor
      value={value.text}
      readOnly={!editable}
      onChange={(text) => onChange({ kind: "value", text })}
    />
  );
}
