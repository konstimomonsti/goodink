//! Backups of a whole folder or of the whole library, in the same .gink file as a notebook backup
//! (a zip). A notebook backup has meta.json at the top; these have backup.json, which names the kind
//! and carries the library's metadata (covers, colours …) for every item by its path in the zip.
//!
//! The zip holds the folder tree exactly as it is on disk, so restoring is unzipping into a new
//! folder of the library and scanning it: the scanner gives copies of items that still exist a new
//! id (tree.rs `claim`), so a restore never clashes with what is already there.

use crate::store::Res;
use crate::{folder_dir, rel_of, tree, unique_in, AppState};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST: &str = "backup.json";
/// goodink's own folder: settings and Study travel along in a library backup, scratch space does not
const META_SKIP: [&str; 3] = ["tmp", "trash", "staging"];

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Every file under `dir`, with its path in the zip (`prefix` + path below `dir`, "/"-separated).
fn files(dir: &Path, prefix: &str, top: bool, out: &mut Vec<(PathBuf, String)>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let l = name.to_lowercase();
        if l.ends_with(".tmp") || name.starts_with("~$") || l == "desktop.ini" || l == "thumbs.db" {
            continue;
        }
        let p = e.path();
        let zp = format!("{prefix}{name}");
        if p.is_dir() {
            if top && name == tree::META {
                // the library's own files, minus scratch space and the trash
                let Ok(rd) = fs::read_dir(&p) else { continue };
                for m in rd.flatten() {
                    let n = m.file_name().to_string_lossy().to_string();
                    if META_SKIP.contains(&n.as_str()) {
                        continue;
                    }
                    if m.path().is_dir() {
                        files(&m.path(), &format!("{zp}/{n}/"), false, out);
                    } else {
                        out.push((m.path(), format!("{zp}/{n}")));
                    }
                }
                continue;
            }
            files(&p, &format!("{zp}/"), false, out);
        } else {
            out.push((p, zp));
        }
    }
}

/// Back up one folder (`folder` = its id) or the whole library (`folder` = None) into `target`.
/// `items` is the library's metadata for what is inside, as [{ id, kind, meta }]. Progress arrives
/// as `backup:progress` events ({ done, total } in files).
#[tauri::command]
pub async fn backup_tree_export(app: AppHandle, folder: Option<String>, title: String, items: Vec<Value>, target: String) -> Res<u64> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let store = state.store();
        let base = folder_dir(&store, folder.as_deref())?;
        // a folder goes in under its own name; the library's contents sit at the top
        let prefix = match &folder {
            Some(_) => format!("{}/", base.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Folder".into())),
            None => String::new(),
        };
        let mut list = vec![];
        files(&base, &prefix, folder.is_none(), &mut list);
        // the metadata of each item, keyed by where it is in the zip
        let mut meta = serde_json::Map::new();
        for it in &items {
            let Some(id) = it["id"].as_str() else { continue };
            let Some(p) = store.item_path(id) else { continue };
            let Ok(rest) = p.strip_prefix(&base) else { continue };
            let key = format!("{prefix}{}", rest.to_string_lossy().replace('\\', "/")).trim_end_matches('/').to_string();
            let key = if key.is_empty() { prefix.trim_end_matches('/').to_string() } else { key };
            meta.insert(key, json!({ "kind": it["kind"], "meta": it["meta"] }));
        }
        drop(store);
        let manifest = json!({
            "format": "goodink-backup",
            "version": 1,
            "kind": if folder.is_some() { "folder" } else { "library" },
            "title": title,
            "root": prefix.trim_end_matches('/'),
            "created": chrono::Utc::now().to_rfc3339(),
            "items": meta,
        });
        let tmp = PathBuf::from(format!("{target}.tmp"));
        let out = fs::File::create(&tmp).map_err(err)?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(out));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
        // already-compressed files are stored as they are
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
        let total = list.len() as u64;
        let mut bytes = 0u64;
        let write = |zip: &mut zip::ZipWriter<_>, bytes: &mut u64| -> Res<()> {
            for (i, (p, zp)) in list.iter().enumerate() {
                let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                let o = if matches!(ext.as_str(), "pdf" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "mp3" | "m4a" | "mp4" | "webm" | "zip" | "gink" | "docx" | "xlsx" | "pptx") { stored } else { opts };
                zip.start_file(zp.as_str(), o).map_err(err)?;
                let mut f = fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
                *bytes += std::io::copy(&mut f, zip).map_err(err)?;
                if i % 16 == 0 || i + 1 == list.len() {
                    let _ = app.emit("backup:progress", json!({ "done": i + 1, "total": total }));
                }
            }
            zip.start_file(MANIFEST, opts).map_err(err)?;
            zip.write_all(manifest.to_string().as_bytes()).map_err(err)?;
            Ok(())
        };
        let r = write(&mut zip, &mut bytes).and_then(|_| zip.finish().map(|_| ()).map_err(err));
        if let Err(e) = r {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        let _ = fs::remove_file(&target);
        fs::rename(&tmp, &target).map_err(err)?;
        Ok(bytes)
    })
    .await
    .map_err(err)?
}

/// What a .gink file holds: "notebook", "folder" or "library" (with its title), without unpacking it.
#[tauri::command]
pub fn backup_kind(file: String) -> Res<Value> {
    let f = fs::File::open(&file).map_err(err)?;
    let mut zip = zip::ZipArchive::new(f).map_err(|_| "Not a goodink backup".to_string())?;
    if let Ok(mut m) = zip.by_name(MANIFEST) {
        let mut s = String::new();
        m.read_to_string(&mut s).map_err(err)?;
        let v: Value = serde_json::from_str(&s).map_err(err)?;
        return Ok(json!({ "kind": v["kind"], "title": v["title"], "created": v["created"], "count": v["items"].as_object().map(|o| o.len()).unwrap_or(0) }));
    }
    if zip.by_name("meta.json").is_ok() {
        return Ok(json!({ "kind": "notebook" }));
    }
    Err("Not a goodink backup".into())
}

/// Restore a folder or library backup as a new folder inside `folder` (None = the top level).
/// Returns the scan of the library afterwards and, for every restored item, its id now and the
/// metadata it had: [{ id, kind, meta }], plus the new top folder's id.
#[tauri::command]
pub async fn backup_tree_import(app: AppHandle, file: String, folder: Option<String>, name: String) -> Res<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let f = fs::File::open(&file).map_err(err)?;
        let mut zip = zip::ZipArchive::new(std::io::BufReader::new(f)).map_err(|_| "Not a goodink backup".to_string())?;
        let manifest: Value = {
            let mut m = zip.by_name(MANIFEST).map_err(|_| "Not a folder or library backup".to_string())?;
            let mut s = String::new();
            m.read_to_string(&mut s).map_err(err)?;
            serde_json::from_str(&s).map_err(err)?
        };
        let library = manifest["kind"] == "library";
        let state = app.state::<AppState>();
        // exclusive: nothing moves while the restored tree is unpacked and scanned
        let store = state.store.write().unwrap_or_else(|e| e.into_inner());
        let dest = folder_dir(&store, folder.as_deref())?;
        // a library is unpacked into a folder named after it; a folder backup brings its own folder,
        // renamed when one of that name is already there
        let top_name = match manifest["root"].as_str() {
            Some(r) if !library && !r.is_empty() => r.to_string(),
            _ => tree::file_name(&name),
        };
        let top = unique_in(&dest, &top_name);
        let total = zip.len();
        for i in 0..total {
            let mut entry = zip.by_index(i).map_err(err)?;
            if entry.is_dir() || entry.name() == MANIFEST {
                continue;
            }
            // zip-slip guard: only entries that stay inside the restored folder
            let Some(rel) = entry.enclosed_name() else { continue };
            let rel = if library {
                // the old library's own files are not mixed into this one
                if rel.components().next().map(|c| c.as_os_str() == tree::META).unwrap_or(false) {
                    continue;
                }
                rel
            } else {
                let mut c = rel.components();
                c.next();
                c.as_path().to_path_buf()
            };
            if rel.as_os_str().is_empty() {
                continue;
            }
            let out = top.join(&rel);
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(err)?;
            }
            let mut w = fs::File::create(&out).map_err(err)?;
            std::io::copy(&mut entry, &mut w).map_err(err)?;
            if i % 16 == 0 || i + 1 == total {
                let _ = app.emit("backup:progress", json!({ "done": i + 1, "total": total }));
            }
        }
        fs::create_dir_all(&top).map_err(err)?;
        let scan = store.rescan();
        // match each item in the manifest with its id now, by where it is on disk
        let root = manifest["root"].as_str().unwrap_or_default().to_string();
        let mut restored = vec![];
        if let Some(items) = manifest["items"].as_object() {
            for (k, v) in items {
                let rest = if library || root.is_empty() {
                    k.as_str()
                } else if *k == root {
                    ""
                } else {
                    match k.strip_prefix(&format!("{root}/")) {
                        Some(r) => r,
                        None => continue,
                    }
                };
                let p = if rest.is_empty() { top.clone() } else { top.join(rest) };
                if let Some(id) = store.id_at(&p) {
                    restored.push(json!({ "id": id, "kind": v["kind"], "meta": v["meta"] }));
                }
            }
        }
        let top_id = store.id_at(&top);
        Ok(json!({ "scan": scan, "restored": restored, "top": top_id, "path": rel_of(&store.root, &top) }))
    })
    .await
    .map_err(err)?
}
