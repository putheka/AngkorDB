# AngkorDB

## Git commits

- Auto-commit: after finishing each task (code compiles, checks pass), commit right away. Don't ask first.
- Message: one short line only, imperative mood (e.g. `Add connection manager form`).
- No body, no bullet list, no details.
- No `Co-Authored-By` line and no mention of Claude, AI or any model name.
- Never push unless asked.

## shadcn/ui

- Add components with `npx shadcn@latest add <name>`.
- After adding, replace `import { cn } from "cn"` with `import { cn } from "@/lib/utils"` (we use clsx + tailwind-merge, not the `cn` package).
- Use theme tokens (`bg-background`, `text-muted-foreground`, `border`, `bg-sidebar`), never hardcoded `neutral-*` colors.
