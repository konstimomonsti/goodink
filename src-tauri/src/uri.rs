//! Android's system file picker hands out content:// URIs instead of paths. These commands bridge to
//! FilesPlugin.kt (gen/android): a picked file is copied into the app's cache under its real name,
//! and an export written to a cache file is copied to the place picked. Desktop has real paths and
//! never calls them.

use crate::store::Res;
use tauri::AppHandle;

#[cfg(target_os = "android")]
pub struct Files(pub tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Manager;
    tauri::plugin::Builder::new("gifiles")
        .setup(|app, api| {
            let h = api.register_android_plugin("app.goodink.notes", "FilesPlugin")?;
            app.manage(Files(h));
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn run<T: serde::de::DeserializeOwned + Send + 'static>(app: AppHandle, cmd: &'static str, args: serde_json::Value) -> impl std::future::Future<Output = Res<T>> {
    use tauri::Manager;
    async move {
        tauri::async_runtime::spawn_blocking(move || app.state::<Files>().0.run_mobile_plugin::<T>(cmd, args).map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?
    }
}

/// A picked content:// file as a path in the app's cache, under the name it has on the device.
#[tauri::command]
pub async fn uri_import(app: AppHandle, uri: String) -> Res<String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Out {
            path: String,
        }
        let out: Out = run(app, "importUri", serde_json::json!({ "uri": uri })).await?;
        Ok(out.path)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, uri);
        Err("only needed on Android".into())
    }
}

/// Copy a finished export (a file in the cache, removed afterwards) to the content:// place picked.
#[tauri::command]
pub async fn uri_export(app: AppHandle, path: String, uri: String) -> Res<()> {
    #[cfg(target_os = "android")]
    {
        let _: serde_json::Value = run(app, "exportUri", serde_json::json!({ "path": path, "uri": uri })).await?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path, uri);
        Err("only needed on Android".into())
    }
}
