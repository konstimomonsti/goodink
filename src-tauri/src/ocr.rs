//! Handwriting/print recognition with the OCR engine built into Windows 10/11 (Windows.Media.Ocr),
//! called directly through WinRT. Offline; nothing leaves the PC.

use serde::Serialize;

#[derive(Serialize)]
pub struct OcrWord {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[cfg(windows)]
pub fn recognize(png: &[u8]) -> Result<Vec<OcrWord>, String> {
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    let run = || -> windows::core::Result<Vec<OcrWord>> {
        unsafe {
            // already-initialised threads return S_FALSE / RPC_E_CHANGED_MODE; both are fine here
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(png)?;
        writer.StoreAsync()?.join()?;
        writer.FlushAsync()?.join()?;
        writer.DetachStream()?;
        stream.Seek(0)?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
        let bitmap = decoder.GetSoftwareBitmapAsync()?.join()?;
        let engine = match OcrEngine::TryCreateFromUserProfileLanguages() {
            Ok(e) => e,
            Err(_) => return Ok(Vec::new()), // no OCR language pack installed
        };
        let result = engine.RecognizeAsync(&bitmap)?.join()?;
        let mut out = Vec::new();
        for line in result.Lines()? {
            for word in line.Words()? {
                let r = word.BoundingRect()?;
                out.push(OcrWord { text: word.Text()?.to_string(), x: r.X, y: r.Y, w: r.Width, h: r.Height });
            }
        }
        Ok(out)
    };
    run().map_err(|e| e.message().to_string())
}

#[cfg(not(windows))]
pub fn recognize(_png: &[u8]) -> Result<Vec<OcrWord>, String> {
    Ok(Vec::new())
}
