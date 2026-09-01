# Handoff: Predit — IDE Style Redesign

## Overview
Visual redesign of Predit's clip-editing panel (crop/reframe, speed, LUTs, export) in a minimalist "coder IDE" aesthetic: monospace typography, dark editor-style background, subtle syntax-highlight-style accent coloring. No neon, no heavy decoration.

## About the Design Files
The bundled HTML file is a **design reference created in HTML** — it shows intended look and structure, not production code to copy directly. The task is to recreate this design in Predit's existing codebase/framework, using its established components, state management, and libraries. If no frontend framework exists yet for this panel, choose the most appropriate one for the project.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and layout below are final; implement pixel-close.

## Screens / Views

### Clip Editor Panel
**Purpose:** Edit a single video clip — reframe, trim in/out, set speed, apply LUTs, choose output format, export.

**Layout:** Single column, fixed width 380px (scales as a sidebar/panel, not full-bleed). Vertical stack, no dividers except thin 1px borders between the header and the rest. Padding 14–18px horizontal throughout, 8–16px vertical gaps between sections.

**Components (top to bottom):**
1. **Header row** — flex row, `justify-content: space-between`, `align-items: baseline`. Padding `14px 18px`, bottom border `1px solid #2c2c30`.
   - "Predit" — 13px, weight 700, color `#f0f0f2`
   - "clasico_4:3" (current aspect preset, lowercase) — 11px, color `#7a8ba0`
2. **Preview frame** — height 170px, border-radius 6px, diagonal striped placeholder background (`repeating-linear-gradient(45deg, #26262a 0 10px, #222226 10px 20px)`) standing in for the actual video/image thumbnail. Overlaid hint text bottom-center: `/* arrastra la imagen para reencuadrar */` (comment-style, 10px, `#8a8a90`).
3. **Primary action row** — flex row, gap 8px.
   - "reproducir()" button — flex:1, background `#5c8bb0`, text color `#1e1e20`, 12px weight 600, border-radius 5px, centered, padding `9px 0`
   - "lut: none" — flex:1, outline button, 1px border `#33333a`, radius 5px, text `#8a8a90`, same padding
4. **Clip strip** — flex row, gap 8px.
   - Active clip chip — flex:1, background `#242428`, 1px border `#33333a`, radius 5px, padding `6px 10px`. Two lines: index "01" in `#c98a5c` (10px), then filename + duration e.g. "CierreAPD_02 · 2:09" in `#c9c9cc` (10px)
   - "+ clip" add slot — dashed border `#33333a`, radius 5px, text `#8a8a90`, centered
5. **In/out readout** — flex row, `justify-content: space-between`, 10px text, top border `1px solid #2c2c30`, padding-top 10px.
   - "entrada 0:00.0" (label `#8a8a90`, value `#c9c9cc`)
   - "queda 129.2s" — centered, accent color `#5c8bb0`
   - "salida 2:09.2" (same styling as entrada)
6. **Trim scrubber** — track height 6px, background `#2c2c30`, radius 3px. Filled range (in→out) `#3a4a58`. Playhead: 2px wide vertical bar, `#5c8bb0`, extends 3px above/below the track.
7. **Speed section** — label "// velocidad" (comment style, 10px, `#7a8ba0`), then a row of pill/rect buttons, gap 6px: "25p" (selected — border+text `#5c8bb0`), "1x", "2x" (unselected — border `#33333a`, text `#8a8a90`). All 10px, radius 5px, padding `5px 8px`.
8. **Frame/crop mode row** — two equal-width outline buttons "llenar" and "bandas" (fill vs. letterbox), border `#33333a`, radius 5px, text `#8a8a90`, 11px, padding `8px 0`.
9. **Export button** — full width, background `#5c8bb0`, text `#1e1e20`, 12px weight 600, radius 5px, padding `10px 0`, label "exportar mp4 →".

**Typography:** JetBrains Mono throughout (400/500/700 weights). No secondary font.

**Hover/active/focus states:** Not specified in this pass — recommend a subtle lightness bump (~8–10%) on button backgrounds/borders on hover, and a visible focus ring (`outline: 2px solid #5c8bb0`, offset 2px) for keyboard accessibility, consistent with the accent color.

## Interactions & Behavior
This mock is static; behavior should follow Predit's existing panel (visible in the original screenshot supplied by the user), specifically:
- "reproducir()" toggles play/pause of the preview
- Clip chip: click to select/edit; the app supports multiple clips via "+ clip"
- In/out scrubber: draggable handles for trim in/out points, plus a draggable playhead
- Speed buttons and fill/letterbox buttons: single-select toggle groups
- LUT selectors and export-format selectors (present in the full original panel, not re-illustrated above — see note below) follow the same button-group pattern
- Export button triggers the export flow with format + clip count + duration in its label (e.g. "exportar mp4 · 1 clip · 129.2s")

Note: this mock covers the panel's primary controls area. The original app also includes LUT pickers, a music/audio section, and output-format selection (vertical/horizontal/4K) below the section shown — apply the same visual system (monospace, `#33333a` borders, `#5c8bb0` accent, radius 5px) to those sections when implementing.

## State Management
- Selected clip / clip list
- Trim in/out points (seconds)
- Playback state (playing/paused, current time)
- Selected speed preset
- Selected crop mode (fill vs. letterbox)
- Selected LUTs (conversion + look), selected output format
- Export status/progress

## Design Tokens

**Colors**
- Background (panel): `#1e1e20`
- Background (page/behind panel): `#141416`
- Preview placeholder stripes: `#26262a` / `#222226`
- Borders (default): `#33333a`
- Borders (subtle divider): `#2c2c30`
- Text primary: `#f0f0f2`
- Text secondary: `#c9c9cc`
- Text muted/label: `#8a8a90`
- Text comment-style: `#7a8ba0`
- Accent (primary actions, selected state, playhead): `#5c8bb0`
- Accent (clip index, secondary highlight): `#c98a5c`
- Clip chip background: `#242428`
- Scrubber track: `#2c2c30`; filled range: `#3a4a58`

**Typography**
- Font: JetBrains Mono (400, 500, 700)
- Sizes used: 10px (labels/meta), 11px (secondary buttons/copy), 12px (primary buttons/section headers), 13px (title)

**Spacing**
- Panel padding: 14–18px horizontal
- Vertical rhythm between sections: 8–16px
- Button padding: `5px 8px` (small pills) to `10px 0` (full-width buttons)

**Border radius:** 5–6px everywhere (buttons, chips, preview frame, scrubber track). Panel container: 8px.

**Shadows:** none in this style — flat surfaces, borders only for separation.

## Assets
No real imagery used. The video/image preview is a CSS diagonal-stripe placeholder standing in for the actual thumbnail — replace with the real frame/thumbnail renderer.

## Files
- `predit-ide-style.html` — the design reference (single self-contained HTML file, inline styles)
- `screenshot.png` — rendered screenshot of the design reference
