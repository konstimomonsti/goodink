# Recon map: Goodnotes 6 (iPadOS) → native Windows desktop clone

Scope: the full handwritten-notes product as a single-user, offline-first Windows app: library,
notebooks with paper templates, the ink engine (pens, highlighter, eraser, lasso, shapes, text,
images, stickers/elements, tape, laser), page management, PDF import/annotate/export, search,
audio recording, presentation, tabs, settings. Cloud sync, collaboration, marketplace and the
proprietary AI are recorded and marked `skip`/`could` with reasons.
For: the user's own product (working name "goodink" — replica-brand will rename it), sold to
Windows pen-tablet / Surface users who have no first-class Goodnotes-style app.
Platform of the clone: Windows 10/11 x64, installed via an `.exe` (NSIS), runs offline.
Date: 2026-10-06

Method: public sources only (marketing site, support centre, App Store listing, public
walkthrough videos). No account was logged into, no binaries/bundles/network calls inspected.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | support centre | https://support.goodnotes.com/hc/en-us | the most complete list of tools, settings and page operations |
| 2 | marketing site | https://www.goodnotes.com/ | positioning: "digital paper", handwriting, PDF annotation, study tools |
| 3 | pricing | https://www.goodnotes.com/pricing | free tier capped at 3 notebooks; paid unlocks unlimited notebooks + AI + handwriting recognition |
| 4 | App Store listing | https://apps.apple.com/app/goodnotes-6/id1444383602 | screenshots of library, editor toolbar, templates, flashcards, AI |
| 5 | Windows/web version page | https://www.goodnotes.com/windows | official Windows build exists (web-tech); reviewers call it slower than iPad — our gap |
| 6 | changelog / "what's new" | https://www.goodnotes.com/blog | GN6 additions: tape tool, word complete, math assist, flashcards, page templates refresh |
| 7 | public walkthrough videos | YouTube "Goodnotes 6 tutorial" | click-by-click flows for lasso, page navigator, templates, export |

## Core loop

Open a notebook on realistic paper and write with a pen that feels instant, then find, organise
and export what you wrote.

## Screens

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Library – Documents | app launch | grid/list of notebooks & folders, create, sort | sidebar, top bar, grid, cover thumbnails, + New button, sort menu, view toggle | empty (first run), filled, long names, multi-select, drag-to-folder |
| S02 | Folder view | click a folder | nested folder contents | breadcrumbs, grid | empty, filled |
| S03 | Favourites | sidebar | starred notebooks | grid | empty, filled |
| S04 | Recents | sidebar | recently opened | grid sorted by opened_at | empty, filled |
| S05 | Trash | sidebar / settings | deleted items, restore, delete forever | grid, restore/delete actions | empty, filled |
| S06 | Global search | library search field | search titles + typed text + PDF text across all notebooks | search field, result list with page snippets | idle, no results, results |
| S07 | New notebook sheet | + New → Notebook | title, cover, paper template, colour, size, orientation | modal, cover picker, template picker, size select | default, validation |
| S08 | Template gallery | inside S07 / page "change template" | pick paper: blank, ruled (narrow/college/wide), grid, dotted, Cornell, music, planner pages | thumbnail grid, colour toggle (white/yellow/dark) | default, selected |
| S09 | Import | + New → Import / drag-drop | import PDF / images into new notebook | file dialog, progress | progress, error (corrupt PDF) |
| S10 | Editor (notebook) | open a notebook | write and annotate | tab bar, top toolbar, tool sub-bar (colour/size presets), canvas, page indicator | loading, blank page, PDF page, zoomed, horizontal/vertical scroll |
| S11 | Page navigator (thumbnails) | editor → thumbnails button | see all pages, reorder, add, duplicate, delete, bookmark | sidebar thumbnails, context menu, drag reorder | 1 page, many pages, multi-select |
| S12 | Outline / bookmarks | editor → navigator tabs | jump to bookmarked pages, PDF outline, custom outline | list | empty, filled |
| S13 | Search in document | editor → magnifier | find text in notebook | search field, hit list | no hits, hits |
| S14 | Pen settings popover | tap active pen | pen type (fountain/ball/brush), pressure, colour palette, thickness presets | segmented control, swatches, slider | default |
| S15 | Colour picker | tap a swatch | custom colour, hex | spectrum, hex field, presets | default |
| S16 | Lasso action menu | lasso a selection | cut/copy/delete/duplicate/recolour/resize/screenshot/convert | floating menu, selection box with handles | strokes only, mixed, images |
| S17 | Elements / stickers panel | toolbar → elements | insert vector stickers and saved elements, save selection as element | panel, collections | empty collection, filled |
| S18 | Text box editing | text tool tap | typed text with font, size, colour, align | text frame, format bar | editing, idle |
| S19 | Image insert / crop | toolbar → image | place, move, resize, rotate images | file picker, image handles | default |
| S20 | Audio recording | toolbar → mic | record lecture while writing; playback | record bar, timer, playback list | recording, paused, playback |
| S21 | Export / share sheet | editor or library → export | PDF (with/without annotations, page range), PNG, native file, print | modal, options | default, progress, done |
| S22 | Presentation mode | editor → present | full-screen clean view on 2nd display, laser pointer | fullscreen page, laser trail | single display, external display |
| S23 | Settings | library gear | stylus/palm, scroll direction, pen defaults, auto-backup, theme, shortcuts | form groups, toggles | default |
| S24 | Document info / rename | notebook ⋯ menu | rename, change cover, move, duplicate, favourite, lock | menu, rename field | default |
| S25 | Flashcards (study) | flashcard notebook → study | spaced study of front/back cards | card view, reveal, rate buttons | no cards, studying, done |
| S26 | Onboarding | first run | welcome, create first notebook | 2–3 cards | first run only |

## Flows

```
F01 Create a notebook and write (core loop)
    S01 -> S07 (+S08) -> S10
    happy path clicks: 3 (New, Notebook, Create) then writing starts
    edge: zero notebooks; title empty; 500-page notebook; very fast strokes; pen hover/eraser button

F02 Annotate a PDF
    S01 -> S09 -> S10 (highlighter, pen, text) -> S21
    happy path clicks: 3 to import, 2 to export
    edge: 300-page PDF, password-protected PDF, rotated pages, mixed page sizes

F03 Organise
    S01 -> create folder -> drag notebook into it -> S02; favourite -> S03; delete -> S05 -> restore
    edge: nested folders, rename collision, delete folder with contents

F04 Edit with lasso
    S10 lasso -> S16 move / resize / recolour / copy -> paste on another page
    edge: selection across PDF + ink, undo after move, selection containing images/text

F05 Manage pages
    S10 -> S11 add / duplicate / reorder / delete / change template / bookmark
    edge: delete last page (not allowed), reorder with keyboard

F06 Find something
    S06 type query -> click hit -> S10 at the page, hit highlighted
    edge: no results; text in PDF vs typed text; handwriting (needs OCR)

F07 Record a lecture while writing
    S10 -> S20 record -> write -> stop -> playback

F08 Present
    S10 -> S22 -> laser pointer -> exit (Esc)

F09 Study flashcards
    S01 -> new flashcard deck -> add cards -> S25 study
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Button | primary, secondary, ghost, danger, icon | default, hover, active, focus, disabled | all |
| Tool button (toolbar) | tool, toggle | idle, active, active+popover open, disabled | S10 |
| Swatch | colour, add | idle, selected, hover | S10, S14, S15 |
| Size preset dot | 3 sizes | idle, selected | S10, S14 |
| Popover | anchored | open/closed | S14, S15, S10 |
| Modal / sheet | small, large | open, closing | S07, S21, S23 |
| Context menu | list | hover, disabled, danger item | S01, S11, S16 |
| Notebook card | notebook, folder, PDF | idle, hover, selected, renaming, favourite | S01–S05 |
| Page thumbnail | page | idle, current, selected, bookmarked, dragging | S11 |
| Tab (document tab) | — | active, inactive, hover, close | S10 |
| Sidebar nav item | — | idle, active, count badge | S01–S06 |
| Text field / search field | — | idle, focus, error | S06, S07, S13, S24 |
| Segmented control | 2–4 options | selected | S07, S14, S23 |
| Toggle switch | — | on, off, disabled | S23 |
| Slider | — | idle, dragging | S14 |
| Toast | info, success, error, undo | enter, leave | all |
| Selection box | lasso, image, text | handles, rotating | S10, S16, S19 |
| Empty state | library, search, trash | — | S01–S06 |

## Inferred data model

```
Folder     id, parent_id, title, created_at, updated_at, deleted_at
           evidence: S01/S02 nested folders, S05 trash      confidence: high

Notebook   id, folder_id, title, cover (preset id | colour), kind (notebook | pdf | flashcards),
           favourite, locked, page_ids[], opened_at, created_at, updated_at, deleted_at
           evidence: S01 cards, S07 sheet, S24 menu         confidence: high

Page       id, notebook_id, index, width, height (pt), template (id + colour + line spacing),
           background (none | pdf asset + page no | image), rotation, bookmarked,
           layers: strokes[], objects[] (text, image, shape, sticker, tape)
           evidence: S10, S11, S08                          confidence: high

Stroke     id, tool (fountain|ball|brush|highlighter), colour, width, points[(x,y,pressure,t)],
           bbox                                             evidence: S10, S14, S16  confidence: high
           (exact storage format is unknown — ours is our own design)

Asset      id, notebook_id, kind (pdf | image | audio), sha256, path, bytes
           evidence: S09, S19, S20                          confidence: medium

Recording  id, notebook_id, asset_id, duration, started_at, page anchors[]
           evidence: S20                                    confidence: medium

Element    id, collection, svg/stroke payload               evidence: S17   confidence: medium

Flashcard  id, notebook_id, front_page_region, back_page_region, ease, due_at
           evidence: S25, help "flashcards"                 confidence: guess

Settings   key/value per user                               evidence: S23   confidence: high
```

Relationships: Folder 1-n Folder, Folder 1-n Notebook, Notebook 1-n Page, Page 1-n Stroke/Object,
Notebook 1-n Asset, Notebook 1-n Recording.

## Feature matrix

See `features.csv`. Must: 52, should: 26, could: 11, skip: 7.

## Out of scope (cannot or should not be cloned)

- iCloud / Goodnotes cloud sync and real-time collaboration — needs a hosted service and accounts; the clone is offline-first (local folder can be put in OneDrive).
- Goodnotes Marketplace (third-party paid templates/stickers) — a partner network, not a feature.
- Goodnotes AI (summaries, "Ask Goodnotes") — proprietary models; a later version could add Claude via the user's own API key.
- Their cover art, paper template artwork, stickers, icons, fonts and copy — we draw our own.
- The `.goodnotes` file format — proprietary; we use our own open format and export to PDF.
- Apple Pencil-specific gestures (double-tap, squeeze) — map to Windows pen barrel button / eraser end instead.

## Size

Screens 26, flows 9, entities 9. Hard parts: (1) the ink engine — sub-frame latency, pressure,
smoothing, rendering thousands of strokes at any zoom; (2) PDF import/render/export with
annotations flattened at vector quality; (3) handwriting recognition for search (needs an OCR
engine — Windows has one built in, `Windows.Media.Ocr`). Size: **XL** for full parity. Rescoped to
an L: everything `must`/`should` in one desktop build, with `could` items as stretch.
