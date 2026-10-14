// AI provider plumbing. API keys live in the Windows Credential Manager and never reach the web
// view: the UI sends requests with a placeholder where the key goes, and this module swaps the
// real key in on the way out. Requests go out from here, so provider CORS rules never apply.
use crate::store::Res;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const SERVICE: &str = "goodink";
const SECRET_MARK: &str = "__GOODINK_SECRET__";

fn entry(name: &str) -> Res<keyring::Entry> {
    let ok = !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err("bad secret name".into());
    }
    keyring::Entry::new(SERVICE, &format!("ai-{name}")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Res<()> {
    let v = value.trim();
    if v.is_empty() {
        return Err("The key is empty.".into());
    }
    entry(&name)?.set_password(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_has(names: Vec<String>) -> Vec<String> {
    names.into_iter().filter(|n| entry(n).and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()).collect()
}

#[tauri::command]
pub fn secret_delete(name: String) -> Res<()> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Deserialize)]
pub struct AiRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    /** which saved key replaces the placeholder in the headers */
    secret: Option<String>,
}

#[derive(Serialize)]
pub struct AiResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn allowed_url(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    match u.scheme() {
        "https" => true,
        // local model servers such as Ollama or LM Studio
        "http" => matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

/// The request with the saved key swapped in, ready to send.
fn build(req: AiRequest) -> Res<reqwest::RequestBuilder> {
    if !allowed_url(&req.url) {
        return Err("Only https addresses (or a model server on this PC) can be used.".into());
    }
    let secret = match &req.secret {
        Some(n) => Some(entry(n)?.get_password().map_err(|_| "No API key is saved for this provider. Add one in Settings → AI.".to_string())?),
        None => None,
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30 * 60)).build().map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut b = client.request(method, &req.url);
    for (k, v) in req.headers {
        let k = k.to_lowercase();
        if matches!(k.as_str(), "host" | "content-length" | "connection" | "accept-encoding") {
            continue;
        }
        let v = match &secret {
            Some(s) => v.replace(SECRET_MARK, s),
            None => v,
        };
        b = b.header(k, v);
    }
    if let Some(body) = req.body {
        b = b.body(body);
    }
    Ok(b)
}

fn head_of(res: &reqwest::Response) -> (u16, Vec<(String, String)>) {
    (res.status().as_u16(), res.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string()))).collect())
}

#[tauri::command]
pub async fn ai_fetch(req: AiRequest) -> Res<AiResponse> {
    let res = build(req)?.send().await.map_err(|e| format!("Could not reach the AI provider: {e}"))?;
    let (status, headers) = head_of(&res);
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(AiResponse { status, headers, body })
}

// ---- streaming --------------------------------------------------------------------------------
//
// ai_fetch_stream sends the response as it arrives: first the status and headers, then the body
// in chunks (server-sent events from the providers), then the end. The web view builds a fetch
// Response with a ReadableStream body from these events, so the SDKs stream for real.
// ai_fetch_cancel aborts the task, which drops the connection to the provider.

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Head { status: u16, headers: Vec<(String, String)> },
    Chunk { text: String },
    End,
    Error { message: String },
}

fn streams() -> &'static std::sync::Mutex<std::collections::HashMap<u32, tauri::async_runtime::JoinHandle<()>>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, tauri::async_runtime::JoinHandle<()>>>> = std::sync::OnceLock::new();
    S.get_or_init(Default::default)
}

async fn pump(b: reqwest::RequestBuilder, ch: &tauri::ipc::Channel<StreamEvent>) -> Res<()> {
    let mut res = b.send().await.map_err(|e| format!("Could not reach the AI provider: {e}"))?;
    let (status, headers) = head_of(&res);
    ch.send(StreamEvent::Head { status, headers }).map_err(|e| e.to_string())?;
    // chunks can split a UTF-8 character: hold back the incomplete tail until the next chunk
    let mut pending: Vec<u8> = Vec::new();
    while let Some(bytes) = res.chunk().await.map_err(|e| format!("The AI provider stopped answering: {e}"))? {
        pending.extend_from_slice(&bytes);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid > 0 {
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            ch.send(StreamEvent::Chunk { text }).map_err(|e| e.to_string())?;
        }
    }
    if !pending.is_empty() {
        ch.send(StreamEvent::Chunk { text: String::from_utf8_lossy(&pending).into_owned() }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Starts a streamed request; events arrive on `on_event`. Returns once the request is under way.
#[tauri::command]
pub fn ai_fetch_stream(id: u32, req: AiRequest, on_event: tauri::ipc::Channel<StreamEvent>) -> Res<()> {
    let b = build(req)?;
    // hold the map while spawning, so a task that ends at once still finds its own entry to remove
    let mut map = streams().lock().unwrap();
    let task = tauri::async_runtime::spawn(async move {
        let ev = match pump(b, &on_event).await {
            Ok(()) => StreamEvent::End,
            Err(message) => StreamEvent::Error { message },
        };
        let _ = on_event.send(ev);
        streams().lock().unwrap().remove(&id);
    });
    map.insert(id, task);
    Ok(())
}

/// Aborts a streamed request (the connection to the provider is dropped).
#[tauri::command]
pub fn ai_fetch_cancel(id: u32) {
    if let Some(task) = streams().lock().unwrap().remove(&id) {
        task.abort();
    }
}
