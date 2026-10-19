//! Local document store. Everything lives under one library root; ids are validated so no path can
//! escape it. Writes are atomic (tmp + fsync + rename): a crash never leaves a half-written file.
//! Where a notebook lives is decided by the library's folder tree (see tree.rs).

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use crate::tree::{self, Layout};

pub type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn safe_id(id: &str) -> Res<&str> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok { Ok(id) } else { Err(format!("invalid id: {id}")) }
}

fn safe_ext(ext: &str) -> Res<&str> {
    let ok = !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if ok { Ok(ext) } else { Err("bad ext".into()) }
}

/// Where atomic writes stage their temp files: (library root, its hidden .goodink\tmp). Files of the
/// library stage there, so a write cut short (crash, power loss) never leaves a .tmp next to notebooks.
static TMP: RwLock<Option<(PathBuf, PathBuf)>> = RwLock::new(None);

pub fn write_atomic(file: &Path, data: &[u8]) -> Res<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let unique = format!("{name}.{}.{}.tmp", std::process::id(), rand_suffix());
    let staged = TMP.read().ok().and_then(|t| t.as_ref().filter(|(root, _)| file.starts_with(root)).map(|(_, dir)| dir.join(&unique)));
    // outside the library (config.json), or the library spans drives (a junction): a hidden name next to the file
    let beside = file.with_file_name(format!(".{unique}"));
    match staged {
        Some(tmp) => write_via(&tmp, file, data).or_else(|_| write_via(&beside, file, data)),
        None => write_via(&beside, file, data),
    }
}

fn write_via(tmp: &Path, file: &Path, data: &[u8]) -> Res<()> {
    let res = (|| {
        {
            let mut f = fs::File::create(tmp).map_err(err)?;
            f.write_all(data).map_err(err)?;
            f.sync_all().map_err(err)?;
        }
        // Windows: a virus scanner or the search indexer may hold the target for a moment
        let mut tries = 0;
        loop {
            match fs::rename(tmp, file) {
                Ok(()) => return Ok(()),
                Err(e) if tries < 8 && e.kind() == std::io::ErrorKind::PermissionDenied => {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(15 * tries));
                }
                Err(e) => return Err(err(e)),
            }
        }
    })();
    if res.is_err() {
        let _ = fs::remove_file(tmp);
    }
    res
}

/// A temp file of write_atomic ("<name>.<pid>.<8 hex>.tmp", older versions wrote them next to the file).
pub fn is_stale_tmp(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let Some(stem) = name.strip_suffix(".tmp") else { return false };
    let mut parts = stem.rsplit('.');
    let (Some(hex), Some(pid)) = (parts.next(), parts.next()) else { return false };
    let ours = hex.len() == 8 && hex.chars().all(|c| c.is_ascii_hexdigit()) && !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit()) && parts.next().is_some();
    // not one a write is busy with right now
    ours && fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 60).unwrap_or(false)
}

/// Remove temp files left behind by interrupted writes in a folder.
pub fn clean_tmp(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if is_stale_tmp(&p) && e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let _ = fs::remove_file(&p);
        }
    }
}

fn rand_suffix() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{n:08x}")
}

fn read_string(file: &Path) -> Option<String> {
    fs::read_to_string(file).ok()
}

pub struct Store {
    pub root: PathBuf,
    /// goodink's own files: library index, settings, Study, trash (hidden)
    pub meta: PathBuf,
    layout: Mutex<Layout>,
}

impl Store {
    pub fn new(root: PathBuf) -> Res<Self> {
        fs::create_dir_all(&root).map_err(err)?;
        tree::migrate(&root, &crate::log);
        let meta = root.join(tree::META);
        let tmp = meta.join("tmp");
        if fs::create_dir_all(&tmp).is_ok() {
            clean_tmp(&tmp);
            if let Ok(mut t) = TMP.write() {
                *t = Some((root.clone(), tmp));
            }
        }
        clean_tmp(&root);
        clean_tmp(&meta);
        let store = Self { meta, layout: Mutex::new(Layout::new()), root };
        // put everything where the library says (also places notebooks of an older library)
        match store.read_doc("library.json").and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            Some(lib) => {
                store.sync(&lib);
            }
            None => {
                store.rescan();
            }
        }
        Ok(store)
    }

    pub fn nb_dir(&self, id: &str) -> Res<PathBuf> {
        let id = safe_id(id)?;
        let layout = self.layout.lock().unwrap_or_else(|e| e.into_inner());
        Ok(match layout.get(id) {
            Some(e) if e.kind == tree::Kind::Notebook => e.path.clone(),
            // new, before the library places it
            _ => self.meta.join("staging").join(id),
        })
    }

    /// Where an item (folder, notebook, link) is on disk.
    pub fn item_path(&self, id: &str) -> Option<PathBuf> {
        self.layout.lock().unwrap_or_else(|e| e.into_inner()).get(id).map(|e| e.path.clone())
    }

    /// The item (folder, notebook, link) at a place on disk.
    pub fn id_at(&self, path: &Path) -> Option<String> {
        let layout = self.layout.lock().unwrap_or_else(|e| e.into_inner());
        layout.iter().find(|(_, e)| !e.trashed && e.path == path).map(|(id, _)| id.clone())
    }

    /// Move folders, notebooks and links to where the library has them; returns what is on disk.
    pub fn sync(&self, lib: &Value) -> Value {
        let mut layout = self.layout.lock().unwrap_or_else(|e| e.into_inner());
        let s = tree::sync(&self.root, lib, &layout, &crate::log);
        *layout = s.layout;
        s.json
    }

    /// What is on disk now (changes made in Explorer).
    pub fn rescan(&self) -> Value {
        let mut layout = self.layout.lock().unwrap_or_else(|e| e.into_inner());
        let s = tree::scan(&self.root, &layout);
        *layout = s.layout;
        s.json
    }

    // ---- whole-file JSON documents (passed through as text: no parse on the hot path) ----------

    pub fn read_doc(&self, rel: &str) -> Option<String> {
        read_string(&self.meta.join(rel))
    }

    pub fn write_doc(&self, rel: &str, json: &str) -> Res<()> {
        write_atomic(&self.meta.join(rel), json.as_bytes())
    }

    pub fn load_notebook(&self, id: &str) -> Res<Option<String>> {
        let dir = self.nb_dir(id)?;
        let Some(text) = read_string(&dir.join("notebook.json")) else { return Ok(None) };
        // remove page files no longer referenced by the manifest (pages deleted in an earlier session)
        if let Ok(doc) = serde_json::from_str::<Value>(&text) {
            let keep: std::collections::HashSet<String> = doc["pages"]
                .as_array()
                .map(|a| a.iter().filter_map(|p| p["id"].as_str().map(|s| format!("{s}.json"))).collect())
                .unwrap_or_default();
            if let Ok(entries) = fs::read_dir(dir.join("pages")) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.ends_with(".json") && !keep.contains(&name) {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
        Ok(Some(text))
    }

    pub fn save_notebook(&self, id: &str, json: &str) -> Res<()> {
        write_atomic(&self.nb_dir(id)?.join("notebook.json"), json.as_bytes())
    }

    pub fn load_page(&self, nb: &str, page: &str) -> Res<Option<String>> {
        Ok(read_string(&self.nb_dir(nb)?.join("pages").join(format!("{}.json", safe_id(page)?))))
    }

    pub fn save_page(&self, nb: &str, page: &str, json: &str) -> Res<()> {
        write_atomic(&self.nb_dir(nb)?.join("pages").join(format!("{}.json", safe_id(page)?)), json.as_bytes())
    }

    pub fn load_index(&self, nb: &str) -> Res<Option<String>> {
        Ok(read_string(&self.nb_dir(nb)?.join("index.json")))
    }

    pub fn save_index(&self, nb: &str, json: &str) -> Res<()> {
        write_atomic(&self.nb_dir(nb)?.join("index.json"), json.as_bytes())
    }

    // ---- binary assets ---------------------------------------------------------------------------

    pub fn put_asset(&self, nb: &str, bytes: &[u8], ext: &str) -> Res<String> {
        let ext = safe_ext(ext)?;
        let hash = Sha256::digest(bytes);
        let id: String = hash.iter().map(|b| format!("{b:02x}")).collect::<String>()[..40].to_string();
        let file = self.nb_dir(nb)?.join("assets").join(format!("{id}.{ext}"));
        if !file.exists() {
            write_atomic(&file, bytes)?;
        }
        Ok(id)
    }

    pub fn get_asset(&self, nb: &str, id: &str, ext: &str) -> Res<Vec<u8>> {
        fs::read(self.nb_dir(nb)?.join("assets").join(format!("{}.{}", safe_id(id)?, safe_ext(ext)?))).map_err(err)
    }

    pub fn put_study_file(&self, bytes: &[u8], ext: &str) -> Res<String> {
        let ext = safe_ext(ext)?;
        let hash = Sha256::digest(bytes);
        let id: String = hash.iter().map(|b| format!("{b:02x}")).collect::<String>()[..40].to_string();
        let file = self.meta.join("study").join("files").join(format!("{id}.{ext}"));
        if !file.exists() {
            write_atomic(&file, bytes)?;
        }
        Ok(id)
    }

    pub fn get_study_file(&self, id: &str, ext: &str) -> Res<Vec<u8>> {
        fs::read(self.meta.join("study").join("files").join(format!("{}.{}", safe_id(id)?, safe_ext(ext)?))).map_err(err)
    }

    pub fn save_thumb(&self, nb: &str, png: &[u8]) -> Res<()> {
        write_atomic(&self.nb_dir(nb)?.join("thumb.png"), png)
    }

    pub fn get_thumb(&self, nb: &str) -> Res<Vec<u8>> {
        Ok(fs::read(self.nb_dir(nb)?.join("thumb.png")).unwrap_or_default())
    }

    pub fn delete_notebook(&self, id: &str) -> Res<()> {
        let dir = self.nb_dir(id)?;
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(err)?;
        }
        self.layout.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        Ok(())
    }

    pub fn duplicate_notebook(&self, from: &str, to: &str) -> Res<()> {
        copy_dir(&self.nb_dir(from)?, &self.nb_dir(to)?)?;
        if let Some(text) = self.load_notebook(to)? {
            if let Ok(mut doc) = serde_json::from_str::<Value>(&text) {
                doc["id"] = Value::String(to.to_string());
                self.save_notebook(to, &doc.to_string())?;
            }
        }
        Ok(())
    }

    // ---- search ----------------------------------------------------------------------------------

    pub fn search(&self, query: &str, limit: usize) -> Value {
        let q = query.trim().to_lowercase();
        let mut hits: Vec<Value> = Vec::new();
        if q.is_empty() {
            return Value::Array(hits);
        }
        let lib: Value = self.read_doc("library.json").and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        for nb in lib["notebooks"].as_array().cloned().unwrap_or_default() {
            if !nb["deletedAt"].is_null() {
                continue;
            }
            let id = nb["id"].as_str().unwrap_or_default().to_string();
            let title = nb["title"].as_str().unwrap_or_default().to_string();
            if title.to_lowercase().contains(&q) {
                hits.push(serde_json::json!({ "notebookId": id, "notebookTitle": title, "pageId": "", "pageNumber": 0, "snippet": title, "source": "title" }));
            }
            let Ok(dir) = self.nb_dir(&id) else { continue };
            let idx: Value = read_string(&dir.join("index.json")).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
            let doc: Value = match read_string(&dir.join("notebook.json")).and_then(|t| serde_json::from_str(&t).ok()) {
                Some(d) => d,
                None => continue,
            };
            for (i, p) in doc["pages"].as_array().cloned().unwrap_or_default().iter().enumerate() {
                let pid = p["id"].as_str().unwrap_or_default();
                let pi = &idx["pages"][pid];
                if pi.is_null() {
                    continue;
                }
                for source in ["typed", "pdf", "ocr"] {
                    let text: String = pi[source]
                        .as_array()
                        .map(|ws| ws.iter().filter_map(|w| w["t"].as_str()).collect::<Vec<_>>().join(" "))
                        .unwrap_or_default();
                    let lower = text.to_lowercase();
                    if let Some(at) = lower.find(&q) {
                        let snippet = snippet_around(&text, at, q.len());
                        hits.push(serde_json::json!({ "notebookId": id, "notebookTitle": title, "pageId": pid, "pageNumber": i + 1, "snippet": snippet, "source": source }));
                        break;
                    }
                }
            }
            if hits.len() >= limit {
                break;
            }
        }
        hits.truncate(limit);
        Value::Array(hits)
    }
}

/// ~40 characters before and ~60 after the match, on char boundaries.
fn snippet_around(text: &str, at: usize, len: usize) -> String {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let pos = chars.iter().position(|(b, _)| *b >= at).unwrap_or(0);
    let from = pos.saturating_sub(40);
    let end_byte = at + len;
    let end = chars.iter().position(|(b, _)| *b >= end_byte).unwrap_or(chars.len());
    let to = (end + 60).min(chars.len());
    let s: String = chars[from..to].iter().map(|(_, c)| c).collect();
    if from > 0 { format!("…{}", s.trim()) } else { s.trim().to_string() }
}

pub fn copy_dir(from: &Path, to: &Path) -> Res<()> {
    fs::create_dir_all(to).map_err(err)?;
    for e in fs::read_dir(from).map_err(err)? {
        let e = e.map_err(err)?;
        let dest = to.join(e.file_name());
        if e.file_type().map_err(err)?.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else if !dest.exists() && !e.file_name().to_string_lossy().ends_with(".tmp") {
            fs::copy(e.path(), &dest).map_err(err)?;
        }
    }
    Ok(())
}
