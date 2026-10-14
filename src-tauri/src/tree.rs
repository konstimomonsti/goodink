//! The library on disk is the folder tree you see in goodink. Every goodink folder is a real folder,
//! every notebook a "<Title>.goodink" folder (notebook.json, pages, assets), every saved web page or
//! video a Windows "<Title>.url" shortcut. Anything else you put into those folders shows up under
//! "All files". goodink's own data (library index, settings, Study, trash) lives in a hidden ".goodink"
//! folder at the top.
//!
//! Ids tie both sides together: a notebook's id is in its notebook.json, a folder's in a hidden
//! ".goodink-folder" file, a link's in its .url file. So a folder renamed or moved in Explorer is still
//! the same folder (with its colour, its Study deck …), and goodink's own changes are applied to disk
//! by `sync`, which moves things into place after every change to the library.

use crate::store::{safe_id, write_atomic, Res};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const META: &str = ".goodink";
pub const MARKER: &str = ".goodink-folder";
pub const NB_EXT: &str = "goodink";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Folder,
    Notebook,
    Link,
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub kind: Kind,
    pub path: PathBuf,
    pub trashed: bool,
}

pub type Layout = HashMap<String, Entry>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn new_id() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut h = sha2_hex(&format!("{n}{:?}", std::thread::current().id()));
    h.truncate(24);
    h
}

fn sha2_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Hide goodink's own files in Explorer (the .goodink folder, folder markers).
pub fn hide(path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_FLAGS_AND_ATTRIBUTES, INVALID_FILE_ATTRIBUTES};
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let a = GetFileAttributesW(PCWSTR(wide.as_ptr()));
            if a != INVALID_FILE_ATTRIBUTES && a & FILE_ATTRIBUTE_HIDDEN.0 == 0 {
                let _ = SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(a | FILE_ATTRIBUTE_HIDDEN.0));
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// A title as a file name Windows accepts. The same rule is in the renderer (lib/disk.ts).
pub fn file_name(title: &str) -> String {
    let mut s: String = title.chars().map(|c| if c < ' ' || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.chars().count() > 120 {
        s = s.chars().take(120).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    }
    if s.is_empty() || s.starts_with('.') {
        s = format!("Untitled{s}");
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        s.push('_');
    }
    s
}

fn skip(name: &str) -> bool {
    let l = name.to_lowercase();
    name.starts_with('.') || l == "desktop.ini" || l == "thumbs.db" || l.ends_with(".tmp") || name.starts_with("~$")
}

fn read_marker(dir: &Path) -> Option<String> {
    let t = fs::read_to_string(dir.join(MARKER)).ok()?;
    let id = t.trim().to_string();
    if safe_id(&id).is_ok() { Some(id) } else { None }
}

fn write_marker(dir: &Path, id: &str) {
    let f = dir.join(MARKER);
    // a hidden file cannot be overwritten in place on Windows: remove it first
    let _ = fs::remove_file(&f);
    if fs::write(&f, id).is_ok() {
        hide(&f);
    }
}

/// [InternetShortcut] file: Explorer opens it in the browser; goodink keeps its id in it.
pub fn url_file(url: &str, id: &str, kind: &str, author: &str) -> String {
    let mut s = format!("[InternetShortcut]\r\nURL={url}\r\n[goodink]\r\nId={id}\r\nKind={kind}\r\n");
    if !author.is_empty() {
        s.push_str(&format!("Author={}\r\n", author.replace(['\r', '\n'], " ")));
    }
    s
}

fn ini(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut section = String::new();
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') && l.ends_with(']') {
            section = l[1..l.len() - 1].to_lowercase();
        } else if let Some((k, v)) = l.split_once('=') {
            out.insert(format!("{section}.{}", k.trim().to_lowercase()), v.trim().to_string());
        }
    }
    out
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn mtime(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What is on disk: folders, notebooks, links and other files with their parents, plus the trash.
pub struct Scan {
    pub layout: Layout,
    pub json: Value,
}

/// `prev`: where things were last time. When Explorer made a copy (same id twice), the one still at
/// the known place keeps the id and the copy gets a new one.
pub fn scan(root: &Path, prev: &Layout) -> Scan {
    let prefer = prev.iter().filter(|(_, e)| !e.trashed && e.path.exists()).map(|(id, e)| (id.clone(), e.path.clone())).collect();
    let mut s = Scanner { root: root.to_path_buf(), prefer, layout: HashMap::new(), seen: HashSet::new(), folders: vec![], notebooks: vec![], links: vec![], files: vec![] };
    s.dir(root, None);
    let mut trashed = vec![];
    let meta = root.join(META);
    // trash: entries named by id
    if let Ok(rd) = fs::read_dir(meta.join("trash")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let p = e.path();
            let (id, kind) = if let Some(id) = name.strip_suffix(&format!(".{NB_EXT}")) {
                (id.to_string(), Kind::Notebook)
            } else if let Some(id) = name.strip_suffix(".url") {
                (id.to_string(), Kind::Link)
            } else if p.is_dir() {
                (name.clone(), Kind::Folder)
            } else {
                continue;
            };
            if safe_id(&id).is_ok() && !s.layout.contains_key(&id) {
                s.layout.insert(id.clone(), Entry { kind, path: p, trashed: true });
                trashed.push(Value::String(id));
            }
        }
    }
    // notebooks made or imported a moment ago, before their first sync
    if let Ok(rd) = fs::read_dir(meta.join("staging")) {
        for e in rd.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            if safe_id(&id).is_ok() && e.path().join("notebook.json").exists() && !s.layout.contains_key(&id) {
                s.layout.insert(id.clone(), Entry { kind: Kind::Notebook, path: e.path(), trashed: false });
                s.notebooks.push(json!({ "id": id, "staged": true }));
            }
        }
    }
    let json = json!({ "folders": s.folders, "notebooks": s.notebooks, "links": s.links, "files": s.files, "trashed": trashed });
    Scan { layout: s.layout, json }
}

struct Scanner {
    root: PathBuf,
    prefer: HashMap<String, PathBuf>,
    layout: Layout,
    seen: HashSet<String>,
    folders: Vec<Value>,
    notebooks: Vec<Value>,
    links: Vec<Value>,
    files: Vec<Value>,
}

impl Scanner {
    /// A unique id: copies made in Explorer carry the same id as their original and get a new one.
    fn claim(&mut self, id: Option<String>, at: &Path) -> (String, bool) {
        // a copy: the id belongs to the item still at its known place
        let copy = |id: &String| self.prefer.get(id).map(|p| !same(p, at)).unwrap_or(false);
        match id {
            Some(id) if !self.seen.contains(&id) && !copy(&id) => {
                self.seen.insert(id.clone());
                (id, false)
            }
            _ => {
                let id = new_id();
                self.seen.insert(id.clone());
                (id, true)
            }
        }
    }

    fn dir(&mut self, dir: &Path, parent: Option<&str>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            if skip(&name) {
                // left behind by an interrupted save of an older version
                if crate::store::is_stale_tmp(&e.path()) {
                    let _ = fs::remove_file(e.path());
                }
                continue;
            }
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                let nb_json = p.join("notebook.json");
                if nb_json.exists() {
                    self.notebook(&p, &nb_json, &name, parent);
                } else {
                    let (id, fresh) = self.claim(read_marker(&p), &p);
                    if fresh {
                        write_marker(&p, &id);
                    }
                    self.layout.insert(id.clone(), Entry { kind: Kind::Folder, path: p.clone(), trashed: false });
                    self.folders.push(json!({ "id": id, "name": name, "parent": parent, "created": md.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0) }));
                    self.dir(&p, Some(&id));
                }
            } else if name.to_lowercase().ends_with(".url") {
                let text = fs::read_to_string(&p).unwrap_or_default();
                let kv = ini(&text);
                let url = kv.get("internetshortcut.url").cloned().unwrap_or_default();
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    self.file(&p, &name, &md, parent);
                    continue;
                }
                let (id, fresh) = self.claim(kv.get("goodink.id").filter(|i| safe_id(i).is_ok()).cloned(), &p);
                let kind = kv.get("goodink.kind").cloned().unwrap_or_default();
                let author = kv.get("goodink.author").cloned().unwrap_or_default();
                if fresh {
                    let _ = write_atomic(&p, url_file(&url, &id, &kind, &author).as_bytes());
                }
                self.layout.insert(id.clone(), Entry { kind: Kind::Link, path: p.clone(), trashed: false });
                let title = name[..name.len() - 4].to_string();
                self.links.push(json!({ "id": id, "name": title, "parent": parent, "url": url, "kind": kind, "author": author, "modified": mtime(&md) }));
            } else {
                self.file(&p, &name, &md, parent);
            }
        }
    }

    fn notebook(&mut self, p: &Path, nb_json: &Path, name: &str, parent: Option<&str>) {
        crate::store::clean_tmp(p);
        crate::store::clean_tmp(&p.join("pages"));
        let text = fs::read_to_string(nb_json).unwrap_or_default();
        let mut doc: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let doc_id = doc["id"].as_str().filter(|i| safe_id(i).is_ok()).map(String::from);
        let (id, fresh) = self.claim(doc_id, p);
        if fresh && doc.is_object() {
            doc["id"] = Value::String(id.clone());
            let _ = write_atomic(nb_json, doc.to_string().as_bytes());
        }
        self.layout.insert(id.clone(), Entry { kind: Kind::Notebook, path: p.to_path_buf(), trashed: false });
        let title = name.strip_suffix(&format!(".{NB_EXT}")).unwrap_or(name).to_string();
        let pages = doc["pages"].as_array().map(|a| a.len()).unwrap_or(0);
        let first = &doc["pages"][0];
        self.notebooks.push(json!({ "id": id, "name": title, "parent": parent, "pages": pages, "w": first["w"], "h": first["h"] }));
    }

    fn file(&mut self, p: &Path, name: &str, md: &fs::Metadata, parent: Option<&str>) {
        self.files.push(json!({ "rel": rel(&self.root, p), "name": name, "parent": parent, "size": md.len(), "modified": mtime(md) }));
    }
}

// ---- making the disk match the library ------------------------------------------------------------

struct Item {
    id: String,
    kind: Kind,
    title: String,
    parent: Option<String>,
    deleted: bool,
    created: f64,
    url: String,
    link_kind: String,
    author: String,
}

fn items(lib: &Value) -> Vec<Item> {
    let mut out = vec![];
    let mut push = |list: &Value, kind: Kind, parent_key: &str| {
        for x in list.as_array().cloned().unwrap_or_default() {
            let Some(id) = x["id"].as_str().filter(|i| safe_id(i).is_ok()) else { continue };
            out.push(Item {
                id: id.to_string(),
                kind,
                title: x["title"].as_str().unwrap_or("Untitled").to_string(),
                parent: x[parent_key].as_str().map(String::from),
                deleted: !x["deletedAt"].is_null(),
                created: x["createdAt"].as_f64().unwrap_or(0.0),
                url: x["url"].as_str().unwrap_or_default().to_string(),
                link_kind: x["kind"].as_str().unwrap_or_default().to_string(),
                author: x["author"].as_str().unwrap_or_default().to_string(),
            });
        }
    };
    push(&lib["folders"], Kind::Folder, "parentId");
    push(&lib["notebooks"], Kind::Notebook, "folderId");
    push(&lib["links"], Kind::Link, "folderId");
    out
}

fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// Rename, creating the parent; a case-only rename goes through a temporary name (Windows).
fn rename(from: &Path, to: &Path) -> Res<()> {
    if let Some(p) = to.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    if same(from, to) && from != to {
        let tmp = from.with_file_name(format!(".goodink-rename-{}", new_id()));
        fs::rename(from, &tmp).map_err(err)?;
        return fs::rename(&tmp, to).map_err(err);
    }
    fs::rename(from, to).map_err(err)
}

fn reroot(layout: &mut Layout, from: &Path, to: &Path) {
    for e in layout.values_mut() {
        if let Ok(rest) = e.path.strip_prefix(from) {
            e.path = if rest.as_os_str().is_empty() { to.to_path_buf() } else { to.join(rest) };
        }
    }
}

/// Move everything into the place the library says. Problems (a file open elsewhere …) are logged
/// and retried with the next change; nothing is ever deleted except what was deleted for good.
pub fn sync(root: &Path, lib: &Value, prev: &Layout, log: &dyn Fn(&str)) -> Scan {
    let meta = root.join(META);
    let trash = meta.join("trash");
    let mut layout = scan(root, prev).layout;
    let all = items(lib);
    let known: HashSet<&str> = all.iter().map(|i| i.id.as_str()).collect();
    let live_folders: HashSet<&str> = all.iter().filter(|i| i.kind == Kind::Folder && !i.deleted).map(|i| i.id.as_str()).collect();
    let parent_of = |i: &Item| i.parent.clone().filter(|p| live_folders.contains(p.as_str()));

    // children per parent, oldest first, so names stay stable
    let mut by_parent: HashMap<Option<String>, Vec<&Item>> = HashMap::new();
    for i in all.iter().filter(|i| !i.deleted) {
        by_parent.entry(parent_of(i)).or_default().push(i);
    }
    for v in by_parent.values_mut() {
        v.sort_by(|a, b| a.created.partial_cmp(&b.created).unwrap_or(std::cmp::Ordering::Equal).then(a.id.cmp(&b.id)));
    }

    // walk the tree top-down: a folder is in place before its contents are placed
    let mut queue: Vec<(Option<String>, PathBuf)> = vec![(None, root.to_path_buf())];
    while let Some((pid, dir)) = queue.pop() {
        let kids = by_parent.get(&pid).cloned().unwrap_or_default();
        // names already taken in this folder by things goodink does not manage
        let mut taken: HashSet<String> = HashSet::new();
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                let ours = layout.iter().any(|(id, x)| same(&x.path, &p) && known.contains(id.as_str()));
                if !ours {
                    taken.insert(e.file_name().to_string_lossy().to_lowercase());
                }
            }
        }
        // keep the current name when it is still right (avoids "Name (2)" swapping between items)
        let mut names: HashMap<&str, String> = HashMap::new();
        let ext = |k: Kind| match k {
            Kind::Folder => String::new(),
            Kind::Notebook => format!(".{NB_EXT}"),
            Kind::Link => ".url".to_string(),
        };
        for i in &kids {
            let base = file_name(&i.title);
            if let Some(cur) = layout.get(&i.id).filter(|e| !e.trashed && e.path.parent().map(|p| same(p, &dir)).unwrap_or(false)) {
                let cur_name = cur.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let stem = cur_name.strip_suffix(&ext(i.kind)).unwrap_or(&cur_name).to_string();
                let fits = stem == base || stem.strip_prefix(&format!("{base} (")).map(|r| r.ends_with(')') && r[..r.len() - 1].parse::<u32>().is_ok()).unwrap_or(false);
                if fits && !taken.contains(&cur_name.to_lowercase()) {
                    taken.insert(cur_name.to_lowercase());
                    names.insert(&i.id, cur_name);
                }
            }
        }
        for i in &kids {
            if names.contains_key(i.id.as_str()) {
                continue;
            }
            let base = file_name(&i.title);
            let e = ext(i.kind);
            let mut n = format!("{base}{e}");
            let mut k = 2;
            while taken.contains(&n.to_lowercase()) {
                n = format!("{base} ({k}){e}");
                k += 1;
            }
            taken.insert(n.to_lowercase());
            names.insert(&i.id, n);
        }
        for i in &kids {
            let want = dir.join(&names[i.id.as_str()]);
            let cur = layout.get(&i.id).map(|e| e.path.clone());
            match i.kind {
                Kind::Folder => {
                    match cur {
                        Some(c) if c == want => {}
                        Some(c) if c.exists() => match rename(&c, &want) {
                            Ok(()) => {
                                reroot(&mut layout, &c, &want);
                                if read_marker(&want).as_deref() != Some(i.id.as_str()) {
                                    write_marker(&want, &i.id);
                                }
                            }
                            Err(e) => {
                                log(&format!("move folder {} → {}: {e}", c.display(), want.display()));
                                queue.push((Some(i.id.clone()), c));
                                continue;
                            }
                        },
                        _ => {
                            if fs::create_dir_all(&want).is_ok() {
                                write_marker(&want, &i.id);
                            }
                        }
                    }
                    if let Some(e) = layout.get_mut(&i.id) {
                        e.trashed = false;
                    } else {
                        layout.insert(i.id.clone(), Entry { kind: Kind::Folder, path: want.clone(), trashed: false });
                    }
                    queue.push((Some(i.id.clone()), want));
                }
                Kind::Notebook => {
                    let Some(c) = cur.filter(|c| c.exists()) else { continue };
                    if c != want {
                        match rename(&c, &want) {
                            Ok(()) => reroot(&mut layout, &c, &want),
                            Err(e) => log(&format!("move notebook {} → {}: {e}", c.display(), want.display())),
                        }
                    }
                    if let Some(e) = layout.get_mut(&i.id) {
                        e.trashed = false;
                    }
                }
                Kind::Link => {
                    let body = url_file(&i.url, &i.id, &i.link_kind, &i.author);
                    if let Some(c) = cur.filter(|c| c.exists() && *c != want) {
                        if let Err(e) = rename(&c, &want) {
                            log(&format!("move link {}: {e}", c.display()));
                            continue;
                        }
                    }
                    if fs::read_to_string(&want).map(|t| ini(&t).get("internetshortcut.url") != Some(&i.url) || ini(&t).get("goodink.id") != Some(&i.id)).unwrap_or(true) {
                        let _ = fs::remove_file(&want); // may be read-only/hidden after a copy
                        if let Err(e) = write_atomic(&want, body.as_bytes()) {
                            log(&format!("write link {}: {e}", want.display()));
                        }
                    }
                    layout.insert(i.id.clone(), Entry { kind: Kind::Link, path: want, trashed: false });
                }
            }
        }
    }

    // into the trash: notebooks and links first, then folders deepest first (so none ends up in another)
    let mut trashed: Vec<&Item> = all.iter().filter(|i| i.deleted).collect();
    trashed.sort_by_key(|i| (i.kind == Kind::Folder, std::cmp::Reverse(layout.get(&i.id).map(|e| e.path.components().count()).unwrap_or(0))));
    for i in trashed {
        let Some(e) = layout.get(&i.id).cloned() else { continue };
        if e.trashed || !e.path.exists() {
            continue;
        }
        let name = match i.kind {
            Kind::Notebook => format!("{}.{NB_EXT}", i.id),
            Kind::Link => format!("{}.url", i.id),
            Kind::Folder => i.id.clone(),
        };
        let to = trash.join(name);
        if to.exists() {
            continue;
        }
        match rename(&e.path, &to) {
            Ok(()) => {
                reroot(&mut layout, &e.path, &to);
                if let Some(x) = layout.get_mut(&i.id) {
                    x.trashed = true;
                }
            }
            Err(er) => log(&format!("trash {}: {er}", e.path.display())),
        }
    }

    // deleted for good: what is in the trash but no longer in the library
    if let Ok(rd) = fs::read_dir(&trash) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.split('.').next().unwrap_or("").to_string();
            if safe_id(&id).is_ok() && !known.contains(id.as_str()) {
                let p = e.path();
                let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            }
        }
    }
    scan(root, &layout)
}

/// Libraries from goodink 2.x: documents at the top, notebooks in "notebooks\<id>". Documents move
/// into .goodink, notebooks into .goodink\staging until the first sync puts them in their folders.
pub fn migrate(root: &Path, log: &dyn Fn(&str)) {
    let meta = root.join(META);
    let _ = fs::create_dir_all(&meta);
    hide(&meta);
    for name in ["library.json", "settings.json", "elements.json", "study.json", "study"] {
        let from = root.join(name);
        let to = meta.join(name);
        if from.exists() && !to.exists() {
            if let Err(e) = fs::rename(&from, &to) {
                log(&format!("migrate {name}: {e}"));
            }
        }
    }
    let old = root.join("notebooks");
    if let Ok(rd) = fs::read_dir(&old) {
        let staging = meta.join("staging");
        let _ = fs::create_dir_all(&staging);
        let mut moved_all = true;
        for e in rd.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            if safe_id(&id).is_ok() && e.path().join("notebook.json").exists() {
                if let Err(er) = fs::rename(e.path(), staging.join(&id)) {
                    log(&format!("migrate notebook {id}: {er}"));
                    moved_all = false;
                }
            } else {
                moved_all = false;
            }
        }
        if moved_all {
            let _ = fs::remove_dir(&old);
        }
    }
}

/// A path inside the library from the renderer ("Folder/file.pdf"): nothing may escape the root or
/// reach goodink's own files.
pub fn user_file(root: &Path, rel_path: &str) -> Res<PathBuf> {
    let mut p = root.to_path_buf();
    for part in rel_path.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') {
            return Err("bad path".into());
        }
        p.push(part);
    }
    if rel_path.split(['/', '\\']).next().map(|f| f.eq_ignore_ascii_case(META)).unwrap_or(true) {
        return Err("bad path".into());
    }
    Ok(p)
}
