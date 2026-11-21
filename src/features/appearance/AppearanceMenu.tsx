import { PaletteIcon } from "lucide-react";

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
import {
  APPEARANCE_MODES,
  DENSITIES,
  EDITOR_THEMES,
  GRID_FONT_SIZES,
  type AppearanceMode,
  type Density,
  type EditorTheme,
  type GridFont,
} from "@/features/appearance/prefs";
import { useAppearance } from "@/stores/appearance";

const MODE_LABELS: Record<AppearanceMode, string> = {
  system: "Match macOS",
  light: "Light",
  dark: "Dark",
};
const DENSITY_LABELS: Record<Density, string> = {
  compact: "Compact",
  normal: "Normal",
  comfortable: "Comfortable",
};
const GRID_FONT_LABELS: Record<GridFont, string> = { system: "System", mono: "Monospace" };

/** Light or dark, grid density and font, the colors of SQL, the translucent sidebar. */
export function AppearanceMenu() {
  const prefs = useAppearance();
  const keepOpen = (e: Event) => e.preventDefault();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Appearance">
              <PaletteIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Appearance</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={prefs.mode}
          onValueChange={(mode) => prefs.set({ mode: mode as AppearanceMode })}
        >
          {APPEARANCE_MODES.map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode} onSelect={keepOpen}>
              {MODE_LABELS[mode]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Grid density ({DENSITY_LABELS[prefs.density]})
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={prefs.density}
              onValueChange={(density) => prefs.set({ density: density as Density })}
            >
              {DENSITIES.map((density) => (
                <DropdownMenuRadioItem key={density} value={density}>
                  {DENSITY_LABELS[density]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Grid font ({GRID_FONT_LABELS[prefs.gridFont]})
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={prefs.gridFont}
              onValueChange={(gridFont) => prefs.set({ gridFont: gridFont as GridFont })}
            >
              {(Object.keys(GRID_FONT_LABELS) as GridFont[]).map((id) => (
                <DropdownMenuRadioItem key={id} value={id}>
                  {GRID_FONT_LABELS[id]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Grid font size ({prefs.gridFontSize})</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={String(prefs.gridFontSize)}
              onValueChange={(size) => prefs.set({ gridFontSize: Number(size) })}
            >
              {GRID_FONT_SIZES.map((size) => (
                <DropdownMenuRadioItem key={size} value={String(size)}>
                  {size} px
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            SQL colors ({EDITOR_THEMES[prefs.editorTheme]})
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={prefs.editorTheme}
              onValueChange={(editorTheme) =>
                prefs.set({ editorTheme: editorTheme as EditorTheme })
              }
            >
              {(Object.keys(EDITOR_THEMES) as EditorTheme[]).map((id) => (
                <DropdownMenuRadioItem key={id} value={id}>
                  {EDITOR_THEMES[id]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={prefs.translucentSidebar}
          onCheckedChange={(translucentSidebar) => prefs.set({ translucentSidebar })}
          onSelect={keepOpen}
        >
          Translucent sidebar
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
