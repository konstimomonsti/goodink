//! goodink — Tauri backend. The UI (editor, ink engine, library) runs in WebView2; this side owns the
//! file system: notebooks, assets, search, OCR, backups, the notebooks-folder choice and app lifecycle.

mod ai;
mod backup;
mod hmer;
mod ink;
mod speech;
mod ocr;
mod onenote;
mod store;
mod tree;
mod uri;

use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use store::{copy_dir, safe_id, write_atomic, Res, Store};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// ---- startup timeline (epoch ms), reported to the page for the startup benchmark -----------------
static T_MAIN: AtomicU64 = AtomicU64::new(0);
static T_SETUP: AtomicU64 = AtomicU64::new(0);
static T_BUILT: AtomicU64 = AtomicU64::new(0);
static T_SHOWN: AtomicU64 = AtomicU64::new(0);
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---- app state ------------------------------------------------------------------------------------

struct AppState {
    store: RwLock<Store>,
    pending_open: Mutex<Vec<String>>,
    flushed: AtomicBool,
}

impl AppState {
    fn store(&self) -> std::sync::RwLockReadGuard<'_, Store> {
        self.store.read().unwrap_or_else(|e| e.into_inner())
    }
}

/// %APPDATA%\goodink — the same folder the Electron version used, so existing notebooks and the
/// chosen notebooks folder carry over. Tests can point it elsewhere with GOODINK_PROFILE.
fn profile_dir() -> PathBuf {
    if let Ok(p) = std::env::var("GOODINK_PROFILE") {
        return PathBuf::from(p);
    }
    #[cfg(target_os = "android")]
    return android_files_dir();
    #[allow(unreachable_code)]
    let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    base.join("goodink")
}

/// Android: the app's private files folder, /data/user/0/<package>/files. Known before Tauri starts
/// (the store opens first), so it comes from the process name, which Android sets to the package.
#[cfg(target_os = "android")]
fn android_files_dir() -> PathBuf {
    let pkg = fs::read("/proc/self/cmdline")
        .ok()
        .map(|b| String::from_utf8_lossy(b.split(|c| *c == 0).next().unwrap_or_default()).split(':').next().unwrap_or_default().to_string())
        .filter(|p| !p.is_empty() && !p.contains('/'))
        .unwrap_or_else(|| "app.goodink.notes".into());
    PathBuf::from(format!("/data/user/0/{pkg}/files"))
}

fn config_file() -> PathBuf {
    profile_dir().join("config.json")
}

fn library_chosen() -> bool {
    if std::env::var("GOODINK_LIBRARY").is_ok() {
        return true;
    }
    fs::read_to_string(config_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|c| c["libraryPath"].as_str().map(|s| !s.is_empty()).unwrap_or(false))
        .unwrap_or(false)
}

fn library_root() -> PathBuf {
    if let Some(p) = fs::read_to_string(config_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|c| c["libraryPath"].as_str().map(PathBuf::from))
    {
        if p.exists() {
            return p;
        }
    }
    if let Ok(p) = std::env::var("GOODINK_LIBRARY") {
        return PathBuf::from(p);
    }
    // the hidden library of older installs stays where it is
    let old = profile_dir().join("library");
    if old.exists() || cfg!(target_os = "android") {
        return old;
    }
    home_folder().unwrap_or(old)
}

/// A new install's home folder: "goodink" in Documents, where it can be seen and backed up.
fn home_folder() -> Option<PathBuf> {
    let docs = std::env::var("USERPROFILE").ok().map(|u| PathBuf::from(u).join("Documents")).filter(|d| d.is_dir())?;
    Some(docs.join("goodink"))
}

/// Problems a user can send us. Never fails.
pub(crate) fn log(msg: &str) {
    let line = format!("{} {msg}\n", chrono::Local::now().format("%Y-%m-%dT%H:%M:%S"));
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(profile_dir().join("goodink.log")) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn header(req: &Request, name: &str) -> Res<String> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing header {name}"))
}

fn raw_body<'a>(req: &'a Request) -> Res<&'a [u8]> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b),
        _ => Err("expected raw body".into()),
    }
}

// ---- documents ------------------------------------------------------------------------------------

#[tauri::command]
fn doc_read(state: State<AppState>, name: String) -> Res<Option<String>> {
    let allowed = ["library.json", "settings.json", "elements.json", "study.json"];
    if !allowed.contains(&name.as_str()) {
        return Err("unknown document".into());
    }
    Ok(state.store().read_doc(&name))
}

#[tauri::command]
fn doc_write(state: State<AppState>, name: String, json: String) -> Res<()> {
    let allowed = ["library.json", "settings.json", "elements.json", "study.json"];
    if !allowed.contains(&name.as_str()) {
        return Err("unknown document".into());
    }
    state.store().write_doc(&name, &json)
}

/// Everything the library screen needs at startup, in one IPC round trip.
#[tauri::command]
fn boot(state: State<AppState>) -> Value {
    let store = state.store();
    let pending = std::mem::take(&mut *state.pending_open.lock().unwrap_or_else(|e| e.into_inner()));
    serde_json::json!({
        "library": store.read_doc("library.json"),
        "settings": store.read_doc("settings.json"),
        "elements": store.read_doc("elements.json"),
        "info": { "path": store.root.to_string_lossy(), "chosen": library_chosen() },
        "pending": pending,
        "devices": input_devices(),
        "timeline": { "main": T_MAIN.load(Ordering::Relaxed), "setup": T_SETUP.load(Ordering::Relaxed), "built": T_BUILT.load(Ordering::Relaxed), "shown": T_SHOWN.load(Ordering::Relaxed) },
    })
}

/// Which digitizers does Windows report? (pen: built-in or external pen/tablet; touch: touchscreen)
fn input_devices() -> Value {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_DIGITIZER, SM_MAXIMUMTOUCHES};
        let d = GetSystemMetrics(SM_DIGITIZER);
        let (integrated_touch, external_touch, integrated_pen, external_pen) = (d & 0x01 != 0, d & 0x02 != 0, d & 0x04 != 0, d & 0x08 != 0);
        return serde_json::json!({
            "pen": integrated_pen || external_pen,
            "touch": integrated_touch || external_touch,
            "maxTouches": GetSystemMetrics(SM_MAXIMUMTOUCHES),
        });
    }
    #[allow(unreachable_code)]
    serde_json::json!({ "pen": false, "touch": false, "maxTouches": 0 })
}

/// Windows "app mode" setting: is the system in dark mode?
fn system_dark() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::core::w;
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let mut value: u32 = 1;
        let mut size = std::mem::size_of::<u32>() as u32;
        let ok = RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        );
        return ok.is_ok() && value == 0;
    }
    #[allow(unreachable_code)]
    false
}

/// Theme from settings.json, so the window opens in the right colours (no white flash).
fn startup_theme(store: &Store) -> (Option<tauri::Theme>, bool) {
    let pref = store
        .read_doc("settings.json")
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["theme"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "system".into());
    match pref.as_str() {
        "dark" => (Some(tauri::Theme::Dark), true),
        "light" => (Some(tauri::Theme::Light), false),
        _ => (None, system_dark()),
    }
}

#[tauri::command]
fn nb_load(state: State<AppState>, id: String) -> Res<Option<String>> {
    state.store().load_notebook(&id)
}

#[tauri::command]
fn nb_save(state: State<AppState>, id: String, json: String) -> Res<()> {
    state.store().save_notebook(&id, &json)
}

#[tauri::command]
fn nb_delete(state: State<AppState>, id: String) -> Res<()> {
    state.store().delete_notebook(&id)
}

#[tauri::command]
fn nb_duplicate(state: State<AppState>, from: String, to: String) -> Res<()> {
    state.store().duplicate_notebook(&from, &to)
}

#[tauri::command]
fn index_load(state: State<AppState>, id: String) -> Res<Option<String>> {
    state.store().load_index(&id)
}

#[tauri::command]
fn index_save(state: State<AppState>, id: String, json: String) -> Res<()> {
    state.store().save_index(&id, &json)
}

#[tauri::command]
fn page_load(state: State<AppState>, nb: String, page: String) -> Res<Option<String>> {
    state.store().load_page(&nb, &page)
}

#[tauri::command]
fn page_save(state: State<AppState>, nb: String, page: String, json: String) -> Res<()> {
    state.store().save_page(&nb, &page, &json)
}

#[tauri::command]
fn search(state: State<AppState>, q: String) -> Value {
    state.store().search(&q, 200)
}

// ---- binary data (raw IPC bodies, no JSON encoding of bytes) -----------------------------------

#[tauri::command]
fn asset_put(state: State<AppState>, request: Request) -> Res<String> {
    let nb = header(&request, "nb")?;
    let ext = header(&request, "ext")?;
    state.store().put_asset(&nb, raw_body(&request)?, &ext)
}

#[tauri::command]
fn asset_get(state: State<AppState>, nb: String, id: String, ext: String) -> Res<Response> {
    Ok(Response::new(state.store().get_asset(&nb, &id, &ext)?))
}

/// Files added to Study as resources (PDFs), kept in the library folder under study/files.
#[tauri::command]
fn study_file_put(state: State<AppState>, request: Request) -> Res<String> {
    let ext = header(&request, "ext")?;
    state.store().put_study_file(raw_body(&request)?, &ext)
}

#[tauri::command]
fn study_file_get(state: State<AppState>, id: String, ext: String) -> Res<Response> {
    Ok(Response::new(state.store().get_study_file(&id, &ext)?))
}

#[tauri::command]
fn thumb_save(state: State<AppState>, request: Request) -> Res<()> {
    let nb = header(&request, "nb")?;
    state.store().save_thumb(&nb, raw_body(&request)?)
}

#[tauri::command]
fn thumb_get(state: State<AppState>, nb: String) -> Res<Response> {
    Ok(Response::new(state.store().get_thumb(&nb)?))
}

#[tauri::command]
fn file_read(path: String) -> Res<Response> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 1024 * 1024 * 1024 {
        return Err("File is larger than 1 GB".into());
    }
    Ok(Response::new(fs::read(&path).map_err(|e| e.to_string())?))
}

#[tauri::command]
fn file_write(request: Request) -> Res<()> {
    let path = header(&request, "path")?;
    let path = PathBuf::from(decode_header(&path));
    // exports into a tree of folders (one PDF per notebook) make the folders on the way
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, raw_body(&request)?).map_err(|e| e.to_string())
}

/// Files dropped onto the window arrive as bytes; park them in a temp file so the path-based
/// import code can treat them like files picked in a dialog.
#[tauri::command]
fn temp_file(request: Request) -> Res<String> {
    let name = decode_header(&header(&request, "name")?);
    let clean: String = name.chars().filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    let dir = std::env::temp_dir().join("goodink-drops");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}-{}", std::process::id(), if clean.is_empty() { "file".into() } else { clean }));
    fs::write(&file, raw_body(&request)?).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

fn decode_header(v: &str) -> String {
    // headers carry percent-encoded UTF-8 so non-ASCII file names survive
    let bytes = v.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&v[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[tauri::command]
async fn ocr(request: Request<'_>) -> Res<Vec<ocr::OcrWord>> {
    let png = raw_body(&request)?.to_vec();
    tauri::async_runtime::spawn_blocking(move || ocr::recognize(&png)).await.map_err(|e| e.to_string())?
}

// ---- the folder tree on disk ------------------------------------------------------------------------

/// Save the library and make the disk match it (folders, notebook folders, .url files, trash).
/// Returns what is on disk afterwards, for changes made in Explorer.
#[tauri::command]
async fn library_save(state: State<'_, AppState>, json: String) -> Res<Value> {
    let lib: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    // exclusive: no page is written while notebook folders move
    let store = state.store.write().unwrap_or_else(|e| e.into_inner());
    store.write_doc("library.json", &json)?;
    Ok(store.sync(&lib))
}

#[tauri::command]
async fn library_scan(state: State<'_, AppState>) -> Res<Value> {
    Ok(state.store().rescan())
}

fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..).map(|k| dir.join(format!("{stem} ({k}){ext}"))).find(|p| !p.exists()).unwrap_or(p)
}

fn folder_dir(store: &Store, folder: Option<&str>) -> Res<PathBuf> {
    match folder {
        None => Ok(store.root.clone()),
        Some(id) => store.item_path(id).filter(|p| p.is_dir()).ok_or_else(|| "That folder is not on disk.".to_string()),
    }
}

/// Open a file of the library with its usual app.
#[tauri::command]
fn file_open(app: AppHandle, state: State<AppState>, rel: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = tree::user_file(&state.store().root, &rel)?;
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Show a file (by path) or a folder, notebook or link (by id) in Explorer.
#[tauri::command]
fn item_reveal(app: AppHandle, state: State<AppState>, rel: Option<String>, id: Option<String>) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let store = state.store();
    let p = match (rel, id) {
        (Some(r), _) => tree::user_file(&store.root, &r)?,
        (None, Some(id)) => store.item_path(&id).ok_or("not on disk")?,
        _ => store.root.clone(),
    };
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_rename(state: State<AppState>, rel: String, name: String) -> Res<String> {
    let store = state.store();
    let from = tree::user_file(&store.root, &rel)?;
    let clean = tree::file_name(&name);
    if clean != name.trim() {
        return Err(r#"A file name cannot contain \ / : * ? " < > |"#.into());
    }
    let to = from.with_file_name(&clean);
    if to.exists() && !to.to_string_lossy().eq_ignore_ascii_case(&from.to_string_lossy()) {
        return Err("A file with that name is already there.".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(rel_of(&store.root, &to))
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

#[tauri::command]
fn file_move(state: State<AppState>, rel: String, folder: Option<String>) -> Res<String> {
    let store = state.store();
    let from = tree::user_file(&store.root, &rel)?;
    let dir = folder_dir(&store, folder.as_deref())?;
    if from.parent().map(|p| p == dir).unwrap_or(false) {
        return Ok(rel);
    }
    let to = unique_in(&dir, &from.file_name().ok_or("bad path")?.to_string_lossy());
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(rel_of(&store.root, &to))
}

/// Copy files from elsewhere into a folder of the library.
#[tauri::command]
fn file_import(state: State<AppState>, paths: Vec<String>, folder: Option<String>) -> Res<Vec<String>> {
    let store = state.store();
    let dir = folder_dir(&store, folder.as_deref())?;
    let mut out = vec![];
    for src in paths {
        let src = PathBuf::from(src);
        if !src.is_file() {
            continue;
        }
        let to = unique_in(&dir, &src.file_name().ok_or("bad path")?.to_string_lossy());
        fs::copy(&src, &to).map_err(|e| e.to_string())?;
        out.push(rel_of(&store.root, &to));
    }
    Ok(out)
}

/// Into the Windows Recycle Bin (files goodink did not make are never deleted outright).
#[tauri::command]
fn file_trash(state: State<AppState>, rel: String) -> Res<()> {
    let p = tree::user_file(&state.store().root, &rel)?;
    recycle(&p)
}

#[cfg(windows)]
fn recycle(p: &Path) -> Res<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    let from: Vec<u16> = p.as_os_str().encode_wide().chain([0, 0]).collect();
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0) as u16,
        ..Default::default()
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if r == 0 && !op.fAnyOperationsAborted.as_bool() { Ok(()) } else { Err(format!("Could not move it to the Recycle Bin (error {r}).")) }
}

#[cfg(not(windows))]
fn recycle(p: &Path) -> Res<()> {
    fs::remove_file(p).map_err(|e| e.to_string())
}

// ---- notebooks folder ------------------------------------------------------------------------------

#[tauri::command]
fn library_info(state: State<AppState>) -> Value {
    serde_json::json!({ "path": state.store().root.to_string_lossy(), "chosen": library_chosen() })
}

/// Pick where notebooks live. None = keep the current folder. A folder that already holds a goodink
/// library is used as-is; otherwise the library is copied into "<folder>\goodink Notebooks". The
/// switch happens in place and the window reloads — no restart.
#[tauri::command]
fn library_choose(app: AppHandle, state: State<AppState>, folder: Option<String>) -> Value {
    let current = state.store().root.clone();
    let save_cfg = |p: &Path| {
        let _ = fs::create_dir_all(profile_dir());
        let _ = write_atomic(&config_file(), serde_json::json!({ "libraryPath": p.to_string_lossy() }).to_string().as_bytes());
    };
    let Some(folder) = folder else {
        save_cfg(&current);
        return serde_json::json!({ "relaunch": false, "path": current.to_string_lossy() });
    };
    let folder = PathBuf::from(folder);
    let is_library = |p: &Path| p.join(tree::META).join("library.json").exists() || p.join("library.json").exists();
    let target = if is_library(&folder) { folder } else { folder.join("goodink Notebooks") };
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
    if norm(&target) == norm(&current) {
        save_cfg(&current);
        return serde_json::json!({ "relaunch": false, "path": current.to_string_lossy() });
    }
    if norm(&target).starts_with(&(norm(&current) + "\\")) {
        return serde_json::json!({ "error": "Choose a folder outside the current notebooks folder." });
    }
    let result = (|| -> Res<()> {
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        if !is_library(&target) {
            copy_dir(&current, &target)?;
        }
        let next = Store::new(target.clone())?;
        *state.store.write().unwrap_or_else(|e| e.into_inner()) = next;
        save_cfg(&target);
        Ok(())
    })();
    match result {
        Ok(()) => {
            log(&format!("library moved to {}", target.display()));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("setTimeout(() => location.reload(), 50)");
            }
            serde_json::json!({ "relaunch": true, "path": target.to_string_lossy() })
        }
        Err(e) => {
            log(&format!("library move failed: {e}"));
            serde_json::json!({ "error": e })
        }
    }
}

// ---- backups (.gink = zip of the notebook folder + meta.json) -------------------------------------

#[tauri::command]
fn backup_export(state: State<AppState>, nb: String, meta: Value, target: String) -> Res<()> {
    let dir = state.store().nb_dir(&nb)?;
    let file = fs::File::create(&target).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    fn walk(zip: &mut zip::ZipWriter<fs::File>, base: &Path, dir: &Path, opts: zip::write::SimpleFileOptions) -> Res<()> {
        for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                walk(zip, base, &p, opts)?;
            } else if !rel.ends_with(".tmp") {
                zip.start_file(rel, opts).map_err(|e| e.to_string())?;
                zip.write_all(&fs::read(&p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    walk(&mut zip, &dir, &dir, opts)?;
    zip.start_file("meta.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(meta.to_string().as_bytes()).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn backup_import(state: State<AppState>, file: String, new_id: String) -> Res<Value> {
    safe_id(&new_id)?;
    let f = fs::File::open(&file).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|_| "Not a goodink backup".to_string())?;
    let meta: Value = {
        let mut m = zip.by_name("meta.json").map_err(|_| "Not a goodink backup".to_string())?;
        let mut s = String::new();
        m.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())?
    };
    let store = state.store();
    let dir = store.nb_dir(&new_id)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() || entry.name() == "meta.json" {
            continue;
        }
        // zip-slip guard: only entries that stay inside the notebook folder
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dir.join(rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&out, buf).map_err(|e| e.to_string())?;
    }
    if let Some(text) = store.load_notebook(&new_id)? {
        if let Ok(mut doc) = serde_json::from_str::<Value>(&text) {
            doc["id"] = Value::String(new_id.clone());
            store.save_notebook(&new_id, &doc.to_string())?;
        }
    }
    Ok(meta)
}

// ---- gink:// — files straight from disk to the page ------------------------------------------------
//
// http://gink.localhost/thumb/<notebook>            cover thumbnail (lazy <img>, no IPC)
// http://gink.localhost/asset/<notebook>/<id>.<ext>  PDFs/images/audio, with HTTP Range support so
//                                                    pdf.js reads only the 64 KB pieces it needs
// Assets are content-addressed, so they can be cached forever.

fn mime(ext: &str) -> &'static str {
    match ext {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn serve_file(path: &Path, range: Option<&str>, content_type: &str, immutable: bool) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let builder = tauri::http::Response::builder()
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", if immutable { "max-age=31536000, immutable" } else { "no-cache" });
    let Ok(mut f) = fs::File::open(path) else {
        return builder.status(404).body(Vec::new()).unwrap();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let parsed = range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| {
        let (a, b) = r.split_once('-')?;
        let start: u64 = a.trim().parse().ok()?;
        let end: u64 = if b.trim().is_empty() { len.saturating_sub(1) } else { b.trim().parse().ok()? };
        (start <= end && start < len).then_some((start, end.min(len.saturating_sub(1))))
    });
    match parsed {
        Some((start, end)) => {
            let mut buf = vec![0u8; (end - start + 1) as usize];
            if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut buf)).is_err() {
                return builder.status(416).body(Vec::new()).unwrap();
            }
            builder
                .status(206)
                .header("Content-Type", content_type)
                .header("Content-Range", format!("bytes {start}-{end}/{len}"))
                .header("Content-Length", buf.len().to_string())
                .body(buf)
                .unwrap()
        }
        None => {
            let mut buf = Vec::with_capacity(len as usize);
            let _ = f.read_to_end(&mut buf);
            builder.status(200).header("Content-Type", content_type).header("Content-Length", buf.len().to_string()).body(buf).unwrap()
        }
    }
}

fn gink_protocol(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let path = request.uri().path().trim_start_matches('/').to_string();
    let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let parts: Vec<&str> = path.split('/').collect();
    let not_found = || tauri::http::Response::builder().status(404).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap();
    match parts.as_slice() {
        ["thumb", nb] => match state.store().nb_dir(nb) {
            Ok(dir) => serve_file(&dir.join("thumb.png"), None, "image/png", false),
            Err(_) => not_found(),
        },
        ["asset", nb, file] => {
            let Some((id, ext)) = file.rsplit_once('.') else { return not_found() };
            if safe_id(id).is_err() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                return not_found();
            }
            match state.store().nb_dir(nb) {
                Ok(dir) => serve_file(&dir.join("assets").join(format!("{id}.{ext}")), range.as_deref(), mime(ext), true),
                Err(_) => not_found(),
            }
        }
        _ => not_found(),
    }
}

// ---- lifecycle ------------------------------------------------------------------------------------

#[tauri::command]
fn pending_open(state: State<AppState>) -> Vec<String> {
    std::mem::take(&mut *state.pending_open.lock().unwrap_or_else(|e| e.into_inner()))
}

/// The renderer saved everything after an `app:flush` request; now really close.
#[tauri::command]
fn app_flushed(app: AppHandle, state: State<AppState>) {
    state.flushed.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.destroy();
    }
}

#[tauri::command]
fn devtools(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_devtools_open() { w.close_devtools() } else { w.open_devtools() }
    }
}

/// Ask WebView2 to trim its caches (GPU tiles, decoded images, script caches) while the app is idle
/// or in the background; back to normal on the next input. Nothing visible is dropped.
fn set_memory_mode(app: &AppHandle, low: bool) {
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.with_webview(move |pw| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows::core::Interface;
            if let Ok(core) = pw.controller().CoreWebView2() {
                if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                    let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                    let _ = c19.SetMemoryUsageTargetLevel(level);
                }
            }
        });
    }
}

#[tauri::command]
fn memory_mode(app: AppHandle, low: bool) {
    set_memory_mode(&app, low);
}

#[tauri::command]
fn is_test() -> bool {
    std::env::var("GOODINK_TEST").map(|v| v == "1").unwrap_or(false)
}

fn files_from_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| {
            let l = a.to_lowercase();
            (l.ends_with(".gink") || l.ends_with(".pdf")) && Path::new(a).exists()
        })
        .cloned()
        .collect()
}

fn web_url(url: &str) -> Res<tauri::Url> {
    let u = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    if u.scheme() == "https" || u.scheme() == "http" { Ok(u) } else { Err("only web pages can be shown".into()) }
}

fn web_label(label: &str, prefix: &str) -> Res<()> {
    let ok = label.starts_with(prefix) && label.len() <= 64 && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(()) } else { Err("bad label".into()) }
}

/// A web page shown inside the main window. Built here because WebView2 refuses a second webview
/// in this process with other browser switches than the main one, and the JS API cannot pass them.
/// Remote pages get no IPC: the capabilities only cover goodink's own pages.
#[tauri::command]
async fn web_preview_create(app: AppHandle, label: String, url: String, x: f64, y: f64, width: f64, height: f64) -> Res<()> {
    web_label(&label, "preview-")?;
    #[cfg(desktop)]
    {
        let win = app.get_window("main").ok_or("no main window")?;
        let b = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(web_url(&url)?)).additional_browser_args(&browser_args()).focused(false);
        win.add_child(b, tauri::LogicalPosition::new(x, y), tauri::LogicalSize::new(width.max(1.0), height.max(1.0))).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = (app, url, x, y, width, height);
        Err("web previews are not available on this device".into())
    }
}

/// The presentation window (a notebook page on another screen), with the main window's switches.
#[tauri::command]
async fn present_open(app: AppHandle, x: Option<f64>, y: Option<f64>, width: f64, height: f64, fullscreen: bool) -> Res<()> {
    if let Some(w) = app.get_webview_window("present") {
        let _ = w.set_focus();
        return Ok(());
    }
    #[cfg(desktop)]
    {
        let mut b = WebviewWindowBuilder::new(&app, "present", WebviewUrl::App("index.html#present".into()))
            .title("goodink — Presentation")
            .inner_size(width, height)
            .fullscreen(fullscreen)
            .background_color(tauri::window::Color(0, 0, 0, 0xff))
            .additional_browser_args(&browser_args());
        if let (Some(x), Some(y)) = (x, y) {
            b = b.position(x, y);
        }
        b.build().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = (x, y, width, height, fullscreen);
        Err("presenting on another screen is not available on this device".into())
    }
}

/// A web page in a goodink window of its own.
#[tauri::command]
async fn web_window_open(app: AppHandle, label: String, url: String, title: String) -> Res<()> {
    web_label(&label, "web-")?;
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    #[cfg(desktop)]
    {
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(web_url(&url)?))
            .title(format!("{title} — goodink"))
            .inner_size(1200.0, 860.0)
            .center()
            .additional_browser_args(&browser_args())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(mobile)]
    {
        // Android: hand the page to the system browser
        let _ = title;
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(web_url(&url)?.as_str(), None::<&str>).map_err(|e| e.to_string())
    }
}

/// Chromium switches for WebView2. Overriding the defaults means restating Tauri's own ones.
fn browser_args() -> String {
    let mut a = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --enable-features=CanvasOopRasterization,PointerRawUpdate \
         --enable-gpu-rasterization --disable-renderer-backgrounding --disable-background-timer-throttling",
    );
    // diagnostics: try extra engine switches without a rebuild
    if let Ok(extra) = std::env::var("GOODINK_EXTRA_ARGS") {
        a.push(' ');
        a.push_str(&extra);
    }
    if let Ok(port) = std::env::var("GOODINK_CDP_PORT") {
        a.push_str(&format!(" --remote-debugging-port={port}"));
    }
    a
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    T_MAIN.store(now_ms(), Ordering::Relaxed);
    #[cfg(target_os = "android")]
    {
        // /data/local/tmp (std's default) is not writable for apps
        let tmp = android_files_dir().with_file_name("cache");
        let _ = fs::create_dir_all(&tmp);
        std::env::set_var("TMPDIR", tmp);
    }
    let test = is_test();
    let store = match Store::new(library_root()) {
        Ok(s) => s,
        Err(e) => {
            log(&format!("cannot open library: {e}"));
            Store::new(std::env::temp_dir().join("goodink-fallback")).expect("fallback library")
        }
    };
    let initial_files = files_from_args(&std::env::args().collect::<Vec<_>>());

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(uri::plugin());
    }
    #[cfg(desktop)]
    if !test {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files = files_from_args(&args);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
                if !files.is_empty() {
                    let _ = w.emit("app:open-files", files);
                }
            }
        }));
    }
    builder
        .register_asynchronous_uri_scheme_protocol("gink", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // disk reads off the UI thread
            std::thread::spawn(move || responder.respond(gink_protocol(&app, &request)));
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { store: RwLock::new(store), pending_open: Mutex::new(initial_files), flushed: AtomicBool::new(false) })
        .invoke_handler(tauri::generate_handler![
            doc_read, doc_write, nb_load, nb_save, nb_delete, nb_duplicate, index_load, index_save, page_load, page_save, search,
            asset_put, asset_get, thumb_save, thumb_get, file_read, file_write, temp_file, ocr, library_info, library_choose,
            backup_export, backup_import, pending_open, app_flushed, devtools, is_test, memory_mode, boot,
            ai::secret_set, ai::secret_has, ai::secret_delete, ai::ai_fetch, ai::ai_fetch_stream, ai::ai_fetch_cancel, study_file_put, study_file_get, web_preview_create, web_window_open, present_open,
            library_save, library_scan, file_open, item_reveal, file_rename, file_move, file_import, file_trash,
            ink::ink_analyze, speech::speech_start, speech::speech_stop,
            hmer::hmer_recognize, hmer::hmer_status, hmer::hmer_install,
            backup::backup_tree_export, backup::backup_tree_import, backup::backup_kind, onenote::onenote_import, uri::uri_import, uri::uri_export
        ])
        .setup(move |app| {
            T_SETUP.store(now_ms(), Ordering::Relaxed);
            ink::init(); // load the handwriting recogniser on its own thread
            let url = if test { "index.html?test=1" } else { "index.html" };
            let (theme, dark) = startup_theme(&app.state::<AppState>().store());
            let bg = if dark { tauri::window::Color(0x12, 0x12, 0x14, 0xff) } else { tauri::window::Color(0xf2, 0xf2, 0xf5, 0xff) };
            #[cfg(mobile)]
            {
                let _ = (test, theme);
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into())).background_color(bg).build()?;
            }
            #[cfg(desktop)]
            {
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
                .theme(theme)
                .background_color(bg)
                .title("goodink")
                .inner_size(1440.0, 940.0)
                .min_inner_size(760.0, 520.0)
                .decorations(false)
                .shadow(true)
                // the window appears at once in the right colours while WebView2 starts inside it
                .visible(true)
                .maximized(!test)
                .disable_drag_drop_handler() // keep HTML5 drag & drop (folders, page reordering) working
                // WebView2 only passes touchpad pinches on to the page (as Ctrl+wheel) while its zoom is
                // enabled; the page then zooms the notebook and keeps the window itself from zooming
                .zoom_hotkeys_enabled(true)
                .additional_browser_args(&browser_args());
            if test {
                // keep automated runs off the user's screen so real pen/mouse input can't leak in
                b = b.position(-6000.0, 0.0).focused(false);
            }
            let _win = b.build()?;
            }
            T_BUILT.store(now_ms(), Ordering::Relaxed);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            // first event of the main window = it exists on screen (startup timeline)
            let _ = T_SHOWN.compare_exchange(0, now_ms(), Ordering::Relaxed, Ordering::Relaxed);
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let state = window.state::<AppState>();
                    if !state.flushed.load(Ordering::SeqCst) {
                        // give the renderer a moment to save unsaved ink, then close regardless
                        api.prevent_close();
                        let _ = window.emit("app:flush", ());
                        let w = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            let _ = w.destroy();
                        });
                    }
                }
                // in the background the app gives its caches back; the first input brings them back
                WindowEvent::Focused(focused) if !is_test() => set_memory_mode(window.app_handle(), !*focused),
                WindowEvent::Destroyed => {
                    if let Some(p) = window.app_handle().get_webview_window("present") {
                        let _ = p.destroy();
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| log(&format!("fatal: {e}")));
}
