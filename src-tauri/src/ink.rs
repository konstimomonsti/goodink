//! Handwriting recognition with the ink stack built into Windows 10/11 (Windows.UI.Input.Inking),
//! called through WinRT. Offline; nothing leaves the PC. One worker thread keeps the InkAnalyzer
//! and the recogniser warm: the first call costs ~0.5 s, later lines ~5-15 ms.
//!
//! Strokes come in groups (e.g. a fraction's numerator, an exponent); each group is recognised on
//! its own, so 2-D math layout stays the renderer's job. Two engines:
//! - `analyzer` (InkAnalyzer, default): finds lines and words itself, 10 ranked alternates.
//! - `recognizer` (InkRecognizerContainer): one piece of writing per group, 5 alternates.
#![allow(unexpected_cfgs)] // `inkproto`: built standalone for recogniser experiments, without Tauri

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct InkStrokeIn {
    /// x, y, pressure triples in page units (PDF points)
    pub pts: Vec<f32>,
}

#[derive(Deserialize)]
pub struct InkRequest {
    pub strokes: Vec<InkStrokeIn>,
    /// stroke indices per group, each recognised on its own; empty = one group of all strokes
    #[serde(default)]
    pub groups: Vec<Vec<usize>>,
    /// "analyzer" (default) or "recognizer"
    #[serde(default)]
    pub engine: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct InkWord {
    pub text: String,
    /// readings, most likely first (the first is usually `text` itself)
    pub alternates: Vec<String>,
    /// indices into the request's strokes
    pub strokes: Vec<usize>,
    pub bbox: [f32; 4],
}

#[derive(Serialize, Clone)]
pub struct InkLineOut {
    /// index of the request group this line belongs to
    pub group: usize,
    pub text: String,
    pub words: Vec<InkWord>,
    pub strokes: Vec<usize>,
    pub bbox: [f32; 4],
}

#[derive(Serialize)]
pub struct InkResult {
    pub engine: String,
    pub lines: Vec<InkLineOut>,
    /// strokes InkAnalyzer classified as drawings rather than writing
    pub drawings: Vec<usize>,
    /// time spent on the recogniser thread, ms
    pub ms: f64,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    use windows::core::{Interface, Result as WinResult};
    use windows::Foundation::{Point, Rect};
    use windows::UI::Input::Inking::Analysis::{InkAnalysisInkWord, InkAnalysisLine, InkAnalysisNodeKind, InkAnalysisStrokeKind, InkAnalyzer};
    use windows::UI::Input::Inking::{InkPoint, InkRecognitionTarget, InkRecognizerContainer, InkStroke, InkStrokeBuilder, InkStrokeContainer};
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
    use windows_collections::{IIterable, IVectorView};
    use windows_numerics::Matrix3x2;

    /// page units (1/72 in) -> DIPs (1/96 in): the recogniser is tuned for ink at physical size
    const S: f32 = 96.0 / 72.0;

    type Job = (InkRequest, Sender<Result<InkResult, String>>);

    struct Warm {
        builder: InkStrokeBuilder,
        analyzer: Option<InkAnalyzer>,
        recognizer: Option<InkRecognizerContainer>,
    }

    fn worker() -> &'static Mutex<Sender<Job>> {
        static TX: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
        TX.get_or_init(|| {
            let (tx, rx) = channel::<Job>();
            std::thread::Builder::new()
                .name("ink-recog".into())
                .spawn(move || {
                    unsafe {
                        let _ = RoInitialize(RO_INIT_MULTITHREADED);
                    }
                    let mut warm: Option<Warm> = None;
                    for (req, reply) in rx {
                        let r = run(&mut warm, &req).map_err(|e| format!("{} ({:?})", e.message(), e.code()));
                        if r.is_err() {
                            warm = None; // rebuild the engines after a failure
                        }
                        let _ = reply.send(r);
                    }
                })
                .expect("ink worker");
            Mutex::new(tx)
        })
    }

    /// Blocks until the worker thread has recognised the request.
    pub fn analyze(req: InkRequest) -> Result<InkResult, String> {
        let (tx, rx) = channel();
        worker().lock().map_err(|e| e.to_string())?.send((req, tx)).map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }

    fn rect(r: Rect) -> [f32; 4] {
        [r.X / S, r.Y / S, (r.X + r.Width) / S, (r.Y + r.Height) / S]
    }

    fn make_stroke(b: &InkStrokeBuilder, pts: &[f32]) -> WinResult<InkStroke> {
        let mut v: Vec<Option<InkPoint>> = Vec::with_capacity(pts.len() / 3 + 1);
        for p in pts.chunks_exact(3) {
            v.push(Some(InkPoint::CreateInkPoint(Point { X: p[0] * S, Y: p[1] * S }, p[2].clamp(0.05, 1.0))?));
        }
        if v.len() == 1 {
            // a tap: give the dot some extent
            v.push(Some(InkPoint::CreateInkPoint(Point { X: pts[0] * S + 0.3, Y: pts[1] * S + 0.3 }, pts[2].clamp(0.05, 1.0))?));
        }
        let it: IIterable<InkPoint> = v.into();
        b.CreateStrokeFromInkPoints(&it, Matrix3x2::identity())
    }

    fn run(warm: &mut Option<Warm>, req: &InkRequest) -> WinResult<InkResult> {
        if warm.is_none() {
            *warm = Some(Warm { builder: InkStrokeBuilder::new()?, analyzer: None, recognizer: None });
        }
        let w = warm.as_mut().unwrap();
        let t0 = Instant::now();
        if req.strokes.is_empty() {
            // warm-up call: load the recognisers (~0.5 s) before the user's first line needs them
            let s = make_stroke(&w.builder, &[0.0, 0.0, 0.5, 6.0, 8.0, 0.5, 12.0, 0.0, 0.5])?;
            let an = w.analyzer.get_or_insert(InkAnalyzer::new()?);
            let (mut l, mut d) = (Vec::new(), Vec::new());
            analyze_group(an, 0, &[(0, &s)], &HashMap::new(), &mut l, &mut d)?;
            return Ok(InkResult { engine: "analyzer".into(), lines: Vec::new(), drawings: Vec::new(), ms: t0.elapsed().as_secs_f64() * 1000.0 });
        }
        let mut strokes: HashMap<usize, InkStroke> = HashMap::with_capacity(req.strokes.len());
        let mut index = HashMap::new();
        for (i, s) in req.strokes.iter().enumerate() {
            if s.pts.len() < 3 {
                continue;
            }
            let st = make_stroke(&w.builder, &s.pts)?;
            index.insert(st.Id()?, i);
            strokes.insert(i, st);
        }
        let use_rec = req.engine.as_deref() == Some("recognizer");
        let all: Vec<usize> = (0..req.strokes.len()).collect();
        let groups: Vec<&[usize]> = if req.groups.is_empty() { vec![&all[..]] } else { req.groups.iter().map(|g| &g[..]).collect() };
        let mut lines = Vec::new();
        let mut drawings = Vec::new();
        for (gi, g) in groups.into_iter().enumerate() {
            let members: Vec<(usize, &InkStroke)> = g.iter().filter_map(|i| strokes.get(i).map(|s| (*i, s))).collect();
            if members.is_empty() {
                continue;
            }
            if use_rec {
                if w.recognizer.is_none() {
                    w.recognizer = Some(InkRecognizerContainer::new()?);
                }
                lines.push(recognize_group(w.recognizer.as_ref().unwrap(), gi, &members)?);
            } else {
                if w.analyzer.is_none() {
                    w.analyzer = Some(InkAnalyzer::new()?);
                }
                analyze_group(w.analyzer.as_ref().unwrap(), gi, &members, &index, &mut lines, &mut drawings)?;
            }
        }
        Ok(InkResult { engine: if use_rec { "recognizer" } else { "analyzer" }.into(), lines, drawings, ms: t0.elapsed().as_secs_f64() * 1000.0 })
    }

    fn bbox_of(words: &[InkWord]) -> [f32; 4] {
        words.iter().fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |b, w| [b[0].min(w.bbox[0]), b[1].min(w.bbox[1]), b[2].max(w.bbox[2]), b[3].max(w.bbox[3])])
    }

    fn recognize_group(rec: &InkRecognizerContainer, gi: usize, members: &[(usize, &InkStroke)]) -> WinResult<InkLineOut> {
        let container = InkStrokeContainer::new()?;
        // a stroke lives in one container at a time and clones get fresh ids: map those back
        let mut local = HashMap::new();
        for (i, s) in members {
            let c = s.Clone()?;
            local.insert(c.Id()?, *i);
            container.AddStroke(&c)?;
        }
        let mut words = Vec::new();
        for r in rec.RecognizeAsync(&container, InkRecognitionTarget::All)?.join()? {
            let alts: Vec<String> = r.GetTextCandidates()?.into_iter().map(|h| h.to_string()).collect();
            let mut st: Vec<usize> = r.GetStrokes()?.into_iter().filter_map(|s| s.Id().ok()).filter_map(|id| local.get(&id).copied()).collect();
            st.sort_unstable();
            words.push(InkWord { text: alts.first().cloned().unwrap_or_default(), alternates: alts, strokes: st, bbox: rect(r.BoundingRect()?) });
        }
        let text = words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
        let bbox = bbox_of(&words);
        Ok(InkLineOut { group: gi, text, words, strokes: members.iter().map(|m| m.0).collect(), bbox })
    }

    fn ids(v: IVectorView<u32>, index: &HashMap<u32, usize>) -> Vec<usize> {
        let mut out: Vec<usize> = v.into_iter().filter_map(|id| index.get(&id).copied()).collect();
        out.sort_unstable();
        out
    }

    fn analyze_group(an: &InkAnalyzer, gi: usize, members: &[(usize, &InkStroke)], index: &HashMap<u32, usize>, lines: &mut Vec<InkLineOut>, drawings: &mut Vec<usize>) -> WinResult<()> {
        an.ClearDataForAllStrokes()?;
        let list: Vec<Option<InkStroke>> = members.iter().map(|(_, s)| Some((*s).clone())).collect();
        let it: IIterable<InkStroke> = list.into();
        an.AddDataForStrokes(&it)?;
        // everything the renderer sends is writing (it drops highlighter and shape strokes itself);
        // left on Auto, an "=" or a fraction bar can be taken for a drawing
        for (_, s) in members {
            an.SetStrokeDataKind(s.Id()?, InkAnalysisStrokeKind::Writing)?;
        }
        an.AnalyzeAsync()?.join()?;
        let root = an.AnalysisRoot()?;
        for node in root.FindNodes(InkAnalysisNodeKind::Line)? {
            let line: InkAnalysisLine = node.cast()?;
            let mut words = Vec::new();
            for child in line.Children()? {
                if child.Kind()? != InkAnalysisNodeKind::InkWord {
                    continue;
                }
                let wd: InkAnalysisInkWord = child.cast()?;
                let alts: Vec<String> = wd.TextAlternates()?.into_iter().map(|h| h.to_string()).collect();
                words.push(InkWord { text: wd.RecognizedText()?.to_string(), alternates: alts, strokes: ids(wd.GetStrokeIds()?, index), bbox: rect(wd.BoundingRect()?) });
            }
            lines.push(InkLineOut { group: gi, text: line.RecognizedText()?.to_string(), words, strokes: ids(line.GetStrokeIds()?, index), bbox: rect(line.BoundingRect()?) });
        }
        for node in root.FindNodes(InkAnalysisNodeKind::InkDrawing)? {
            drawings.extend(ids(node.GetStrokeIds()?, index));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use imp::analyze;

/// Recognises handwriting; an empty request just warms the recognisers up.
#[cfg(not(inkproto))]
#[tauri::command]
pub async fn ink_analyze(req: InkRequest) -> Result<InkResult, String> {
    tauri::async_runtime::spawn_blocking(move || analyze(req)).await.map_err(|e| e.to_string())?
}

#[cfg(not(windows))]
pub fn analyze(_req: InkRequest) -> Result<InkResult, String> {
    Err("handwriting recognition needs Windows".into())
}
