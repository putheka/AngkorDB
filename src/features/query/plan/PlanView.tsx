import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ExplainRun } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  formatMs,
  formatShare,
  parsePlan,
  planToText,
  PlanError,
  type Heat,
  type ParsedPlan,
  type PlanNode,
} from "@/features/query/plan/plan";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

type Mode = "tree" | "text" | "json";

/** What a plan can't be shown as: the server's error, or text that isn't a plan. */
function Problem({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div role="alert" className="min-h-0 flex-1 overflow-auto p-4 text-sm select-text">
      <p className="font-medium text-destructive">{title}</p>
      {children}
    </div>
  );
}

interface PlanViewProps {
  run: ExplainRun;
  /** Put the editor cursor on the error. */
  onGoToError: () => void;
}

/** The plan of a statement: a tree with the hottest node in red, or the text or JSON of it. */
export function PlanView({ run, onGoToError }: PlanViewProps) {
  const { outcome } = run;
  const parsed = useMemo(() => {
    if (outcome.kind !== "plan") return null;
    try {
      return { ok: true as const, plan: parsePlan(outcome.json) };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof PlanError ? error.message : "Could not read the plan.",
      };
    }
  }, [outcome]);

  if (outcome.kind === "error") {
    return (
      <Problem title={outcome.error.message}>
        <div className="mt-1 text-xs text-muted-foreground">
          {outcome.error.pgCode && (
            <p>
              SQLSTATE <span className="font-mono">{outcome.error.pgCode}</span>
            </p>
          )}
          {outcome.error.detail && <p>{outcome.error.detail}</p>}
          {outcome.error.hint && <p>Hint: {outcome.error.hint}</p>}
          {outcome.offset !== null && (
            <Button variant="outline" size="xs" className="mt-1.5" onClick={onGoToError}>
              Go to error
            </Button>
          )}
        </div>
      </Problem>
    );
  }
  if (!parsed?.ok) return <Problem title={parsed ? parsed.message : "No plan."} />;
  return <LoadedPlan run={run} plan={parsed.plan} json={outcome.json} />;
}

function LoadedPlan({ run, plan, json }: { run: ExplainRun; plan: ParsedPlan; json: string }) {
  const [mode, setMode] = useState<Mode>("tree");
  const [open, setOpen] = useState<ReadonlySet<number>>(
    () => new Set(plan.hottest ? [plan.hottest.id] : []),
  );
  const text = useMemo(() => planToText(plan), [plan]);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }, [json]);

  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const showHottest = () => {
    const hottest = plan.hottest;
    if (!hottest) return;
    setMode("tree");
    setOpen((current) => new Set(current).add(hottest.id));
    requestAnimationFrame(() =>
      document.getElementById(`plan-node-${hottest.id}`)?.scrollIntoView({ block: "center" }),
    );
  };

  const hottest = plan.hottest;
  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
        <span className="font-medium">{run.analyzed ? "EXPLAIN ANALYZE" : "EXPLAIN"}</span>
        {plan.planningMs !== null && (
          <span className="text-muted-foreground tabular-nums">
            planning {formatMs(plan.planningMs)}
          </span>
        )}
        {plan.executionMs !== null && (
          <span className="text-muted-foreground tabular-nums">
            execution {formatMs(plan.executionMs)}
          </span>
        )}
        {hottest && (
          <button
            type="button"
            onClick={showHottest}
            className="min-w-0 truncate rounded-md px-1.5 py-0.5 text-destructive hover:bg-destructive/10"
            title="Show this node"
          >
            {plan.basis === "time" ? "Slowest" : "Most expensive"}: {hottest.name}
            {hottest.target ? ` on ${hottest.target}` : ""} ({formatShare(hottest.share)})
          </button>
        )}
        <div role="tablist" aria-label="Plan format" className="ml-auto flex gap-1">
          {(["tree", "text", "json"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-md border px-2 py-0.5",
                mode === m
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "tree" ? "Tree" : m === "text" ? "Text" : "JSON"}
            </button>
          ))}
        </div>
      </div>

      {run.analyzed && run.statementKind !== "read" && (
        <p
          role="status"
          className="flex shrink-0 items-start gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-amber-700 dark:text-amber-300"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            EXPLAIN ANALYZE ran this {run.command} for real, inside a transaction that was rolled
            back, so nothing was saved. Sequence values it used are not given back, and anything a
            trigger or function did outside the database still happened.
          </span>
        </p>
      )}

      {mode === "tree" ? (
        <ul role="tree" aria-label="Plan" className="min-h-0 flex-1 overflow-auto py-1 select-text">
          {plan.nodes.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              plan={plan}
              open={open.has(node.id)}
              onToggle={() => toggle(node.id)}
            />
          ))}
        </ul>
      ) : (
        <RawPlan
          text={mode === "text" ? text : pretty}
          label={mode === "text" ? "Plan text" : "Plan JSON"}
        />
      )}
    </div>
  );
}

const HEAT_ROW: Record<Heat, string> = {
  hottest: "border-l-destructive bg-destructive/10",
  hot: "border-l-orange-500 bg-orange-500/10",
  warm: "border-l-amber-400 bg-amber-400/10",
  none: "border-l-transparent",
};
const HEAT_BAR: Record<Heat, string> = {
  hottest: "bg-destructive",
  hot: "bg-orange-500",
  warm: "bg-amber-400",
  none: "bg-muted-foreground/40",
};

function NodeRow({
  node,
  plan,
  open,
  onToggle,
}: {
  node: PlanNode;
  plan: ParsedPlan;
  open: boolean;
  onToggle: () => void;
}) {
  const expandable = node.details.length > 0;
  const analyzed = node.actual !== null;
  return (
    <li
      id={`plan-node-${node.id}`}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={false}
      aria-expanded={expandable ? open : undefined}
      className="list-none"
    >
      <div
        className={cn("mx-1 rounded-md border-l-[3px]", HEAT_ROW[node.heat])}
        style={{ marginLeft: 4 + node.depth * 20 }}
      >
        <button
          type="button"
          onClick={onToggle}
          disabled={!expandable}
          className="flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring enabled:hover:bg-accent/40"
        >
          <ChevronRightIcon
            className={cn(
              "mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
              !expandable && "opacity-0",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{node.name}</span>
            {node.relationship &&
              node.relationship !== "Outer" &&
              node.relationship !== "Inner" && (
                <span className="ml-1.5 text-muted-foreground">{node.relationship}</span>
              )}
            {node.target && <span className="ml-1.5 text-muted-foreground">on {node.target}</span>}
            {node.heat === "hottest" && (
              <span className="ml-2 rounded-full bg-destructive px-1.5 py-px text-[10px] font-medium text-white">
                {plan.basis === "time" ? "slowest" : "most expensive"}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-3 text-muted-foreground tabular-nums">
            {analyzed && node.actual ? (
              <span
                title={`${count.format(node.actual.rows)} rows per loop, estimated ${count.format(node.planRows)}`}
              >
                {count.format(node.actual.rows * node.actual.loops)} rows
                {node.actual.loops > 1 && <> · {node.actual.loops}×</>}
                <span className={cn(node.estimateOff !== null && "text-destructive")}>
                  {" "}
                  (est. {count.format(node.planRows * node.actual.loops)})
                </span>
              </span>
            ) : (
              <span title="Estimated rows">est. {count.format(node.planRows)} rows</span>
            )}
            <span
              className="flex w-48 items-center justify-end gap-2"
              title={
                analyzed && node.exclusiveMs !== null
                  ? `${formatMs(node.exclusiveMs)} in this node alone; ${formatMs(node.wallMs ?? 0)} with everything below it`
                  : `Cost ${count.format(node.exclusiveCost)} in this node alone; ${count.format(node.totalCost)} with everything below it`
              }
            >
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn("block h-full rounded-full", HEAT_BAR[node.heat])}
                  style={{ width: `${Math.max(node.share > 0 ? 4 : 0, node.share * 100)}%` }}
                />
              </span>
              <span className="w-32 text-right whitespace-nowrap">
                {analyzed && node.exclusiveMs !== null
                  ? `${formatMs(node.exclusiveMs)} · ${formatShare(node.share)}`
                  : `cost ${count.format(node.exclusiveCost)} · ${formatShare(node.share)}`}
              </span>
            </span>
          </span>
        </button>

        {node.warnings.map((warning) => (
          <p
            key={warning}
            className="flex items-start gap-1.5 px-2 pb-1.5 pl-[26px] text-amber-700 dark:text-amber-400"
          >
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
            {warning}
          </p>
        ))}

        {open && expandable && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 px-2 pb-2 pl-[26px] font-mono">
            {node.details.map((detail) => (
              <div key={detail.label} className="contents">
                <dt className="text-muted-foreground">{detail.label}</dt>
                <dd className="break-all">{detail.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

function RawPlan({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <div className="relative min-h-0 flex-1">
      <Button
        size="xs"
        variant="outline"
        className="absolute top-2 right-4 z-10 bg-background"
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
      </Button>
      <pre
        aria-label={label}
        tabIndex={0}
        className="h-full overflow-auto p-3 font-mono text-xs leading-relaxed select-text"
      >
        {text}
      </pre>
    </div>
  );
}
