//! Local handwritten-math recognition (HMER): an image-to-LaTeX encoder/decoder model run with ONNX
//! Runtime (`ort`, loaded at run time so the installer carries no DLL). A line's strokes are rendered
//! here to a clean black-on-white image, encoded once, and decoded with batched beam search into the
//! top-k LaTeX readings with probabilities. Models are downloaded on first use from pinned URLs and
//! checked with sha256. See docs/live-ink/hmer.md for the model choice, sizes and numbers.
//!
//! Model layout ("TrOCR split"): `enc.onnx` maps pixel_values to N tensors, `dec.onnx` maps
//! (input_ids, those N tensors in the same order) to logits. With the official Hugging Face export N=1
//! (encoder_hidden_states); our derived int8 export precomputes every layer's cross-attention K/V in
//! the encoder graph (N=12), so a decoding step only runs the small self-attention stack.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use ort::session::{builder::GraphOptimizationLevel, Session, SessionInputValue};
use ort::value::{DynValue, Tensor};

type Res<T> = Result<T, String>;

// ---- model registry -------------------------------------------------------------------------------

struct FileSpec {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

struct ModelSpec {
    id: &'static str,
    enc: &'static str,
    dec: &'static str,
    tokenizer: &'static str,
    files: &'static [FileSpec],
    /// square input side, channels, normalisation
    size: usize,
    channels: usize,
    mean: f32,
    std: f32,
    start: i64,
    eos: i64,
}

macro_rules! hf {
    ($f:literal) => {
        concat!("https://huggingface.co/breezedeus/pix2text-mfr-1.5/resolve/1cef9f0bdcd6a4c63df7de1311fb0894593340cc/", $f)
    };
}
const TOKENIZER_SHA: &str = "4ffbeb2143e6a38324bb6111b7a8109530d38a076a8439aa5777535f0a32758a";

static MODELS: &[ModelSpec] = &[
    // Pix2Text MFR 1.5 (MIT): the official export, pinned on Hugging Face, 120 MB
    ModelSpec {
        id: "p2t-mfr-1.5",
        enc: "encoder_model.onnx",
        dec: "decoder_model.onnx",
        tokenizer: "tokenizer.json",
        files: &[
            FileSpec { name: "encoder_model.onnx", url: hf!("encoder_model.onnx"), sha256: "080a3f660f08bc9ebcacdd96e34be6b6400f8c7e62d7cd0dd8251badc37f610b", size: 87_510_770 },
            FileSpec { name: "decoder_model.onnx", url: hf!("decoder_model.onnx"), sha256: "917deb98e91a0453c5f234f58a0f32f9fb037de8527c7eb4ed394daf9e692f2a", size: 32_026_253 },
            FileSpec { name: "tokenizer.json", url: hf!("tokenizer.json"), sha256: TOKENIZER_SHA, size: 113_168 },
        ],
        size: 384,
        channels: 3,
        mean: 0.5,
        std: 0.5,
        start: 1,
        eos: 2,
    },
];

const DEFAULT_MODEL: &str = "p2t-mfr-1.5";

fn spec(id: &str) -> Res<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id).ok_or_else(|| format!("unknown model {id}"))
}

/// %APPDATA%\goodink\models\hmer (GOODINK_HMER_DIR overrides it, e.g. for dev models and tests)
fn models_root() -> PathBuf {
    if let Ok(p) = std::env::var("GOODINK_HMER_DIR") {
        return PathBuf::from(p);
    }
    crate::profile_dir().join("models").join("hmer")
}

fn model_dir(id: &str) -> PathBuf {
    models_root().join(id)
}

fn installed(m: &ModelSpec) -> bool {
    let d = model_dir(m.id);
    m.files.iter().all(|f| fs::metadata(d.join(f.name)).map(|md| md.len() == f.size).unwrap_or(false))
}

// ---- ONNX Runtime ---------------------------------------------------------------------------------

static ORT: OnceLock<Result<String, String>> = OnceLock::new();

/// Loads onnxruntime.dll once: GOODINK_ORT_DLL, then <models>\runtime\onnxruntime.dll, then the copy
/// Windows 11 ships in System32 (1.17, enough for the API level we build against).
fn ort_init() -> Res<String> {
    ORT.get_or_init(|| {
        let mut cands: Vec<PathBuf> = vec![];
        if let Ok(p) = std::env::var("GOODINK_ORT_DLL") {
            cands.push(PathBuf::from(p));
        }
        cands.push(models_root().join("runtime").join("onnxruntime.dll"));
        if let Ok(w) = std::env::var("SystemRoot") {
            cands.push(Path::new(&w).join("System32").join("onnxruntime.dll"));
        }
        let mut errs = vec![];
        for c in cands.iter().filter(|c| c.exists()) {
            match ort::init_from(c) {
                Ok(b) => {
                    b.with_name("goodink-hmer").commit();
                    return Ok(c.to_string_lossy().into_owned());
                }
                Err(e) => errs.push(format!("{}: {e}", c.display())),
            }
        }
        Err(format!("ONNX Runtime not available ({})", if errs.is_empty() { "no onnxruntime.dll found".into() } else { errs.join("; ") }))
    })
    .clone()
}

struct Engine {
    model: &'static str,
    ep: String,
    enc: Session,
    dec: Session,
    vocab: Vec<String>, // id -> byte-level BPE token
}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

fn session(path: &Path, dml: bool) -> Res<Session> {
    let e = |e: ort::Error<_>| e.to_string();
    let mut b = Session::builder().map_err(|e| e.to_string())?.with_optimization_level(GraphOptimizationLevel::All).map_err(e)?;
    if dml {
        b = b
            .with_memory_pattern(false)
            .map_err(e)?
            .with_parallel_execution(false)
            .map_err(e)?
            .with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()])
            .map_err(e)?;
    } else {
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
        b = b.with_intra_threads(n.min(4)).map_err(e)?;
    }
    b.commit_from_file(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn load_vocab(path: &Path) -> Res<Vec<String>> {
    let t: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut v: Vec<String> = vec![];
    let mut put = |id: usize, s: &str| {
        if v.len() <= id {
            v.resize(id + 1, String::new());
        }
        v[id] = s.to_string();
    };
    for (k, id) in t["model"]["vocab"].as_object().ok_or("tokenizer has no vocab")? {
        put(id.as_u64().unwrap_or(0) as usize, k);
    }
    for a in t["added_tokens"].as_array().into_iter().flatten() {
        put(a["id"].as_u64().unwrap_or(0) as usize, a["content"].as_str().unwrap_or(""));
    }
    Ok(v)
}

/// GPT-2 byte-level BPE: token characters back to bytes
fn byte_decoder() -> &'static HashMap<char, u8> {
    static M: OnceLock<HashMap<char, u8>> = OnceLock::new();
    M.get_or_init(|| {
        let mut bs: Vec<u32> = (b'!' as u32..=b'~' as u32).chain(0xA1..=0xAC).chain(0xAE..=0xFF).collect();
        let mut cs = bs.clone();
        let mut n = 0;
        for b in 0..256u32 {
            if !bs.contains(&b) {
                bs.push(b);
                cs.push(256 + n);
                n += 1;
            }
        }
        bs.iter().zip(cs).map(|(&b, c)| (char::from_u32(c).unwrap(), b as u8)).collect()
    })
}

fn detok(vocab: &[String], ids: &[i64], specials: usize) -> String {
    let bd = byte_decoder();
    let mut bytes = vec![];
    for &i in ids {
        let i = i as usize;
        if i < specials {
            continue;
        }
        for ch in vocab.get(i).map(|s| s.as_str()).unwrap_or("").chars() {
            bytes.push(*bd.get(&ch).unwrap_or(&b' '));
        }
    }
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn engine_for<'a>(slot: &'a mut Option<Engine>, model: &'static ModelSpec, ep: &str) -> Res<&'a mut Engine> {
    if slot.as_ref().map(|e| e.model != model.id || e.ep != ep).unwrap_or(true) {
        *slot = None;
        ort_init()?;
        if !installed(model) {
            return Err(format!("model {} is not installed", model.id));
        }
        let d = model_dir(model.id);
        let dml = ep == "dml";
        let enc = session(&d.join(model.enc), dml)?;
        // the decoder runs many tiny steps: the CPU wins over a GPU round trip per token
        let dec = session(&d.join(model.dec), false)?;
        let vocab = load_vocab(&d.join(model.tokenizer))?;
        *slot = Some(Engine { model: model.id, ep: ep.to_string(), enc, dec, vocab });
    }
    Ok(slot.as_mut().unwrap())
}

// ---- rendering ------------------------------------------------------------------------------------

/// Grayscale image, 1.0 = white.
struct Gray {
    w: usize,
    h: usize,
    px: Vec<f32>,
}

/// Renders strokes (x, y, pressure triples, page units) black on white. The scale puts the median
/// stroke height at `xh` px, which is roughly a glyph's height; the pen is `pen` px wide.
fn render(strokes: &[Vec<f32>], xh: f32, pen: f32, pad: f32) -> Option<Gray> {
    let mut hs: Vec<f32> = vec![];
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for s in strokes {
        let (mut a, mut b) = (f32::MAX, f32::MIN);
        for p in s.chunks_exact(3) {
            x0 = x0.min(p[0]);
            x1 = x1.max(p[0]);
            y0 = y0.min(p[1]);
            y1 = y1.max(p[1]);
            a = a.min(p[1]);
            b = b.max(p[1]);
        }
        if b >= a {
            hs.push(b - a);
        }
    }
    if hs.is_empty() {
        return None;
    }
    hs.sort_by(|a, b| a.total_cmp(b));
    let med = hs[hs.len() / 2].max(hs[hs.len() - 1] * 0.25).max(1e-3);
    // cap the image so a long line stays cheap to rasterise
    let sc = (xh / med).min(1600.0 / (x1 - x0 + 1e-3)).min(600.0 / (y1 - y0 + 1e-3));
    let w = ((x1 - x0) * sc + 2.0 * pad).ceil() as usize + 1;
    let h = ((y1 - y0) * sc + 2.0 * pad).ceil() as usize + 1;
    let mut ink = vec![0f32; w * h];
    let r = pen / 2.0;
    for s in strokes {
        let pts: Vec<(f32, f32)> = s.chunks_exact(3).map(|p| ((p[0] - x0) * sc + pad, (p[1] - y0) * sc + pad)).collect();
        let segs: Vec<((f32, f32), (f32, f32))> = if pts.len() == 1 { vec![(pts[0], pts[0])] } else { pts.windows(2).map(|w| (w[0], w[1])).collect() };
        for (a, b) in segs {
            let (bx0, bx1) = ((a.0.min(b.0) - r - 1.0).max(0.0) as usize, ((a.0.max(b.0) + r + 1.0) as usize).min(w - 1));
            let (by0, by1) = ((a.1.min(b.1) - r - 1.0).max(0.0) as usize, ((a.1.max(b.1) + r + 1.0) as usize).min(h - 1));
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let l2 = dx * dx + dy * dy;
            for y in by0..=by1 {
                for x in bx0..=bx1 {
                    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                    let t = if l2 > 0.0 { (((px - a.0) * dx + (py - a.1) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
                    let (qx, qy) = (a.0 + t * dx - px, a.1 + t * dy - py);
                    let cov = (r + 0.5 - (qx * qx + qy * qy).sqrt()).clamp(0.0, 1.0);
                    let c = &mut ink[y * w + x];
                    if cov > *c {
                        *c = cov;
                    }
                }
            }
        }
    }
    Some(Gray { w, h, px: ink.into_iter().map(|c| 1.0 - c).collect() })
}

fn decode_png(bytes: &[u8]) -> Res<Gray> {
    let mut d = png::Decoder::new(std::io::Cursor::new(bytes));
    d.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut r = d.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; r.output_buffer_size().ok_or("png too large")?];
    let info = r.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let ch = info.color_type.samples();
    let (w, h) = (info.width as usize, info.height as usize);
    let px = (0..w * h)
        .map(|i| {
            let p = &buf[i * ch..i * ch + ch];
            let (v, a) = match ch {
                1 => (p[0] as f32, 255.0),
                2 => (p[0] as f32, p[1] as f32),
                3 => ((p[0] as f32 + p[1] as f32 + p[2] as f32) / 3.0, 255.0),
                _ => ((p[0] as f32 + p[1] as f32 + p[2] as f32) / 3.0, p[3] as f32),
            };
            let a = a / 255.0;
            (v / 255.0) * a + (1.0 - a) // transparent = white paper
        })
        .collect();
    Ok(Gray { w, h, px })
}

/// 1-D resampling with a triangle filter widened when shrinking (antialiased, like PIL's bilinear)
fn resample_axis(src: &[f32], n_in: usize, n_out: usize, stride: usize, count: usize, along_x: bool) -> Vec<f32> {
    let scale = n_in as f32 / n_out as f32;
    let support = scale.max(1.0);
    let mut out = vec![0f32; n_out * count];
    for o in 0..n_out {
        let c = (o as f32 + 0.5) * scale;
        let lo = ((c - support).floor().max(0.0)) as usize;
        let hi = ((c + support).ceil() as usize).min(n_in);
        let mut ws = vec![];
        let mut tot = 0.0;
        for i in lo..hi {
            let wgt = (1.0 - ((i as f32 + 0.5 - c) / support).abs()).max(0.0);
            ws.push((i, wgt));
            tot += wgt;
        }
        if tot == 0.0 {
            ws = vec![(((c as usize).min(n_in - 1)), 1.0)];
            tot = 1.0;
        }
        for k in 0..count {
            let mut acc = 0.0;
            for &(i, wgt) in &ws {
                acc += wgt * if along_x { src[k * stride + i] } else { src[i * stride + k] };
            }
            if along_x {
                out[k * n_out + o] = acc / tot;
            } else {
                out[o * count + k] = acc / tot;
            }
        }
    }
    out
}

fn resize(g: &Gray, w: usize, h: usize) -> Gray {
    let a = resample_axis(&g.px, g.w, w, g.w, g.h, true); // rows: g.h x w
    let b = resample_axis(&a, g.h, h, w, w, false); // h x w
    Gray { w, h, px: b }
}

/// Square model input: the whole line stretched to size x size (as the model was trained), or
/// letterboxed into a white square when `square` (helps very short lines).
fn to_input(g: &Gray, m: &ModelSpec, square: bool) -> Vec<f32> {
    let s = m.size;
    let img = if square {
        let side = g.w.max(g.h);
        let mut px = vec![1f32; side * side];
        let oy = (side - g.h) / 2;
        let ox = (side - g.w) / 2;
        for y in 0..g.h {
            px[(y + oy) * side + ox..(y + oy) * side + ox + g.w].copy_from_slice(&g.px[y * g.w..(y + 1) * g.w]);
        }
        resize(&Gray { w: side, h: side, px }, s, s)
    } else {
        resize(g, s, s)
    };
    let plane: Vec<f32> = img.px.iter().map(|v| (v - m.mean) / m.std).collect();
    let mut out = Vec::with_capacity(plane.len() * m.channels);
    for _ in 0..m.channels {
        out.extend_from_slice(&plane);
    }
    out
}

// ---- beam search ----------------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct Hyp {
    latex: String,
    /// sum of token log-probabilities
    logp: f32,
    /// share of probability mass among the returned readings (sums to 1)
    prob: f32,
    tokens: usize,
}

fn log_softmax_row(row: &[f32]) -> Vec<f32> {
    let m = row.iter().cloned().fold(f32::MIN, f32::max);
    let z = row.iter().map(|v| (v - m).exp()).sum::<f32>().ln() + m;
    row.iter().map(|v| v - z).collect()
}

fn tile(v: &DynValue, b: usize) -> Res<Tensor<f32>> {
    let (shape, data) = v.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    let mut dims: Vec<i64> = shape.iter().copied().collect();
    dims[0] = b as i64;
    let mut out = Vec::with_capacity(data.len() * b);
    for _ in 0..b {
        out.extend_from_slice(data);
    }
    Tensor::from_array((dims, out)).map_err(|e| e.to_string())
}

struct Timing {
    enc_ms: f64,
    dec_ms: f64,
    steps: usize,
}

fn beam_search(e: &mut Engine, m: &ModelSpec, input: Vec<f32>, beam: usize, top_k: usize, max_len: usize) -> Res<(Vec<Hyp>, Timing)> {
    let t0 = Instant::now();
    let px = Tensor::from_array((vec![1i64, m.channels as i64, m.size as i64, m.size as i64], input)).map_err(|e| e.to_string())?;
    let enc_out: Vec<DynValue> = {
        let outs = e.enc.run(ort::inputs![px]).map_err(|e| e.to_string())?;
        outs.into_iter().map(|(_, v)| v).collect()
    };
    let enc_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = Instant::now();
    let b = beam.max(1);
    let ctx: Vec<Tensor<f32>> = enc_out.iter().map(|v| tile(v, b)).collect::<Res<_>>()?;
    let dec_names: Vec<String> = e.dec.inputs().iter().map(|i| i.name().to_string()).collect();
    if dec_names.len() != ctx.len() + 1 {
        return Err(format!("decoder expects {} inputs, encoder gives {}", dec_names.len() - 1, ctx.len()));
    }
    // alive beams: (token ids, score); beams 1.. start at -inf so step 0 expands one beam only
    let mut alive: Vec<(Vec<i64>, f32)> = (0..b).map(|i| (vec![m.start], if i == 0 { 0.0 } else { -1e9 })).collect();
    let mut done: Vec<(Vec<i64>, f32)> = vec![];
    let mut steps = 0;
    let norm = |ids: &Vec<i64>, s: f32| s / (ids.len() as f32); // HF length_penalty = 1
    while steps < max_len {
        steps += 1;
        let t = alive[0].0.len();
        let ids: Vec<i64> = alive.iter().flat_map(|(v, _)| v.iter().copied()).collect();
        let ids = Tensor::from_array((vec![b as i64, t as i64], ids)).map_err(|e| e.to_string())?;
        let mut inputs: Vec<(String, SessionInputValue)> = vec![(dec_names[0].clone(), ids.into())];
        for (n, c) in dec_names[1..].iter().zip(&ctx) {
            inputs.push((n.clone(), c.into()));
        }
        let outs = e.dec.run(inputs).map_err(|e| e.to_string())?;
        let (shape, logits) = outs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let vsz = if shape.len() == 3 { shape[2] as usize } else { 0 };
        if vsz < 2 || logits.len() < b * t * vsz {
            return Err(format!("unexpected decoder output shape {shape:?}"));
        }
        let mut cands: Vec<(usize, i64, f32)> = vec![];
        for (bi, (_, score)) in alive.iter().enumerate() {
            let row = &logits[(bi * t + t - 1) * vsz..(bi * t + t) * vsz];
            let lp = log_softmax_row(row);
            let mut idx: Vec<usize> = (0..vsz).collect();
            let kk = (2 * b).min(vsz - 1);
            idx.select_nth_unstable_by(kk, |&x, &y| lp[y].total_cmp(&lp[x]));
            for &k in &idx[..kk] {
                cands.push((bi, k as i64, score + lp[k]));
            }
        }
        cands.sort_by(|x, y| y.2.total_cmp(&x.2));
        let mut next = vec![];
        for (rank, (bi, tok, s)) in cands.into_iter().enumerate() {
            if s < -1e8 || next.len() == b {
                break;
            }
            let mut ids = alive[bi].0.clone();
            if tok == m.eos {
                // as in HF: an ending counts only when it ranks among the best `b` candidates
                if rank < b {
                    done.push((ids, s));
                }
            } else {
                ids.push(tok);
                next.push((ids, s));
            }
        }
        done.sort_by(|x, y| norm(&y.0, y.1).total_cmp(&norm(&x.0, x.1)));
        done.truncate(top_k.max(b));
        if next.is_empty() {
            break;
        }
        while next.len() < b {
            let mut pad = next[0].clone();
            pad.1 = -1e9;
            next.push(pad);
        }
        alive = next;
        // scores only fall: stop once every alive beam is < 1% as likely as the best finished one,
        // or once the top_k are finished and no alive beam can still overtake the last of them
        if let Some(best) = done.iter().map(|d| d.1).reduce(f32::max) {
            let top = alive.iter().map(|a| a.1).fold(f32::MIN, f32::max);
            let mut raw: Vec<f32> = done.iter().map(|d| d.1).collect();
            raw.sort_by(|x, y| y.total_cmp(x));
            if top < best - 4.6 || (raw.len() >= top_k && top < raw[top_k - 1]) {
                break;
            }
        }
    }
    if done.is_empty() {
        done = alive.into_iter().filter(|(_, s)| *s > -1e8).collect();
    }
    // most probable first (the shares below are probabilities, so rank by them too)
    done.sort_by(|x, y| y.1.total_cmp(&x.1));
    // merge readings that detokenise to the same LaTeX (keep the best), then top_k
    let mut seen = std::collections::HashSet::new();
    let mut hyps: Vec<Hyp> = vec![];
    for (ids, s) in done {
        let latex = detok(&e.vocab, &ids, 5);
        if seen.insert(latex.clone()) {
            hyps.push(Hyp { latex, logp: s, prob: 0.0, tokens: ids.len() - 1 });
        }
        if hyps.len() == top_k.max(1) {
            break;
        }
    }
    let mx = hyps.iter().map(|h| h.logp).fold(f32::MIN, f32::max);
    let z: f32 = hyps.iter().map(|h| (h.logp - mx).exp()).sum();
    for h in &mut hyps {
        h.prob = (h.logp - mx).exp() / z;
    }
    Ok((hyps, Timing { enc_ms, dec_ms: t1.elapsed().as_secs_f64() * 1000.0, steps }))
}

// ---- commands -------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct StrokeIn {
    pts: Vec<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HmerRequest {
    #[serde(default)]
    strokes: Vec<StrokeIn>,
    /// a ready image instead of strokes
    png: Option<Vec<u8>>,
    model: Option<String>,
    top_k: Option<usize>,
    beam: Option<usize>,
    /// "cpu" (default) or "dml" (DirectML: GPU/NPU) for the encoder
    ep: Option<String>,
    /// rendering: median stroke height in px, pen width in px, letterbox to a square
    xh: Option<f32>,
    pen: Option<f32>,
    square: Option<bool>,
    max_len: Option<usize>,
    /// return the rendered model input as a PNG (debugging)
    debug_png: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HmerResult {
    hyps: Vec<Hyp>,
    model: String,
    ep: String,
    ms: f64,
    render_ms: f64,
    enc_ms: f64,
    dec_ms: f64,
    steps: usize,
    load_ms: f64,
    debug_png: Option<Vec<u8>>,
}

fn encode_png(g: &Gray) -> Option<Vec<u8>> {
    let mut out = vec![];
    {
        let mut enc = png::Encoder::new(&mut out, g.w as u32, g.h as u32);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().ok()?;
        let px: Vec<u8> = g.px.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8).collect();
        w.write_image_data(&px).ok()?;
    }
    Some(out)
}

fn recognize(req: HmerRequest) -> Res<HmerResult> {
    let t0 = Instant::now();
    let m = spec(req.model.as_deref().unwrap_or(DEFAULT_MODEL))?;
    let ep = match req.ep.as_deref() {
        Some("dml") => "dml",
        _ => "cpu",
    };
    let mut slot = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    let tl = Instant::now();
    let e = engine_for(&mut slot, m, ep)?;
    let load_ms = tl.elapsed().as_secs_f64() * 1000.0;
    let tr = Instant::now();
    let img = if let Some(p) = &req.png {
        Some(decode_png(p)?)
    } else {
        let strokes: Vec<Vec<f32>> = req.strokes.into_iter().map(|s| s.pts).filter(|p| p.len() >= 3).collect();
        render(&strokes, req.xh.unwrap_or(16.0), req.pen.unwrap_or(2.0), 8.0)
    };
    let Some(img) = img else {
        // nothing to read: the call only warmed the sessions
        return Ok(HmerResult { hyps: vec![], model: m.id.into(), ep: ep.into(), ms: t0.elapsed().as_secs_f64() * 1000.0, render_ms: 0.0, enc_ms: 0.0, dec_ms: 0.0, steps: 0, load_ms, debug_png: None });
    };
    let square = req.square.unwrap_or(false);
    let input = to_input(&img, m, square);
    let debug_png = if req.debug_png.unwrap_or(false) {
        let s = m.size;
        encode_png(&Gray { w: s, h: s, px: input[..s * s].iter().map(|v| v * m.std + m.mean).collect() })
    } else {
        None
    };
    let render_ms = tr.elapsed().as_secs_f64() * 1000.0;
    let top_k = req.top_k.unwrap_or(5).clamp(1, 10);
    let beam = req.beam.unwrap_or(top_k.max(3)).clamp(1, 10);
    let (hyps, t) = beam_search(e, m, input, beam, top_k, req.max_len.unwrap_or(96))?;
    Ok(HmerResult { hyps, model: m.id.into(), ep: ep.into(), ms: t0.elapsed().as_secs_f64() * 1000.0, render_ms, enc_ms: t.enc_ms, dec_ms: t.dec_ms, steps: t.steps, load_ms, debug_png })
}

/// Recognise one line: strokes (or a PNG) -> top-k LaTeX readings. Runs off the main thread; the
/// sessions stay loaded between calls. An empty request just loads (warms) the model.
#[tauri::command]
pub async fn hmer_recognize(req: HmerRequest) -> Res<HmerResult> {
    // one engine behind a mutex (sessions are never used concurrently); a panic becomes an error
    tauri::async_runtime::spawn_blocking(move || std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| recognize(req))).unwrap_or_else(|_| Err("hmer: internal error".into())))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    id: &'static str,
    installed: bool,
    bytes: u64,
    loaded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HmerStatus {
    models: Vec<ModelStatus>,
    default_model: &'static str,
    /// the onnxruntime.dll in use, or why none could be loaded (only tried when `probe` is set)
    runtime: Option<Result<String, String>>,
    dir: String,
}

#[tauri::command]
pub async fn hmer_status(probe: Option<bool>) -> HmerStatus {
    let loaded = ENGINE.lock().map(|g| g.as_ref().map(|e| e.model)).ok().flatten();
    let runtime = if probe.unwrap_or(false) { Some(tauri::async_runtime::spawn_blocking(ort_init).await.unwrap_or_else(|e| Err(e.to_string()))) } else { ORT.get().cloned() };
    HmerStatus {
        models: MODELS.iter().map(|m| ModelStatus { id: m.id, installed: installed(m), bytes: m.files.iter().map(|f| f.size).sum(), loaded: loaded == Some(m.id) }).collect(),
        default_model: DEFAULT_MODEL,
        runtime,
        dir: models_root().to_string_lossy().into_owned(),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    model: &'static str,
    file: &'static str,
    received: u64,
    total: u64,
}

static INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Downloads a model's missing files (sha256 checked, written atomically), emitting
/// `hmer://progress`. In test runs (GOODINK_TEST) nothing is downloaded: files must exist already.
#[tauri::command]
pub async fn hmer_install(app: AppHandle, model: Option<String>) -> Res<()> {
    let m = spec(model.as_deref().unwrap_or(DEFAULT_MODEL))?;
    if installed(m) {
        return Ok(());
    }
    if std::env::var("GOODINK_TEST").is_ok() {
        return Err(format!("model {} is not installed (downloads are off in tests)", m.id));
    }
    use std::sync::atomic::Ordering::SeqCst;
    if INSTALLING.swap(true, SeqCst) {
        return Err("a model download is already running".into());
    }
    let r = download(&app, m).await;
    INSTALLING.store(false, SeqCst);
    r
}

async fn download(app: &AppHandle, m: &'static ModelSpec) -> Res<()> {
    let dir = model_dir(m.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30 * 60)).build().map_err(|e| e.to_string())?;
    for f in m.files {
        let dest = dir.join(f.name);
        if fs::metadata(&dest).map(|md| md.len() == f.size).unwrap_or(false) {
            continue;
        }
        let part = dir.join(format!("{}.part", f.name));
        let mut res = client.get(f.url).send().await.map_err(|e| format!("download {}: {e}", f.name))?;
        if !res.status().is_success() {
            return Err(format!("download {}: HTTP {}", f.name, res.status()));
        }
        let mut out = fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        let mut got = 0u64;
        let mut last = Instant::now();
        while let Some(chunk) = res.chunk().await.map_err(|e| format!("download {}: {e}", f.name))? {
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            h.update(&chunk);
            got += chunk.len() as u64;
            if last.elapsed().as_millis() > 100 {
                last = Instant::now();
                let _ = app.emit("hmer://progress", Progress { model: m.id, file: f.name, received: got, total: f.size });
            }
        }
        drop(out);
        let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if hex != f.sha256 || got != f.size {
            let _ = fs::remove_file(&part);
            return Err(format!("download {}: checksum mismatch", f.name));
        }
        fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        let _ = app.emit("hmer://progress", Progress { model: m.id, file: f.name, received: got, total: f.size });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bpe_bytes_roundtrip() {
        let bd = byte_decoder();
        assert_eq!(bd.len(), 256);
        // 'Ġ' (U+0120) is the byte-level space
        assert_eq!(bd[&'\u{120}'], b' ');
        assert_eq!(bd[&'a'], b'a');
    }

    #[test]
    fn render_draws_ink() {
        let g = render(&[vec![0.0, 0.0, 0.5, 10.0, 10.0, 0.5]], 16.0, 2.0, 8.0).unwrap();
        assert!(g.px.iter().any(|&v| v < 0.1));
        assert!(g.px.iter().any(|&v| v > 0.99));
        let r = resize(&g, 32, 32);
        assert_eq!(r.px.len(), 32 * 32);
    }
}
