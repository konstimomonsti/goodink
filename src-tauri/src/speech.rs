//! Dictation with Windows' built-in speech recogniser (Windows.Media.SpeechRecognition), for the
//! ask box's microphone when the AI provider cannot take audio. Continuous dictation; partial
//! text goes to the web view as `speech:partial` events, `speech_stop` returns the final text.
//!
//! Note: Windows' free-text dictation grammar is served by Microsoft's online speech service, so it
//! needs "Online speech recognition" on (Settings > Privacy & security > Speech). Without it,
//! starting fails at once with a clear message (we read the privacy switch first; the recogniser
//! itself takes ~9 s to give up) and the UI falls back to the AI provider's transcription.

#[cfg(windows)]
mod imp {
    use std::sync::{Arc, Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::core::{Ref, HSTRING};
    use windows::Foundation::TypedEventHandler;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession, SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus,
        SpeechRecognitionScenario, SpeechRecognitionTopicConstraint, SpeechRecognizer,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    struct Active {
        rec: SpeechRecognizer,
        text: Arc<Mutex<(String, String)>>, // (final so far, current hypothesis)
    }

    fn slot() -> &'static Mutex<Option<Active>> {
        static S: OnceLock<Mutex<Option<Active>>> = OnceLock::new();
        S.get_or_init(|| Mutex::new(None))
    }

    /// HRESULTs the speech stack returns when Windows settings block dictation
    fn explain(e: &windows::core::Error) -> String {
        match e.code().0 as u32 {
            0x80045509 => "Online speech recognition is off. Turn it on in Windows Settings > Privacy & security > Speech.".into(),
            0x800455A0 | 0x8004503A => "No speech language is installed. Add one in Windows Settings > Time & language > Speech.".into(),
            0x80070005 => "Microphone access is blocked. Allow desktop apps to use the microphone in Windows Settings > Privacy & security > Microphone.".into(),
            _ => format!("Dictation is unavailable: {} ({:#010x})", e.message(), e.code().0 as u32),
        }
    }

    /// The "Online speech recognition" privacy switch; without it dictation fails only after ~9 s.
    fn online_speech_allowed() -> bool {
        use windows::core::w;
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let ok = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!(r"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy"),
                w!("HasAccepted"),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut _),
                Some(&mut size),
            )
        };
        ok.is_ok() && value == 1
    }

    pub fn start(app: AppHandle) -> Result<(), String> {
        stop_inner();
        if !online_speech_allowed() {
            return Err(explain(&windows::core::Error::new(windows::core::HRESULT(0x80045509u32 as i32), "privacy")));
        }
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        let run = || -> windows::core::Result<Active> {
            let rec = SpeechRecognizer::new()?;
            let c = SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::from("dictation"))?;
            rec.Constraints()?.Append(&c)?;
            let compiled = rec.CompileConstraintsAsync()?.join()?;
            if compiled.Status()? != SpeechRecognitionResultStatus::Success {
                return Err(windows::core::Error::new(windows::core::HRESULT(0x80045509u32 as i32), "compile failed"));
            }
            let text = Arc::new(Mutex::new((String::new(), String::new())));
            let emit = {
                let app = app.clone();
                let text = text.clone();
                move || {
                    let t = text.lock().map(|t| format!("{} {}", t.0, t.1).trim().to_string()).unwrap_or_default();
                    let _ = app.emit("speech:partial", t);
                }
            };
            let (t1, e1) = (text.clone(), emit.clone());
            rec.HypothesisGenerated(&TypedEventHandler::new(move |_: Ref<SpeechRecognizer>, a: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
                if let Some(a) = a.as_ref() {
                    if let Ok(mut t) = t1.lock() {
                        t.1 = a.Hypothesis()?.Text()?.to_string();
                    }
                    e1();
                }
                Ok(())
            }))?;
            let session: SpeechContinuousRecognitionSession = rec.ContinuousRecognitionSession()?;
            let (t2, e2) = (text.clone(), emit);
            session.ResultGenerated(&TypedEventHandler::new(move |_: Ref<SpeechContinuousRecognitionSession>, a: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
                if let Some(a) = a.as_ref() {
                    let r = a.Result()?;
                    if r.Status()? == SpeechRecognitionResultStatus::Success {
                        if let Ok(mut t) = t2.lock() {
                            let s = r.Text()?.to_string();
                            if !s.is_empty() {
                                if !t.0.is_empty() {
                                    t.0.push(' ');
                                }
                                t.0.push_str(&s);
                            }
                            t.1.clear();
                        }
                        e2();
                    }
                }
                Ok(())
            }))?;
            session.StartAsync()?.join()?;
            Ok(Active { rec, text })
        };
        let a = run().map_err(|e| explain(&e))?;
        *slot().lock().map_err(|e| e.to_string())? = Some(a);
        Ok(())
    }

    fn stop_inner() -> String {
        let Some(a) = slot().lock().ok().and_then(|mut s| s.take()) else { return String::new() };
        if let Ok(s) = a.rec.ContinuousRecognitionSession() {
            // StopAsync delivers the last result before it completes
            if let Ok(op) = s.StopAsync() {
                let _ = op.join();
            }
        }
        let t = a.text.lock().map(|t| format!("{} {}", t.0, t.1).trim().to_string()).unwrap_or_default();
        let _ = a.rec.Close();
        t
    }

    pub fn stop() -> String {
        stop_inner()
    }

}

/// Starts continuous dictation; partial text arrives as `speech:partial` events.
#[tauri::command]
pub async fn speech_start(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || imp::start(app)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("dictation needs Windows".into())
    }
}

/// Stops dictation and returns everything recognised.
#[tauri::command]
pub async fn speech_stop() -> Result<String, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(imp::stop).await.map_err(|e| e.to_string());
    #[cfg(not(windows))]
    Ok(String::new())
}
