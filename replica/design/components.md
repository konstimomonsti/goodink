# goodink components

All values come from `tokens.json` / `tokens.dark.json` through CSS custom properties in
`src/renderer/styles/tokens.css` (`var(--c-accent)`, `var(--r-md)` …). Icons: lucide (ISC).
Cover art, paper templates and stickers are drawn in code by us. No original assets.

```
Button
  variants  primary, secondary, ghost, danger, icon
  sizes     sm 28px, md 32px, lg 40px
  states    default, hover (surface-2), active (scale .98), focus-visible (2px ring focus, 2px offset), disabled (.45 opacity)
  tokens    primary: bg accent / text on-accent; radius md; font base/600
  a11y      real <button>, aria-label on icon-only buttons, title tooltip with shortcut
  used on   all

ToolButton (editor toolbar)
  variants  tool (exclusive), toggle, action
  size      36px square, icon 20px
  states    idle, hover, active (accent-soft bg + accent icon), active-with-popover (second click opens settings), disabled
  a11y      role=radio inside role=radiogroup for tools; keyboard shortcut in title
  used on   S10

Swatch
  size      22px circle, 2px ring when selected (text colour), white inner gap
  states    idle, hover (scale 1.1), selected, drag-over (edit)
  a11y      button with aria-label "Colour #RRGGBB", aria-pressed
  used on   S10 subbar, S14, S15

SizeDot
  three dots showing the actual stroke width, selected = accent-soft bg
  used on   S10 subbar, S14

Popover
  anchored under trigger, radius lg, shadow pop, 12px padding, closes on Esc / outside click
  used on   S14, S15, S16 menus, sort menu

Modal (sheet)
  sizes     sm 420px, md 640px, lg 860px; centred; scrim rgba(0,0,0,.35); enters with 180ms scale .98→1
  focus     trapped; Esc closes; first field autofocused; Enter submits primary
  used on   S07, S21, S23, S24

ContextMenu
  items 32px tall, icon + label + shortcut; danger items in danger colour; separators
  opens at pointer, keyboard: arrows, Enter, Esc
  used on   S01, S11, S16

NotebookCard
  cover 3:4 (portrait) or 4:3 (landscape) with radius md, shadow card, spine shading on notebooks
  title (sm/600, 2 lines max, ellipsis), meta (xs, muted: date · pages)
  states    idle, hover (lift 2px), selected (2px accent outline), renaming (inline field), favourite (star badge), drop-target (accent outline for folders)
  used on   S01–S05

FolderCard   same grid slot, folder glyph drawn in code tinted with folder colour, item count

PageThumb
  width 150px, page ratio, number below, bookmark ribbon top-right
  states    idle, current (accent outline), selected, dragging (.5 opacity), drop indicator (2px accent bar)
  used on   S11

DocTab
  height 36px, max 220px, title ellipsis, close × on hover/active
  states    active (surface), inactive (bg), hover
  used on   S10

SidebarItem
  32px, icon + label + count; active = accent-soft bg, accent text
  used on   S01–S06

TextField / SearchField
  32px, radius md, border border-input, focus ring focus; search has leading icon + clear button
  states    idle, focus, error (danger border + message), disabled

Segmented    pill track surface-2, selected thumb surface + shadow card
Toggle       36×20 track, accent when on
Slider       4px track, 16px thumb, accent fill
Toast        bottom-centre, surface, shadow pop, optional action ("Undo"), auto-dismiss 4s, role=status

SelectionBox (canvas overlay, not DOM chrome)
  dashed accent outline, 8 resize handles (10px squares), rotate handle 24px above top centre
  lasso path drawn as animated dashed line while drawing

EmptyState   centred illustration drawn in code, title lg, body muted, one primary action
```

States everywhere: empty, loading (skeleton covers in the library, spinner only in export
progress), error (toast + inline), long content (60-char titles ellipsize, full title in tooltip),
narrow window (sidebar collapses under 900px, toolbar groups overflow into a "more" menu).
