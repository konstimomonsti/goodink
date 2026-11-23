//! OneNote import. A OneNote notebook (a .onepkg package, the .onetoc2 in a notebook's folder, or a
//! single .one section) becomes goodink folders and notebooks: the notebook is a folder, section
//! groups are folders inside it, every section is a goodink notebook, and every OneNote page is one
//! infinite canvas page in it. Handwriting becomes strokes, pictures and printouts become images,
//! and typed text becomes text boxes, all where they were on the OneNote page.
//!
//! Like a folder restore (backup.rs), the result is written straight into the library's folders and
//! then scanned, so goodink sees it the way it sees anything put there in Explorer.
//!
//! Units: OneNote places things in half-inches and draws ink in 0.01 mm; goodink uses PDF points.

use crate::store::{write_atomic, Res};
use crate::{folder_dir, rel_of, tree, unique_in, AppState};
use base64::Engine;
use onenote_parser::contents::{Content, Image, Ink, OutlineElement, OutlineItem, RichText};
use onenote_parser::page::{Page, PageContent};
use onenote_parser::property::common::ColorRef;
use onenote_parser::section::{Section, SectionEntry};
use onenote_parser::Parser;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const PT_PER_HALF_INCH: f32 = 36.0;
const PT_PER_INK_UNIT: f32 = 72.0 / 2540.0;
/// An infinite canvas page starts this big (store.ts INFINITE_START) with world 0,0 in its middle.
const CANVAS: f32 = 3000.0;
const INK: &str = "#1b1b1f";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// What was picked: a whole notebook, or one section.
enum Source {
    Notebook { title: String, entries: Vec<SectionEntry>, warnings: Vec<String> },
    Section(Section),
}

fn parse(file: &Path) -> Res<Source> {
    let name = file.to_string_lossy().to_string();
    let path = typed_path::TypedPath::derive(&name);
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let parser = Parser::new();
    let nb_warnings = |nb: &onenote_parser::notebook::Notebook| nb.report().warnings().iter().map(|w| w.message().to_string()).collect::<Vec<_>>();
    let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "OneNote".into());
    match ext.as_str() {
        "onepkg" => {
            let nb = parser.parse_package(path).map_err(|e| format!("Could not read this OneNote package: {e}"))?;
            Ok(Source::Notebook { title: stem, warnings: nb_warnings(&nb), entries: nb.entries().to_vec() })
        }
        "onetoc2" => {
            let nb = parser.parse_notebook(path).map_err(|e| format!("Could not read this OneNote notebook: {e}"))?;
            // the table of contents is "Open Notebook.onetoc2" in any language: the folder has the name
            let title = file.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or(stem);
            Ok(Source::Notebook { title, warnings: nb_warnings(&nb), entries: nb.entries().to_vec() })
        }
        "one" => Ok(Source::Section(parser.parse_section(path).map_err(|e| format!("Could not read this OneNote section: {e}"))?)),
        _ => Err("Pick a OneNote notebook (.onepkg or .onetoc2) or section (.one).".into()),
    }
}

fn pages_in(entries: &[SectionEntry]) -> usize {
    entries
        .iter()
        .map(|e| match e {
            SectionEntry::Section(s) => s.page_series().iter().map(|p| p.pages().len()).sum::<usize>().max(1),
            SectionEntry::SectionGroup(g) => pages_in(g.entries()),
        })
        .sum()
}

/// Import a OneNote file into the library folder `folder` (None = the top level). Progress arrives
/// as `onenote:progress` events ({ done, total } in pages). Returns the library scan afterwards, the
/// new top folder (whole notebooks) and every notebook made: [{ id, title, created, updated, color }].
#[tauri::command]
pub async fn onenote_import(app: AppHandle, file: String, folder: Option<String>) -> Res<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        // the parser can panic on files it does not understand: that is an error, not a crash
        let path = PathBuf::from(&file);
        let source = std::panic::catch_unwind(|| parse(&path)).map_err(|_| "This OneNote file could not be read.".to_string())??;
        let state = app.state::<AppState>();
        // exclusive: nothing moves while the notebook is written and scanned
        let store = state.store.write().unwrap_or_else(|e| e.into_inner());
        let dest = folder_dir(&store, folder.as_deref())?;
        let mut w = Writer { app: &app, done: 0, total: 0, made: vec![], warnings: vec![] };
        let top = match &source {
            Source::Notebook { title, entries, warnings } => {
                w.warnings.extend(warnings.iter().cloned());
                w.total = pages_in(entries);
                let top = unique_in(&dest, &tree::file_name(title));
                fs::create_dir_all(&top).map_err(err)?;
                w.entries(&top, entries)?;
                Some(top)
            }
            Source::Section(s) => {
                w.total = s.page_series().iter().map(|p| p.pages().len()).sum::<usize>().max(1);
                w.section(&dest, s)?;
                None
            }
        };
        let scan = store.rescan();
        let notebooks: Vec<Value> = w
            .made
            .iter()
            .filter_map(|(p, meta)| {
                let mut m = meta.clone();
                m["id"] = Value::String(store.id_at(p)?);
                Some(m)
            })
            .collect();
        let top_id = top.as_ref().and_then(|t| store.id_at(t));
        let path = top.as_ref().map(|t| rel_of(&store.root, t));
        crate::log(&format!("OneNote import: {} notebooks from {file}, {} warnings", notebooks.len(), w.warnings.len()));
        for x in &w.warnings {
            crate::log(&format!("  OneNote: {x}"));
        }
        Ok(json!({ "scan": scan, "top": top_id, "path": path, "notebooks": notebooks, "warnings": w.warnings }))
    })
    .await
    .map_err(err)?
}

struct Writer<'a> {
    app: &'a AppHandle,
    done: usize,
    total: usize,
    /// every notebook written: (its folder, { title, created, updated, color })
    made: Vec<(PathBuf, Value)>,
    warnings: Vec<String>,
}

impl Writer<'_> {
    fn entries(&mut self, dir: &Path, entries: &[SectionEntry]) -> Res<()> {
        for e in entries {
            match e {
                SectionEntry::Section(s) => self.section(dir, s)?,
                SectionEntry::SectionGroup(g) => {
                    let sub = unique_in(dir, &tree::file_name(g.display_name()));
                    fs::create_dir_all(&sub).map_err(err)?;
                    self.entries(&sub, g.entries())?;
                }
            }
        }
        Ok(())
    }

    /// One section: a goodink notebook with one infinite page per OneNote page.
    fn section(&mut self, dir: &Path, s: &Section) -> Res<()> {
        let title = s.display_name().trim_end_matches(".one").to_string();
        let nb = unique_in(dir, &format!("{}.{}", tree::file_name(&title), tree::NB_EXT));
        let id = tree::new_id();
        let mut pages = vec![];
        let mut outline = vec![];
        let mut assets = serde_json::Map::new();
        let mut index = serde_json::Map::new();
        let (mut created, mut updated) = (u64::MAX, 0u64);
        let all: Vec<&Page> = s.page_series().iter().flat_map(|p| p.pages()).collect();
        for (i, page) in all.iter().enumerate() {
            let pid = tree::new_id();
            let mut out = PageOut::default();
            out.page(page);
            for (aid, (ext, bytes)) in &out.assets {
                let f = nb.join("assets").join(format!("{aid}.{ext}"));
                if !f.exists() {
                    write_atomic(&f, bytes)?;
                }
                assets.insert(aid.clone(), json!({ "ext": ext, "bytes": bytes.len() }));
            }
            if out.skipped > 0 {
                self.warnings.push(format!("{title}, page {}: {} picture(s) in a format goodink cannot show", i + 1, out.skipped));
            }
            let (meta, content) = out.finish(&pid);
            write_atomic(&nb.join("pages").join(format!("{pid}.json")), content.to_string().as_bytes())?;
            index.insert(pid.clone(), json!({ "typed": out.typed, "pdf": [], "ocr": out.ocr, "ocrStamp": -1 }));
            let name = page.title_text().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| format!("Page {}", i + 1));
            outline.push(json!({ "id": tree::new_id(), "title": name, "pageId": pid }));
            pages.push(meta);
            created = created.min((page.created_time().unix_timestamp_nanos() / 1_000_000).max(0) as u64);
            updated = updated.max((page.updated_time().unix_timestamp_nanos() / 1_000_000).max(0) as u64);
            self.tick();
        }
        if pages.is_empty() {
            // an empty section is an empty notebook, ready to write in
            let pid = tree::new_id();
            write_atomic(&nb.join("pages").join(format!("{pid}.json")), json!({ "v": 1, "strokes": [], "objects": [] }).to_string().as_bytes())?;
            pages.push(canvas_page(&pid, None));
            self.tick();
        }
        let doc = json!({ "id": id, "pages": pages, "outline": outline, "recordings": [], "assets": assets });
        write_atomic(&nb.join("notebook.json"), doc.to_string().as_bytes())?;
        write_atomic(&nb.join("index.json"), json!({ "pages": index }).to_string().as_bytes())?;
        let color = s.color().map(|c| format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b()));
        let now = chrono::Utc::now().timestamp_millis() as u64;
        self.made.push((
            nb,
            json!({ "title": title, "created": if created == u64::MAX { now } else { created }, "updated": if updated == 0 { now } else { updated }, "color": color }),
        ));
        Ok(())
    }

    fn tick(&mut self) {
        self.done += 1;
        if self.done % 4 == 0 || self.done >= self.total {
            let _ = self.app.emit("onenote:progress", json!({ "done": self.done, "total": self.total }));
        }
    }
}

/// An infinite canvas page holding `bbox` (x0, y0, x1, y1), opening at world 0,0.
fn canvas_page(id: &str, bbox: Option<[f32; 4]>) -> Value {
    let half = CANVAS / 2.0;
    let [x0, y0, x1, y1] = bbox.unwrap_or([0.0, 0.0, 0.0, 0.0]);
    let (ox, oy) = ((x0 - half).min(-half), (y0 - half).min(-half));
    let w = (x1 + half - ox).max(CANVAS);
    let h = (y1 + half - oy).max(CANVAS);
    json!({ "id": id, "w": w.ceil(), "h": h.ceil(), "ox": ox.floor(), "oy": oy.floor(), "infinite": true, "rotation": 0, "template": { "kind": "blank", "paper": "white" } })
}

fn hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Ink colours are COLORREFs: 0x00BBGGRR.
fn colorref(c: u32) -> String {
    hex((c & 0xff) as u8, ((c >> 8) & 0xff) as u8, ((c >> 16) & 0xff) as u8)
}

/// A picture's file type, from its first bytes (OneNote does not always say).
fn image_ext(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG") {
        Some("png")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if b.starts_with(b"GIF8") {
        Some("gif")
    } else if b.starts_with(b"BM") {
        Some("bmp")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// Pixel size from a PNG or JPEG header, for pictures without a layout size.
fn pixel_size(b: &[u8]) -> Option<(f32, f32)> {
    if b.starts_with(b"\x89PNG") && b.len() > 24 {
        let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
        let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
        return Some((w as f32, h as f32));
    }
    if b.starts_with(&[0xff, 0xd8]) {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xff {
                return None;
            }
            let marker = b[i + 1];
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]);
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]);
                return Some((w as f32, h as f32));
            }
            i += 2 + len;
        }
    }
    None
}

/// Text style of a run of paragraphs that share one text box.
#[derive(Clone, PartialEq)]
struct Style {
    size: f32,
    bold: bool,
    italic: bool,
    underline: bool,
    color: String,
}

/// One OneNote page, converted.
#[derive(Default)]
struct PageOut {
    strokes: Vec<Value>,
    /// pictures marked as the page background (printouts) go below everything else
    back: Vec<Value>,
    objects: Vec<Value>,
    assets: HashMap<String, (&'static str, Vec<u8>)>,
    typed: Vec<Value>,
    ocr: Vec<Value>,
    bbox: Option<[f32; 4]>,
    skipped: usize,
}

impl PageOut {
    fn grow(&mut self, x0: f32, y0: f32, x1: f32, y1: f32) {
        if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
            return;
        }
        self.bbox = Some(match self.bbox {
            None => [x0, y0, x1, y1],
            Some(b) => [b[0].min(x0), b[1].min(y0), b[2].max(x1), b[3].max(y1)],
        });
    }

    fn page(&mut self, page: &Page) {
        if let Some(t) = page.title() {
            let (x, y) = (t.offset_horizontal() * PT_PER_HALF_INCH, t.offset_vertical() * PT_PER_HALF_INCH);
            let mut y = y;
            for o in t.contents() {
                y = self.outline_items(o.items(), x, y, 520.0, 0, Some(20.0));
            }
        }
        for c in page.contents() {
            match c {
                PageContent::Outline(o) => {
                    let x = o.offset_horizontal().unwrap_or(1.0) * PT_PER_HALF_INCH;
                    let y = o.offset_vertical().unwrap_or(2.0) * PT_PER_HALF_INCH;
                    let w = o.layout_max_width().map(|w| w * PT_PER_HALF_INCH).unwrap_or(13.0 * PT_PER_HALF_INCH).max(60.0);
                    self.outline_items(o.items(), x, y, w, 0, None);
                }
                PageContent::Ink(ink) => {
                    self.ink(ink, 0.0, 0.0, None);
                }
                PageContent::Image(img) => {
                    let x = img.offset_horizontal().unwrap_or(0.0) * PT_PER_HALF_INCH;
                    let y = img.offset_vertical().unwrap_or(0.0) * PT_PER_HALF_INCH;
                    self.image(img, x, y);
                }
                PageContent::EmbeddedFile(f) => {
                    let x = f.offset_horizontal().unwrap_or(0.0) * PT_PER_HALF_INCH;
                    let y = f.offset_vertical().unwrap_or(0.0) * PT_PER_HALF_INCH;
                    let style = Style { size: 11.0, bold: false, italic: true, underline: false, color: "#5b6270".into() };
                    self.text_box(&format!("Attachment: {}", f.filename()), x, y, 300.0, &style);
                }
                _ => {}
            }
        }
    }

    /// An outline (OneNote's text container): paragraphs stack downwards from (x, y), indented per
    /// level. Consecutive paragraphs of one style share a text box. Returns the y below it.
    fn outline_items(&mut self, items: &[OutlineItem], x: f32, mut y: f32, w: f32, level: usize, title: Option<f32>) -> f32 {
        for item in items {
            match item {
                OutlineItem::Group(g) => y = self.outline_items(g.outlines(), x, y, w, level + 1, title),
                OutlineItem::Element(e) => {
                    y = self.element(e, x, y, w, level, title);
                    y = self.outline_items(e.children(), x, y, w, level + 1, title);
                }
            }
        }
        y
    }

    fn element(&mut self, e: &OutlineElement, x: f32, mut y: f32, w: f32, level: usize, title: Option<f32>) -> f32 {
        let indent = level as f32 * 27.0;
        let (x, w) = (x + indent, (w - indent).max(60.0));
        let bullet = if e.list_contents().is_empty() { "" } else { "• " };
        let mut block: Option<(Style, Vec<String>)> = None;
        let flush = |me: &mut PageOut, block: &mut Option<(Style, Vec<String>)>, y: &mut f32| {
            if let Some((style, lines)) = block.take() {
                *y = me.text_box(&lines.join("\n"), x, *y, w, &style) + style.size * 0.3;
            }
        };
        for (i, c) in e.contents().iter().enumerate() {
            match c {
                Content::RichText(r) => {
                    let style = text_style(r, title);
                    let line = format!("{}{}", if i == 0 { bullet } else { "" }, r.text().trim_end_matches(['\r', '\n']));
                    match &mut block {
                        Some((s, lines)) if *s == style => lines.push(line),
                        _ => {
                            flush(self, &mut block, &mut y);
                            block = Some((style, vec![line]));
                        }
                    }
                }
                Content::Table(t) => {
                    flush(self, &mut block, &mut y);
                    let rows: Vec<String> = t
                        .contents()
                        .iter()
                        .map(|row| {
                            row.contents()
                                .iter()
                                .map(|cell| cell.contents().iter().flat_map(|el| el.contents()).filter_map(|c| c.rich_text()).map(|r| r.text().trim().to_string()).collect::<Vec<_>>().join(" "))
                                .collect::<Vec<_>>()
                                .join("  |  ")
                        })
                        .collect();
                    let style = Style { size: 11.0, bold: false, italic: false, underline: false, color: INK.into() };
                    y = self.text_box(&rows.join("\n"), x, y, w, &style) + 4.0;
                }
                Content::Image(img) => {
                    flush(self, &mut block, &mut y);
                    y = self.image(img, x, y) + 4.0;
                }
                Content::Ink(ink) => {
                    flush(self, &mut block, &mut y);
                    // ink inside text flows with it: its own top-left goes to where it sits
                    y = self.ink(ink, 0.0, 0.0, Some((x, y))) + 4.0;
                }
                Content::EmbeddedFile(f) => {
                    flush(self, &mut block, &mut y);
                    let style = Style { size: 11.0, bold: false, italic: true, underline: false, color: "#5b6270".into() };
                    y = self.text_box(&format!("Attachment: {}", f.filename()), x, y, w, &style) + 4.0;
                }
                _ => {}
            }
        }
        flush(self, &mut block, &mut y);
        y
    }

    /// A text box at (x, y), `w` wide; its height follows the wrapped lines. Returns its bottom.
    fn text_box(&mut self, text: &str, x: f32, y: f32, w: f32, s: &Style) -> f32 {
        if text.trim().is_empty() {
            return y + s.size * 1.3;
        }
        let per_line = (w / (s.size * 0.52)).max(8.0) as usize;
        let lines: usize = text.split('\n').map(|l| l.chars().count().div_ceil(per_line).max(1)).sum();
        let h = lines as f32 * s.size * 1.3 + 4.0;
        let mut o = json!({ "id": tree::new_id(), "type": "text", "x": x, "y": y, "w": w, "h": h, "rot": 0, "text": text, "font": "sans", "size": s.size, "color": s.color, "align": "left" });
        if s.bold {
            o["bold"] = json!(true);
        }
        if s.italic {
            o["italic"] = json!(true);
        }
        if s.underline {
            o["underline"] = json!(true);
        }
        for word in text.split_whitespace() {
            self.typed.push(json!({ "t": word, "b": [x, y, w, h] }));
        }
        self.objects.push(o);
        self.grow(x, y, x + w, y + h);
        y + h
    }

    /// A picture with its top-left at (x, y). Returns its bottom.
    fn image(&mut self, img: &Image, x: f32, y: f32) -> f32 {
        let mut bytes = vec![];
        if let Some(mut r) = img.read() {
            let _ = r.read_to_end(&mut bytes);
        }
        let Some(ext) = image_ext(&bytes) else {
            if !bytes.is_empty() {
                self.skipped += 1;
            }
            return y;
        };
        let px = pixel_size(&bytes);
        let w = img
            .layout_max_width()
            .map(|v| v * PT_PER_HALF_INCH)
            .or_else(|| img.picture_width().map(|v| v * 72.0))
            .or_else(|| px.map(|p| p.0 * 0.75))
            .unwrap_or(200.0);
        let h = img
            .layout_max_height()
            .map(|v| v * PT_PER_HALF_INCH)
            .or_else(|| img.picture_height().map(|v| v * 72.0))
            .or_else(|| px.map(|p| w * p.1 / p.0.max(1.0)))
            .unwrap_or(w);
        let id: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>()[..40].to_string();
        let o = json!({ "id": tree::new_id(), "type": "image", "x": x, "y": y, "w": w, "h": h, "rot": 0, "src": format!("asset:{id}") });
        self.assets.entry(id).or_insert((ext, bytes));
        if img.is_background() {
            self.back.push(o);
        } else {
            self.objects.push(o);
        }
        self.grow(x, y, x + w, y + h);
        y + h
    }

    /// Ink, offset by its own and its parents' offsets (half-inches). With `at`, the ink's top-left
    /// is moved there (ink that flows inside text). Returns the bottom of the ink.
    fn ink(&mut self, ink: &Ink, dx: f32, dy: f32, at: Option<(f32, f32)>) -> f32 {
        let dx = dx + ink.offset_horizontal().unwrap_or(0.0) * PT_PER_HALF_INCH;
        let dy = dy + ink.offset_vertical().unwrap_or(0.0) * PT_PER_HALF_INCH;
        let mut paths: Vec<(Vec<(f32, f32)>, &onenote_parser::contents::InkStroke)> = vec![];
        collect(ink, dx, dy, &mut paths);
        if paths.is_empty() {
            return at.map(|a| a.1).unwrap_or(0.0);
        }
        // where ink in text goes: its top-left at `at`
        let (mut sx, mut sy) = (0.0, 0.0);
        if let Some((ax, ay)) = at {
            let mx = paths.iter().flat_map(|p| p.0.iter().map(|q| q.0)).fold(f32::MAX, f32::min);
            let my = paths.iter().flat_map(|p| p.0.iter().map(|q| q.1)).fold(f32::MAX, f32::min);
            (sx, sy) = (ax - mx, ay - my);
        }
        let mut words: HashMap<u32, (String, [f32; 4])> = HashMap::new();
        let mut bottom = f32::MIN;
        for (pts, s) in &paths {
            let highlighter = s.transparency().map(|t| t < 255).unwrap_or(false) || s.pen_tip() == Some(1);
            let width = (s.width().max(s.height()) * PT_PER_INK_UNIT).clamp(0.3, 40.0);
            let mut buf = Vec::with_capacity(pts.len() * 12);
            let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
            for &(x, y) in pts {
                let (x, y) = (x + sx, y + sy);
                for v in [x, y, 0.5f32] {
                    buf.extend_from_slice(&v.to_le_bytes());
                }
                b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
            }
            let color = s.color().map(colorref).unwrap_or_else(|| INK.into());
            let mut j = json!({ "id": tree::new_id(), "k": if highlighter { "highlighter" } else { "pen" }, "c": color, "w": width, "pts": base64::engine::general_purpose::STANDARD.encode(&buf) });
            if !highlighter {
                j["pen"] = json!("ball");
            }
            self.strokes.push(j);
            let pad = width / 2.0;
            self.grow(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad);
            bottom = bottom.max(b[3] + pad);
            // OneNote's own handwriting recognition: searchable words
            if let Some(word) = s.recognized_word() {
                if let Some(t) = word.text().filter(|t| !t.trim().is_empty()) {
                    let e = words.entry(word.id()).or_insert_with(|| (t.to_string(), [f32::MAX, f32::MAX, f32::MIN, f32::MIN]));
                    e.1 = [e.1[0].min(b[0]), e.1[1].min(b[1]), e.1[2].max(b[2]), e.1[3].max(b[3])];
                }
            }
        }
        for (t, b) in words.into_values() {
            self.ocr.push(json!({ "t": t, "b": [b[0], b[1], b[2] - b[0], b[3] - b[1]] }));
        }
        bottom
    }

    /// The page's meta (for notebook.json) and content (pages/<id>.json).
    fn finish(&mut self, id: &str) -> (Value, Value) {
        let mut objects = std::mem::take(&mut self.back);
        objects.append(&mut self.objects);
        let content = json!({ "v": 1, "strokes": std::mem::take(&mut self.strokes), "objects": objects });
        (canvas_page(id, self.bbox), content)
    }
}

/// Every stroke of an ink object and its groups, in points, with the offsets of the groups applied.
fn collect<'a>(ink: &'a Ink, dx: f32, dy: f32, out: &mut Vec<(Vec<(f32, f32)>, &'a onenote_parser::contents::InkStroke)>) {
    for s in ink.ink_strokes() {
        let pts: Vec<(f32, f32)> = s.absolute_path().iter().map(|p| (p.x() * PT_PER_INK_UNIT + dx, p.y() * PT_PER_INK_UNIT + dy)).filter(|p| p.0.is_finite() && p.1.is_finite()).collect();
        if !pts.is_empty() {
            out.push((pts, s));
        }
    }
    for g in ink.child_groups() {
        let gx = dx + g.offset_horizontal().unwrap_or(0.0) * PT_PER_HALF_INCH;
        let gy = dy + g.offset_vertical().unwrap_or(0.0) * PT_PER_HALF_INCH;
        collect(g, gx, gy, out);
    }
}

fn text_style(r: &RichText, title: Option<f32>) -> Style {
    let p = r.paragraph_style();
    let run = r.text_run_formatting().first();
    let size = run.and_then(|s| s.font_size()).or(p.font_size()).map(|h| h as f32 / 2.0).or(title).unwrap_or(11.0).clamp(4.0, 96.0);
    let color = run
        .and_then(|s| s.font_color())
        .or(p.font_color())
        .and_then(|c| match c {
            ColorRef::Manual { r, g, b } => Some(hex(r, g, b)),
            _ => None,
        })
        .unwrap_or_else(|| INK.into());
    Style {
        size,
        bold: run.map(|s| s.bold()).unwrap_or(false) || p.bold(),
        italic: run.map(|s| s.italic()).unwrap_or(false) || p.italic(),
        underline: run.map(|s| s.underline()).unwrap_or(false) || p.underline(),
        color,
    }
}
