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

#[tauri::command]
pub async fn ai_fetch(req: AiRequest) -> Res<AiResponse> {
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
    let res = b.send().await.map_err(|e| format!("Could not reach the AI provider: {e}"))?;
    let status = res.status().as_u16();
    let headers = res.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string()))).collect();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(AiResponse { status, headers, body })
}
