import { Settings2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { KeywordCase } from "@/features/query/format";
import { FONT_CHOICES, FONT_SIZES, TAB_SIZES, type FontChoice } from "@/features/query/prefs";
import { useEditorPrefs } from "@/stores/editorPrefs";

const KEYWORD_LABELS: Record<KeywordCase, string> = {
  upper: "UPPER CASE",
  lower: "lower case",
  preserve: "As typed",
};

/** Font, size, tabs, line numbers, wrapping, vim keys and keyword case for every SQL editor. */
export function EditorSettingsMenu() {
  const prefs = useEditorPrefs();
  const keepOpen = (e: Event) => e.preventDefault();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label="Editor settings">
              <Settings2Icon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Editor settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Editor</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={prefs.lineNumbers}
          onCheckedChange={(lineNumbers) => prefs.set({ lineNumbers })}
          onSelect={keepOpen}
        >
          Line numbers
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.wordWrap}
          onCheckedChange={(wordWrap) => prefs.set({ wordWrap })}
          onSelect={keepOpen}
        >
          Word wrap
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.vim}
          onCheckedChange={(vim) => prefs.set({ vim })}
          onSelect={keepOpen}
        >
          Vim keys
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Font</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={prefs.fontFamily}
              onValueChange={(value) => prefs.set({ fontFamily: value as FontChoice })}
            >
              {(Object.keys(FONT_CHOICES) as FontChoice[]).map((id) => (
                <DropdownMenuRadioItem key={id} value={id}>
                  <span style={{ fontFamily: FONT_CHOICES[id].css }}>{FONT_CHOICES[id].label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Font size ({prefs.fontSize})</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={String(prefs.fontSize)}
              onValueChange={(value) => prefs.set({ fontSize: Number(value) })}
            >
              {FONT_SIZES.map((size) => (
                <DropdownMenuRadioItem key={size} value={String(size)}>
                  {size} px
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Tab size ({prefs.tabSize})</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={String(prefs.tabSize)}
              onValueChange={(value) => prefs.set({ tabSize: Number(value) })}
            >
              {TAB_SIZES.map((size) => (
                <DropdownMenuRadioItem key={size} value={String(size)}>
                  {size} spaces
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Keywords when formatting</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={prefs.keywordCase}
              onValueChange={(value) => prefs.set({ keywordCase: value as KeywordCase })}
            >
              {(Object.keys(KEYWORD_LABELS) as KeywordCase[]).map((id) => (
                <DropdownMenuRadioItem key={id} value={id}>
                  {KEYWORD_LABELS[id]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
