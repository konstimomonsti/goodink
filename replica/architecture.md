# Architecture: goodink (a Windows rebuild of Goodnotes 6's core features)

The default web stack in this skill (Next.js, Postgres, Vercel) does not fit: the target is an
offline, single-user, pen-first **Windows desktop app shipped as an .exe**. The machine has Node 24,
no .NET SDK and no Rust toolchain, so the boring, documented choice is Electron.

## Stack

| layer | choice | why |
| --- | --- | --- |
| shell | **Tauri 2** (Rust backend + system WebView2), x64 — migrated from Electron 44 in v2.0.0 | 4.3 MB installer instead of 130 MB; same Chromium engine for canvas/ink/PDF (WebView2), so drawing behaves identically. Measured: startup and memory unchanged (memory is dominated by page canvases) |
| UI | React 19 + TypeScript, Vite | fast HMR, typed; React only for chrome (toolbars, library, dialogs) — never per-stroke |
| ink engine | plain TypeScript on Canvas 2D with `desynchronized` low-latency contexts, coalesced + predicted pointer events | the hot path stays out of React; per-page cached bitmaps; only dirty pages repaint |
| stroke geometry | `perfect-freehand` (MIT) for pressure-shaped outlines, our own smoothing + shape recognition | proven outline algorithm, tiny |
| PDF render | `pdfjs-dist` (Apache-2.0) in a worker | the standard PDF renderer; text layer for search |
| PDF export | `pdf-lib` (MIT) | writes ink as **vector paths** onto the original PDF pages; no rasterising |
| state | `zustand` (MIT) for UI state; engine owns document state | small, no boilerplate |
| icons | `lucide-react` (ISC) | open icon set, no original assets |
| storage | local document store under `%APPDATA%\goodink\library` (JSON + binary assets, atomic writes) | no server, opens instantly, user can point it to a OneDrive folder for sync |
| handwriting OCR | Windows built-in `Windows.Media.Ocr`, called directly from Rust (WinRT) | ships with Windows 10/11, no model download, offline, no PowerShell process per page |
| installer | Tauri bundler → NSIS `.exe` (per-user, Start menu shortcut, `.gink` file association, WebView2 bootstrapper if missing) | the requirement |
| auth / payments / email / jobs | none in v1 | local app; licensing is a replica-launch decision |

## Schema (document store, not SQL)

There is no database server. Tables become files; the same rules apply (ids, owner = local user,
timestamps, explicit delete behaviour). Full types in `replica/schema.ts`.

```
library/
  library.json                 { version, folders: Folder[], notebooks: NotebookMeta[] }   (index, small)
  notebooks/<notebookId>/
    notebook.json              { id, pages: PageMeta[], bookmarks, outline, recordings }
    pages/<pageId>.json        { strokes: Stroke[], objects: PageObject[] }   (lazy-loaded per page)
    assets/<sha256>.<ext>      PDFs, images, audio (content-addressed, deduplicated)
    thumb.png                  cover thumbnail (first page)
  elements.json                saved elements / stickers
  settings.json
```

- ids: `crypto.randomUUID()`. Timestamps: epoch ms UTC.
- Stroke points: `Float32Array` of `[x, y, pressure]` triples, page coordinates in PDF points
  (1/72 in), base64-encoded in JSON — ~4x smaller and ~10x faster to parse than number arrays.
- Delete rules: deleting a notebook sets `deletedAt` (Trash). Empty Trash removes the folder on
  disk. Deleting a folder moves its contents to Trash with it. Deleting the last page is refused.
- Writes are atomic (`write tmp → fsync → rename`), debounced 400 ms per page, flushed on window
  close. A crash loses at most the last 400 ms of ink.
- Access rules: single local user; the main process validates every path stays inside the
  library root (no `..`), and the renderer has `contextIsolation`, no `nodeIntegration`.

## API (IPC between the WebView and the Rust backend — `src-tauri/src/lib.rs`; bytes travel as raw IPC bodies)

| channel | does | input | output | flow |
| --- | --- | --- | --- | --- |
| `lib:load` | read library index | – | Library | F01, F03 |
| `lib:save` | write library index | Library | ok | F03 |
| `nb:load` | read notebook manifest | id | NotebookDoc | F01 |
| `nb:save` | write manifest | id, doc | ok | F05 |
| `page:load` / `page:save` | lazy page content | nbId, pageId, data | PageData | F01, F04 |
| `asset:put` | store PDF/image/audio | nbId, bytes, ext | assetId | F02, F07 |
| `asset:get` | read asset bytes | nbId, assetId | bytes | F02 |
| `nb:delete` | remove from disk (empty trash) | id | ok | F03 |
| `nb:thumb` | save cover thumbnail | id, png | ok | F01 |
| `dlg:open` / `dlg:save` | native file dialogs | filters | paths | F02, F21 |
| `file:read` / `file:write` | read picked file / write export | path, bytes | bytes | F02 |
| `ocr:image` | recognise handwriting in a PNG | png bytes | words with boxes | F06 |
| `present:open/update/close` | second window on external display | page render | ok | F08 |
| `print:pdf` | print exported pages | pdf bytes | ok | F02 |
| `backup:export/import` | `.gink` zip of a notebook | id / path | path / id | F03 |
| `app:open-file` (event) | file association / drag onto exe | path | – | F02 |

Webhooks: none. Jobs: in-process — autosave debounce, thumbnail regeneration, background OCR
indexing of changed pages (idle callback), PDF text indexing on import.

## The parts that bite

- **Latency**: every millisecond counts. Coalesced events for resolution, predicted events for the
  last frame, a dedicated wet-ink canvas with `desynchronized: true`, no React state updates while
  drawing, committed strokes blitted into a cached page bitmap.
- **Zoom quality**: pages re-render at device-pixel resolution after zoom settles; CSS transform
  during the gesture. Bitmaps capped per page to bound memory; off-screen pages released.
- **Big documents**: page virtualisation (only visible ±1 pages hold canvases); page content
  lazy-loaded; PDF pages rendered on demand and cached LRU.
- **Pen vs touch**: `pointerType` decides — pen draws, touch pans/zooms (pen-only mode), mouse
  draws unless the user turns that off. Pen eraser end (`buttons & 32`) erases.
- **Data safety**: atomic writes, flush on close, never delete without Trash.
- **Undo across pages**: one history stack per open document with page-scoped commands.
- **PDF export fidelity**: ink written as vector SVG paths with matching widths; highlighter with
  multiply-like opacity; text via standard fonts.
- **OCR**: Windows OCR reads handwriting reasonably for print, poorly for cursive; it is a
  search aid, not a promise.

## Build order

1. Vertical slice: S01 library (create) → S10 editor with pen on a ruled page → autosave →
   reopen. Files: library.json, notebook.json, pages/*. IPC: lib/nb/page.
2. Must-haves: ink tools (pen types, highlighter, eraser, shapes, lasso, text, images), page
   navigator, templates, PDF import + export, search, tabs, zoom/scroll modes, folders, favourites,
   trash, settings, dark mode, shortcuts, installer.
3. Should-haves: OCR search, audio, presentation, elements/stickers, tape, print, PNG export,
   list view, onboarding.
4. Could-haves: flashcards, notebook lock, planner templates.
5. Fixes from replica-entrepreneur.

## Performance budget (v2.1.0, measured on the dev PC at 200% display scaling)

Workload: import a 60-slide PDF and page through all of it. `node tests/bench.mjs`, `node tests/startup.mjs`,
`powershell -File tests/window-visible.ps1`.

| | Electron 1.4.0 | Tauri 2.1.0 |
|---|---|---|
| Installer | 130 MB | 4.3 MB |
| Window visible after launch | 603 ms | 55 ms |
| Library painted after launch | ~420 ms | ~510 ms (≈400 ms of it is WebView2's own engine start) |
| Memory, PDF open (private, whole process tree) | 2,150 MB | 1,092 MB |
| Memory, idle 30 s | — | ~690 MB |
| Page canvases | 50 Mpx | 9.7 Mpx |

How: two layers per page (bg + ink, tape only when used); ink layer only allocated on pages with ink;
off-screen pages at quarter resolution with prepare-then-swap upgrades; multiply blend only on on-screen
pages that have highlighter; PDF raster cache 64 MB (pixels live in the page layer); pdf.js page cleanup;
PDFs/images/thumbnails streamed from disk over `gink://` with HTTP Range (no full copies in JS); photos
decoded at ≤2560 px; overlay canvas sleeps when idle; WebView2 memory target LOW after 20 s idle or when
unfocused; editor/PDF/export code lazy-loaded; one `boot` IPC call, started from index.html.
