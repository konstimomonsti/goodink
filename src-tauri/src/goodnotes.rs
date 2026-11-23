//! Goodnotes import. A .goodnotes file (Goodnotes 5/6, "Export → Goodnotes") becomes one goodink
//! notebook: every page with its paper or PDF background, handwriting (pen, pencil, highlighter,
//! shapes), pictures and text boxes, where they were on the page.
//!
//! The format is not documented. What is read here follows the community's reverse engineering
//! (InkLift, notability-goodnotes, Strokebook: MIT) and was checked against real files:
//! - a ZIP. index.events.pb is a log of events (length-prefixed protobuf): templates (#2: paper or
//!   PDF attachment, page in it, size), pages (#54/#55: template, order key), deleted pages (#56),
//!   the title (#30). notes/<page uuid + 1> holds a page's elements as (metadata, content) record
//!   pairs; attachments/<uuid> are PDFs and pictures.
//! - strokes keep their geometry in an Apple-framed LZ4 block ("bv41") holding a "tpl" image:
//!   quadratic curves with a width per node (ribbon), one width (flat) or pencil samples.
//! - Goodnotes' canvas unit is 11/6 of a PDF point.

use crate::store::Res;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;

/// Goodnotes canvas units → PDF points.
const PT: f32 = 6.0 / 11.0;
/// Curves are drawn as this many straight pieces each.
const QUAD_STEPS: usize = 6;

// ---- protobuf (just enough to walk messages) -------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Field<'a> {
    Varint(u64),
    F32(f32),
    F64(u64),
    Bytes(&'a [u8]),
}

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut r = 0u64;
    let mut shift = 0;
    loop {
        let c = *b.get(*i)?;
        *i += 1;
        r |= ((c & 0x7f) as u64) << shift;
        if c < 0x80 {
            return Some(r);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// A message's fields in order (repeated fields appear several times). None if it is not one.
fn msg(b: &[u8]) -> Option<Vec<(u32, Field<'_>)>> {
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let key = varint(b, &mut i)?;
        let (f, wire) = ((key >> 3) as u32, key & 7);
        let v = match wire {
            0 => Field::Varint(varint(b, &mut i)?),
            1 => {
                let s = b.get(i..i + 8)?;
                i += 8;
                Field::F64(u64::from_le_bytes(s.try_into().ok()?))
            }
            2 => {
                let n = varint(b, &mut i)? as usize;
                let s = b.get(i..i.checked_add(n)?)?;
                i += n;
                Field::Bytes(s)
            }
            5 => {
                let s = b.get(i..i + 4)?;
                i += 4;
                Field::F32(f32::from_le_bytes(s.try_into().ok()?))
            }
            _ => return None,
        };
        out.push((f, v));
    }
    Some(out)
}

/// Length-prefixed records, one after another.
fn records(b: &[u8]) -> Vec<&[u8]> {
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let Some(n) = varint(b, &mut i) else { break };
        let Some(r) = b.get(i..i + n as usize) else { break };
        out.push(r);
        i += n as usize;
    }
    out
}

/// A parsed message with lookups by field number (the last occurrence wins, like protobuf).
struct M<'a>(Vec<(u32, Field<'a>)>);

impl<'a> M<'a> {
    fn of(b: &'a [u8]) -> M<'a> {
        M(msg(b).unwrap_or_default())
    }
    fn get(&self, f: u32) -> Option<Field<'a>> {
        self.0.iter().rev().find(|(k, _)| *k == f).map(|(_, v)| *v)
    }
    fn has(&self, f: u32) -> bool {
        self.0.iter().any(|(k, _)| *k == f)
    }
    fn bytes(&self, f: u32) -> Option<&'a [u8]> {
        match self.get(f)? {
            Field::Bytes(b) => Some(b),
            _ => None,
        }
    }
    fn str(&self, f: u32) -> Option<String> {
        self.bytes(f).and_then(|b| std::str::from_utf8(b).ok()).map(String::from)
    }
    fn sub(&self, f: u32) -> M<'a> {
        M::of(self.bytes(f).unwrap_or(&[]))
    }
    fn subs(&self, f: u32) -> Vec<M<'a>> {
        self.0.iter().filter(|(k, _)| *k == f).filter_map(|(_, v)| if let Field::Bytes(b) = v { Some(M::of(b)) } else { None }).collect()
    }
    fn u(&self, f: u32) -> Option<u64> {
        match self.get(f)? {
            Field::Varint(v) => Some(v),
            _ => None,
        }
    }
    /// A float; omitted means 0 (protobuf leaves out zero values).
    fn f(&self, f: u32) -> f32 {
        match self.get(f) {
            Some(Field::F32(v)) => v,
            Some(Field::F64(v)) => f64::from_bits(v) as f32,
            _ => 0.0,
        }
    }
    fn point(&self, f: u32) -> (f32, f32) {
        let p = self.sub(f);
        (p.f(1), p.f(2))
    }
}

// ---- Apple LZ4 and tpl ------------------------------------------------------------------------------

fn lz4_block(src: &[u8], out: &mut Vec<u8>) -> Option<()> {
    let mut i = 0;
    let len_more = |i: &mut usize, mut n: usize| -> Option<usize> {
        loop {
            let b = *src.get(*i)?;
            *i += 1;
            n += b as usize;
            if b != 255 {
                return Some(n);
            }
        }
    };
    while i < src.len() {
        let token = src[i];
        i += 1;
        let mut lit = (token >> 4) as usize;
        if lit == 15 {
            lit = len_more(&mut i, lit)?;
        }
        out.extend_from_slice(src.get(i..i + lit)?);
        i += lit;
        if i >= src.len() {
            break;
        }
        let off = u16::from_le_bytes([*src.get(i)?, *src.get(i + 1)?]) as usize;
        i += 2;
        let mut m = (token & 15) as usize;
        if m == 15 {
            m = len_more(&mut i, m)?;
        }
        m += 4;
        if off == 0 || off > out.len() {
            return None;
        }
        let start = out.len() - off;
        for k in 0..m {
            out.push(out[start + k]);
        }
    }
    Some(())
}

fn apple_lz4(b: &[u8]) -> Option<Vec<u8>> {
    let mut out = vec![];
    let mut i = 0;
    let u32at = |i: usize| -> Option<usize> { Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?) as usize) };
    while i + 4 <= b.len() {
        match &b[i..i + 4] {
            b"bv41" => {
                let n = u32at(i + 8)?;
                lz4_block(b.get(i + 12..i + 12 + n)?, &mut out)?;
                i += 12 + n;
            }
            b"bv4-" => {
                let n = u32at(i + 4)?;
                out.extend_from_slice(b.get(i + 8..i + 8 + n)?);
                i += 8 + n;
            }
            b"bv4$" => break,
            _ => return None,
        }
    }
    Some(out)
}

#[derive(Debug, Clone)]
enum Tpl {
    Num(f64),
    List(Vec<Tpl>),
}

impl Tpl {
    fn num(&self) -> f32 {
        if let Tpl::Num(v) = self { *v as f32 } else { 0.0 }
    }
    fn list(&self) -> &[Tpl] {
        if let Tpl::List(v) = self { v } else { &[] }
    }
    /// A list of numbers, or of structs of numbers, flattened.
    fn floats(&self) -> Vec<f32> {
        let mut out = vec![];
        fn walk(t: &Tpl, out: &mut Vec<f32>) {
            match t {
                Tpl::Num(v) => out.push(*v as f32),
                Tpl::List(l) => l.iter().for_each(|x| walk(x, out)),
            }
        }
        walk(self, &mut out);
        out
    }
}

/// A tpl image: its type signature and values. v = u16, u = f32, f = f64, A(T) = count + items,
/// S(...) = struct.
fn tpl(raw: &[u8]) -> Option<(String, Vec<Tpl>)> {
    if raw.get(0..3)? != b"tpl" {
        return None;
    }
    let end = 8 + raw.get(8..)?.iter().position(|&c| c == 0)?;
    let sig: Vec<u8> = raw[8..end].to_vec();
    let mut pos = end + 1;
    // the type at sig[k]; returns the index after it
    fn skip(sig: &[u8], k: usize) -> Option<usize> {
        match sig.get(k)? {
            b'v' | b'u' | b'f' => Some(k + 1),
            b'A' | b'S' => {
                let mut j = k + 2;
                while *sig.get(j)? != b')' {
                    j = skip(sig, j)?;
                }
                Some(j + 1)
            }
            _ => None,
        }
    }
    fn read(raw: &[u8], sig: &[u8], k: usize, pos: &mut usize) -> Option<Tpl> {
        let take = |pos: &mut usize, n: usize| -> Option<&[u8]> {
            let s = raw.get(*pos..*pos + n)?;
            *pos += n;
            Some(s)
        };
        match sig.get(k)? {
            b'v' => Some(Tpl::Num(u16::from_le_bytes(take(pos, 2)?.try_into().ok()?) as f64)),
            b'u' => Some(Tpl::Num(f32::from_le_bytes(take(pos, 4)?.try_into().ok()?) as f64)),
            b'f' => Some(Tpl::Num(f64::from_le_bytes(take(pos, 8)?.try_into().ok()?))),
            b'S' => {
                let mut vals = vec![];
                let mut j = k + 2;
                while *sig.get(j)? != b')' {
                    vals.push(read(raw, sig, j, pos)?);
                    j = skip(sig, j)?;
                }
                Some(Tpl::List(vals))
            }
            b'A' => {
                let n = u32::from_le_bytes(take(pos, 4)?.try_into().ok()?) as usize;
                if n > raw.len() {
                    return None;
                }
                let mut vals = Vec::with_capacity(n);
                for _ in 0..n {
                    vals.push(read(raw, sig, k + 2, pos)?);
                }
                Some(Tpl::List(vals))
            }
            _ => None,
        }
    }
    let mut vals = vec![];
    let mut k = 0;
    while k < sig.len() {
        vals.push(read(raw, &sig, k, &mut pos)?);
        k = skip(&sig, k)?;
    }
    Some((String::from_utf8_lossy(&sig).into_owned(), vals))
}

// ---- stroke geometry --------------------------------------------------------------------------------

/// One drawn sub-path: points (x, y, full width), canvas units.
type Path = Vec<(f32, f32, f32)>;

fn quad(p0: (f32, f32, f32), c: (f32, f32, f32), p1: (f32, f32, f32), out: &mut Path) {
    for i in 1..=QUAD_STEPS {
        let t = i as f32 / QUAD_STEPS as f32;
        let (a, b, d) = ((1.0 - t) * (1.0 - t), 2.0 * (1.0 - t) * t, t * t);
        out.push((a * p0.0 + b * c.0 + d * p1.0, a * p0.1 + b * c.1 + d * p1.1, a * p0.2 + b * c.2 + d * p1.2));
    }
}

/// Nodes in order: a move starts a sub-path, a quad continues it with (control, end).
fn assemble(flags: &[Tpl], mut moves: impl FnMut(u32) -> Option<(f32, f32, f32)>, mut quads: impl FnMut(u32) -> Option<((f32, f32, f32), (f32, f32, f32))>) -> Vec<Path> {
    let mut paths: Vec<Path> = vec![];
    for f in flags {
        let flag = f.num() as u32;
        if flag & 1 == 0 {
            if let Some(p) = moves(flag) {
                paths.push(vec![p]);
            }
        } else if let Some((c, e)) = quads(flag) {
            match paths.last_mut() {
                Some(path) => {
                    let p0 = *path.last().unwrap_or(&e);
                    quad(p0, c, e, path);
                }
                None => paths.push(vec![e]),
            }
        }
    }
    paths.retain(|p| !p.is_empty());
    paths
}

/// A stroke's sub-paths from its tpl image, or None for a layout not known.
fn stroke_paths(sig: &str, v: &[Tpl]) -> Option<Vec<Path>> {
    // ribbon: flags, starts (x, y, r)…, segments (cx, cy, cr, ex, ey, er)…; r = half width
    if sig.starts_with("vA(v)A(u)A(u)") {
        let (s, q) = (v.get(2)?.floats(), v.get(3)?.floats());
        let (mut mi, mut qi) = (0, 0);
        return Some(assemble(
            v.get(1)?.list(),
            |_| {
                let p = s.get(mi..mi + 3).map(|p| (p[0], p[1], p[2] * 2.0));
                mi += 3;
                p
            },
            |_| {
                let p = q.get(qi..qi + 6).map(|p| ((p[0], p[1], p[2] * 2.0), (p[3], p[4], p[5] * 2.0)));
                qi += 6;
                p
            },
        ));
    }
    // ribbon with a default radius: nodes with flag bit 2 carry their own (coordinates first)
    if sig.starts_with("vuA(v)A(u)A(u)") {
        let r0 = v.get(1)?.num().abs();
        let (s, q) = (v.get(3)?.floats(), v.get(4)?.floats());
        let (mut mi, mut qi) = (0, 0);
        return Some(assemble(
            v.get(2)?.list(),
            |flag| {
                let own = flag & 2 != 0;
                let p = s.get(mi..mi + if own { 3 } else { 2 }).map(|p| (p[0], p[1], if own { p[2] } else { r0 } * 2.0));
                mi += if own { 3 } else { 2 };
                p
            },
            |flag| {
                let own = flag & 2 != 0;
                let n = if own { 6 } else { 4 };
                let p = q.get(qi..qi + n).map(|p| {
                    let (cr, er) = if own { (p[4], p[5]) } else { (r0, r0) };
                    ((p[0], p[1], cr * 2.0), (p[2], p[3], er * 2.0))
                });
                qi += n;
                p
            },
        ));
    }
    // flat: one width, starts (x, y), segments (cx, cy, ex, ey)
    if sig.starts_with("vuA(v)A(S(uu))A(S(uuuu))") {
        let w = v.get(1)?.num();
        let (s, q) = (v.get(3)?.list(), v.get(4)?.list());
        let (mut mi, mut qi) = (0, 0);
        return Some(assemble(
            v.get(2)?.list(),
            |_| {
                let p = s.get(mi).map(|p| (p.list()[0].num(), p.list()[1].num(), w));
                mi += 1;
                p
            },
            |_| {
                let p = q.get(qi).and_then(|p| {
                    let p = p.floats();
                    (p.len() >= 4).then(|| ((p[0], p[1], w), (p[2], p[3], w)))
                });
                qi += 1;
                p
            },
        ));
    }
    // pencil: starts (x, y, azimuth, altitude, pressure), segments (word, 5 control, 5 end)
    if sig.starts_with("vuA(v)A(S(uuuuu))A(S(uuuuuuuuuuu))") {
        let w = v.get(1)?.num();
        let width = |pressure: f32| w * (0.5 + pressure.clamp(0.0, 1.0));
        let (s, q) = (v.get(3)?.list(), v.get(4)?.list());
        let (mut mi, mut qi) = (0, 0);
        return Some(assemble(
            v.get(2)?.list(),
            |_| {
                let p = s.get(mi).map(|p| {
                    let p = p.floats();
                    (p[0], p[1], width(p[4]))
                });
                mi += 1;
                p
            },
            |_| {
                let p = q.get(qi).and_then(|p| {
                    let p = p.floats();
                    (p.len() >= 11).then(|| ((p[1], p[2], width(p[5])), (p[6], p[7], width(p[10]))))
                });
                qi += 1;
                p
            },
        ));
    }
    None
}

/// Auto-shapes (#9 of a stroke) have no points of their own: lines, curves, rectangles, ellipses.
fn shape_paths(s: &M, w: f32) -> Vec<Path> {
    let pt = |m: &M, f| {
        let (x, y) = m.point(f);
        (x, y, w)
    };
    let lines = s.subs(1);
    if !lines.is_empty() {
        let p: Path = lines.iter().map(|m| (m.f(1), m.f(2), w)).collect();
        return vec![p];
    }
    if s.has(2) {
        let c = s.sub(2);
        let mut p = vec![pt(&c, 1)];
        quad(pt(&c, 1), pt(&c, 2), pt(&c, 3), &mut p);
        return vec![p];
    }
    if s.has(3) {
        let r = s.sub(3);
        let ((cx, cy), (rw, rh)) = (r.point(1), r.point(2));
        let (x0, y0, x1, y1) = (cx - rw / 2.0, cy - rh / 2.0, cx + rw / 2.0, cy + rh / 2.0);
        return vec![vec![(x0, y0, w), (x1, y0, w), (x1, y1, w), (x0, y1, w), (x0, y0, w)]];
    }
    if s.has(4) {
        let e = s.sub(4);
        let ((cx, cy), (rx, ry), th) = (e.point(1), e.point(2), e.f(3));
        let n = 96;
        let p: Path = (0..=n)
            .map(|i| {
                let t = i as f32 / n as f32 * std::f32::consts::TAU;
                (cx + rx * t.cos() * th.cos() - ry * t.sin() * th.sin(), cy + rx * t.cos() * th.sin() + ry * t.sin() * th.cos(), w)
            })
            .collect();
        return vec![p];
    }
    vec![]
}

// ---- text -------------------------------------------------------------------------------------------

/// Plain text of Cocoa RTF, with the first font size (half-points) and colour it sets.
fn rtf_text(rtf: &[u8]) -> (String, Option<f32>, Option<String>) {
    let s = rtf;
    let mut out = String::new();
    let (mut size, mut color_idx) = (None, None);
    let mut colors: Vec<String> = vec![];
    let (mut r, mut g, mut b) = (0u8, 0u8, 0u8);
    // groups whose text is not shown, by depth; colour table depth
    let mut depth = 0i32;
    let mut skip_at: Option<i32> = None;
    let mut colortbl_at: Option<i32> = None;
    let mut skip_chars = 0;
    let mut uc = 1;
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        match c {
            b'{' => {
                depth += 1;
                i += 1;
                // destinations: {\* …}, font table, styles, info
                let rest = &s[i..];
                if skip_at.is_none() && (rest.starts_with(b"\\*") || rest.starts_with(b"\\fonttbl") || rest.starts_with(b"\\stylesheet") || rest.starts_with(b"\\info") || rest.starts_with(b"\\expandedcolortbl")) {
                    skip_at = Some(depth);
                }
                if rest.starts_with(b"\\colortbl") {
                    colortbl_at = Some(depth);
                }
            }
            b'}' => {
                if skip_at == Some(depth) {
                    skip_at = None;
                }
                if colortbl_at == Some(depth) {
                    colortbl_at = None;
                }
                depth -= 1;
                i += 1;
            }
            b'\\' => {
                i += 1;
                let Some(&n) = s.get(i) else { break };
                if n == b'\\' || n == b'{' || n == b'}' {
                    if skip_at.is_none() {
                        out.push(n as char);
                    }
                    i += 1;
                    continue;
                }
                if n == b'\'' {
                    let hex = std::str::from_utf8(s.get(i + 1..i + 3).unwrap_or(b"3f")).unwrap_or("3f");
                    let byte = u8::from_str_radix(hex, 16).unwrap_or(b'?');
                    if skip_at.is_none() && colortbl_at.is_none() {
                        if skip_chars > 0 {
                            skip_chars -= 1;
                        } else {
                            out.push(cp1252(byte));
                        }
                    }
                    i += 3;
                    continue;
                }
                if !n.is_ascii_alphabetic() {
                    // \~ and other symbols; a backslash before a newline is a paragraph
                    if (n == b'\n' || n == b'\r') && skip_at.is_none() {
                        out.push('\n');
                    }
                    i += 1;
                    continue;
                }
                let start = i;
                while i < s.len() && s[i].is_ascii_alphabetic() {
                    i += 1;
                }
                let word = std::str::from_utf8(&s[start..i]).unwrap_or("");
                let nstart = i;
                if i < s.len() && (s[i] == b'-' || s[i].is_ascii_digit()) {
                    i += 1;
                    while i < s.len() && s[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                let num: Option<i64> = std::str::from_utf8(&s[nstart..i]).ok().and_then(|t| t.parse().ok());
                if i < s.len() && s[i] == b' ' {
                    i += 1;
                }
                if colortbl_at.is_some() {
                    match word {
                        "red" => r = num.unwrap_or(0) as u8,
                        "green" => g = num.unwrap_or(0) as u8,
                        "blue" => b = num.unwrap_or(0) as u8,
                        _ => {}
                    }
                    continue;
                }
                if skip_at.is_some() {
                    continue;
                }
                match word {
                    "par" | "line" => out.push('\n'),
                    "tab" => out.push('\t'),
                    "fs" if size.is_none() => size = num.map(|n| n as f32),
                    "cf" if color_idx.is_none() => color_idx = num,
                    "uc" => uc = num.unwrap_or(1).max(0) as usize,
                    "u" => {
                        let n = num.unwrap_or(63);
                        let n = if n < 0 { n + 65536 } else { n };
                        out.push(char::from_u32(n as u32).unwrap_or('?'));
                        skip_chars = uc;
                    }
                    _ => {}
                }
            }
            b'\n' | b'\r' => i += 1,
            b';' if colortbl_at.is_some() => {
                colors.push(format!("#{r:02x}{g:02x}{b:02x}"));
                (r, g, b) = (0, 0, 0);
                i += 1;
            }
            _ => {
                if skip_at.is_none() && colortbl_at.is_none() {
                    if skip_chars > 0 {
                        skip_chars -= 1;
                    } else {
                        // UTF-8 never appears raw in Cocoa RTF, but be lenient
                        out.push(c as char);
                    }
                }
                i += 1;
            }
        }
    }
    // \cf0 is the default (black); \cf1 is the first entry after the leading empty one
    let color = color_idx.filter(|&k| k > 0).and_then(|k| colors.get(k as usize).cloned());
    (out.trim_end().to_string(), size, color)
}

fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xa0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char }
}

/// The first readable string inside a (nested) message: the text of a newer text box.
fn first_text(b: &[u8], depth: usize) -> Option<String> {
    for (_, f) in msg(b)? {
        if let Field::Bytes(s) = f {
            if let Ok(t) = std::str::from_utf8(s) {
                if !t.is_empty() && t.chars().all(|c| !c.is_control() || c == '\n' || c == '\t') {
                    return Some(t.to_string());
                }
            }
            if depth < 6 {
                if let Some(t) = first_text(s, depth + 1) {
                    return Some(t);
                }
            }
        }
    }
    None
}

// ---- the document -----------------------------------------------------------------------------------

/// One converted page (page units: points).
pub struct GnPage {
    pub w: f32,
    pub h: f32,
    /// background: (asset id, "pdf" page index) or (asset id, image)
    pub bg: Option<Value>,
    pub strokes: Vec<Value>,
    pub objects: Vec<Value>,
    pub typed: Vec<Value>,
}

pub struct GnDoc {
    pub title: String,
    pub pages: Vec<GnPage>,
    /// asset id → (ext, bytes)
    pub assets: HashMap<String, (&'static str, Vec<u8>)>,
    pub warnings: Vec<String>,
}

fn new_id() -> String {
    crate::tree::new_id()
}

fn asset_id(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>()[..40].to_string()
}

fn file_ext(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"%PDF") {
        Some("pdf")
    } else {
        crate::onenote::image_ext(b)
    }
}

/// The notes member of a page: its UUID plus one (as a 128-bit number), in the same letter case.
fn next_uuid(u: &str) -> Option<String> {
    let hex: String = u.chars().filter(|c| *c != '-').collect();
    let n = u128::from_str_radix(&hex, 16).ok()?.wrapping_add(1);
    let h = format!("{n:032x}");
    let h = if u.chars().any(|c| c.is_ascii_uppercase()) { h.to_uppercase() } else { h };
    Some(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

fn rgba(m: &M) -> (String, f32) {
    let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    (format!("#{:02x}{:02x}{:02x}", c(m.f(1)), c(m.f(2)), c(m.f(3))), m.f(4))
}

/// Read a .goodnotes file.
pub fn convert(data: &[u8], fallback_title: &str) -> Res<GnDoc> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|_| "This is not a Goodnotes file.".to_string())?;
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..zip.len() {
        let mut e = zip.by_index(i).map_err(|e| e.to_string())?;
        if e.is_dir() {
            continue;
        }
        let mut buf = vec![];
        e.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        files.insert(e.name().to_string(), buf);
    }
    let events = files.get("index.events.pb").ok_or("This is not a Goodnotes file (no index.events.pb).")?;
    let mut title = None;
    // template → (attachment, 1-based page in it, size)
    let mut templates: HashMap<String, (String, u64, (f32, f32))> = HashMap::new();
    // page → (template, order key); deleted pages
    let mut pages: HashMap<String, (String, Vec<u8>)> = HashMap::new();
    let mut deleted: std::collections::HashSet<String> = Default::default();
    for r in records(events) {
        let e = M::of(r);
        let entity = e.str(1).unwrap_or_default();
        if e.has(30) {
            if let Some(t) = e.sub(30).sub(2).str(1).filter(|t| !t.trim().is_empty()) {
                title = Some(t);
            }
        }
        if e.has(2) {
            let t = e.sub(2);
            let size = t.point(8);
            templates.insert(entity.clone(), (t.str(4).unwrap_or_default(), t.u(5).unwrap_or(1).max(1), size));
        }
        for kind in [54, 55] {
            if e.has(kind) {
                let p = e.sub(kind);
                let id = p.str(2).unwrap_or(entity.clone());
                let entry = pages.entry(id).or_insert((String::new(), vec![]));
                if let Some(t) = p.sub(3).str(1) {
                    entry.0 = t;
                }
                if let Some(k) = p.sub(if kind == 54 { 4 } else { 3 }).bytes(1) {
                    entry.1 = k.to_vec();
                }
            }
        }
        if e.has(56) {
            deleted.insert(e.sub(56).str(2).unwrap_or(entity));
        }
    }
    let mut order: Vec<(String, String, Vec<u8>)> = pages.into_iter().filter(|(id, _)| !deleted.contains(id)).map(|(id, (t, k))| (id, t, k)).collect();
    order.sort_by(|a, b| a.2.cmp(&b.2));

    let mut doc = GnDoc { title: title.unwrap_or_else(|| fallback_title.to_string()), pages: vec![], assets: HashMap::new(), warnings: vec![] };
    let mut add_asset = |doc: &mut GnDoc, bytes: &[u8]| -> Option<(String, &'static str)> {
        let ext = file_ext(bytes)?;
        let id = asset_id(bytes);
        doc.assets.entry(id.clone()).or_insert_with(|| (ext, bytes.to_vec()));
        Some((id, ext))
    };
    let mut unknown = 0usize;
    for (n, (page_id, template, _)) in order.iter().enumerate() {
        let (att, pdf_page, (cw, ch)) = templates.get(template).cloned().unwrap_or((String::new(), 1, (834.24, 1078.825)));
        let (cw, ch) = if cw > 1.0 && ch > 1.0 { (cw, ch) } else { (834.24, 1078.825) };
        let mut page = GnPage { w: cw * PT, h: ch * PT, bg: None, strokes: vec![], objects: vec![], typed: vec![] };
        if let Some(bytes) = files.get(&format!("attachments/{att}")) {
            match add_asset(&mut doc, bytes) {
                Some((id, "pdf")) => page.bg = Some(json!({ "type": "pdf", "asset": id, "page": pdf_page - 1 })),
                Some((id, _)) => page.bg = Some(json!({ "type": "image", "asset": id })),
                None => {}
            }
        }
        let notes = next_uuid(page_id).and_then(|u| files.get(&format!("notes/{u}"))).or_else(|| files.get(&format!("notes/{page_id}")));
        // elements: (metadata, content) pairs; a later version of an element replaces the earlier
        let mut elements: Vec<(String, Option<&[u8]>, Option<String>)> = vec![];
        let mut at: HashMap<String, usize> = HashMap::new();
        let recs = notes.map(|b| records(b)).unwrap_or_default();
        for pair in recs.chunks(2) {
            let [meta, content] = pair else { continue };
            let m = M::of(meta);
            let id = m.str(1).unwrap_or_else(new_id);
            let gone = m.u(3).unwrap_or(0) != 0;
            let item = (id.clone(), (!gone).then_some(*content), m.str(4));
            match at.get(&id) {
                Some(&k) => elements[k] = item,
                None => {
                    at.insert(id, elements.len());
                    elements.push(item);
                }
            }
        }
        let mut typing_y = 36.0f32;
        for (_, content, attachment) in elements {
            let Some(content) = content else { continue };
            let Some(top) = msg(content) else { continue };
            let Some(&(kind, Field::Bytes(body))) = top.first() else { continue };
            let el = M::of(body);
            match kind {
                7 => stroke(&el, &mut page),
                1 => {
                    let r = el.sub(2);
                    let ((x, y), (w, h)) = (r.point(1), r.point(2));
                    let att = el.str(4).or(attachment).unwrap_or_default();
                    if let Some((id, ext)) = files.get(&format!("attachments/{att}")).and_then(|b| add_asset(&mut doc, b)) {
                        if ext != "pdf" {
                            page.objects.push(json!({ "id": new_id(), "type": "image", "x": x * PT, "y": y * PT, "w": w * PT, "h": h * PT, "rot": 0, "src": format!("asset:{id}") }));
                        }
                    }
                }
                8 => {
                    let r = el.sub(2);
                    let ((x, y), (w, h)) = (r.point(1), r.point(2));
                    let (text, size, color) = rtf_text(el.bytes(6).unwrap_or(&[]));
                    let fill = el.has(7).then(|| rgba(&el.sub(7)).0).filter(|c| c != "#ffffff");
                    text_box(&mut page, &text, x * PT, y * PT, w * PT, h * PT, size.map(|s| s / 2.0 * PT).unwrap_or(10.0), color, fill);
                }
                21 => {
                    let (x, y) = el.sub(20).point(1);
                    let (w, h) = el.sub(21).point(2);
                    let t = el.sub(32);
                    let text = t.sub(1).bytes(2).and_then(apple_lz4).and_then(|b| first_text(&b, 0)).unwrap_or_default();
                    let size = t.sub(5).sub(1).f(40);
                    let size = if size > 0.0 { size * PT } else { 12.0 };
                    let w = if w.is_finite() && w > 1.0 { w } else { 300.0 };
                    let h = if h.is_finite() && h > 1.0 { h } else { size / PT * 1.4 };
                    text_box(&mut page, &text, x * PT, y * PT, w * PT, h * PT, size, None, None);
                }
                12 => {
                    // typed text without a box: stack it from the top of the page
                    let (text, size, color) = rtf_text(el.bytes(3).unwrap_or(&[]));
                    if !text.trim().is_empty() {
                        let size = size.map(|s| s / 2.0 * PT).unwrap_or(10.0);
                        let lines = text.lines().count().max(1) as f32;
                        let h = lines * size * 1.3 + 4.0;
                        let pw = page.w;
                        text_box(&mut page, &text, 36.0, typing_y, pw - 72.0, h, size, color, None);
                        typing_y += h + 4.0;
                    }
                }
                9 => {} // the fill of a shape: its outline is a stroke of its own
                _ => unknown += 1,
            }
        }
        doc.pages.push(page);
        let _ = n;
    }
    if unknown > 0 {
        doc.warnings.push(format!("{unknown} element(s) of a kind goodink does not know yet were left out"));
    }
    if doc.pages.is_empty() {
        return Err("This Goodnotes file has no pages.".into());
    }
    Ok(doc)
}

// ---- into the library ---------------------------------------------------------------------------------

/// Import a .goodnotes file as one notebook in the library folder `folder` (None = the top level).
/// Returns the library scan afterwards and the new notebook: { scan, id, title, pages, warnings }.
#[tauri::command]
pub async fn goodnotes_import(app: tauri::AppHandle, file: String, folder: Option<String>) -> Res<Value> {
    use crate::store::write_atomic;
    use crate::{folder_dir, tree, unique_in, AppState};
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::PathBuf::from(&file);
        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Goodnotes".into());
        // an undocumented format: a file it does not understand is an error, not a crash
        let doc = std::panic::catch_unwind(|| convert(&data, &stem)).map_err(|_| "This Goodnotes file could not be read.".to_string())??;
        let state = app.state::<AppState>();
        // exclusive: nothing moves while the notebook is written and scanned
        let store = state.store.write().unwrap_or_else(|e| e.into_inner());
        let dest = folder_dir(&store, folder.as_deref())?;
        let nb = unique_in(&dest, &format!("{}.{}", tree::file_name(&doc.title), tree::NB_EXT));
        let mut assets = serde_json::Map::new();
        for (aid, (ext, bytes)) in &doc.assets {
            write_atomic(&nb.join("assets").join(format!("{aid}.{ext}")), bytes)?;
            assets.insert(aid.clone(), json!({ "ext": ext, "bytes": bytes.len() }));
        }
        let mut metas = vec![];
        let mut index = serde_json::Map::new();
        for p in doc.pages {
            let pid = tree::new_id();
            let mut meta = json!({ "id": pid, "w": p.w, "h": p.h, "template": { "kind": "blank", "paper": "white" }, "rotation": 0 });
            if let Some(bg) = p.bg {
                meta["bg"] = bg;
            }
            let content = json!({ "v": 1, "strokes": p.strokes, "objects": p.objects });
            write_atomic(&nb.join("pages").join(format!("{pid}.json")), content.to_string().as_bytes())?;
            index.insert(pid, json!({ "typed": p.typed, "pdf": [], "ocr": [], "ocrStamp": -1 }));
            metas.push(meta);
        }
        let pages = metas.len();
        let nb_doc = json!({ "id": tree::new_id(), "pages": metas, "outline": [], "recordings": [], "assets": assets });
        write_atomic(&nb.join("index.json"), json!({ "pages": index }).to_string().as_bytes())?;
        write_atomic(&nb.join("notebook.json"), nb_doc.to_string().as_bytes())?;
        let scan = store.rescan();
        let id = store.id_at(&nb);
        crate::log(&format!("Goodnotes import: \"{}\", {pages} pages from {file}, {} warnings", doc.title, doc.warnings.len()));
        Ok(json!({ "scan": scan, "id": id, "title": doc.title, "pages": pages, "warnings": doc.warnings }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn text_box(page: &mut GnPage, text: &str, x: f32, y: f32, w: f32, h: f32, size: f32, color: Option<String>, fill: Option<String>) {
    if text.trim().is_empty() {
        return;
    }
    let mut o = json!({ "id": new_id(), "type": "text", "x": x, "y": y, "w": w.max(40.0), "h": h.max(size * 1.3), "rot": 0, "text": text, "font": "sans", "size": size.clamp(4.0, 96.0), "color": color.unwrap_or_else(|| "#1b1b1f".into()), "align": "left" });
    if let Some(f) = fill {
        o["bgColor"] = json!(f);
    }
    for word in text.split_whitespace() {
        page.typed.push(json!({ "t": word, "b": [x, y, w, h] }));
    }
    page.objects.push(o);
}

fn stroke(s: &M, page: &mut GnPage) {
    let Some(raw) = s.bytes(2).and_then(apple_lz4) else { return };
    let Some((sig, vals)) = tpl(&raw) else { return };
    let shape = s.sub(9);
    let mut paths = stroke_paths(&sig, &vals).unwrap_or_default();
    if paths.iter().all(|p| p.len() < 2) && !shape.0.is_empty() {
        let w = if shape.f(15) > 0.0 { shape.f(15) } else { vals.get(1).map(|v| v.num()).unwrap_or(2.0) };
        paths = shape_paths(&shape, w);
    }
    let (color, alpha) = rgba(&s.sub(4));
    let highlighter = s.u(5) == Some(1) || (alpha > 0.0 && alpha < 0.9);
    // a lasso move: added to every point
    let (dx, dy) = (s.sub(6).f(1), s.sub(6).f(2));
    for p in paths {
        if p.is_empty() {
            continue;
        }
        // widths: full width in canvas units per node; goodink's fountain pen scales its base
        // width by 0.38 + 1.25 · pressure, so a varying width becomes pressure
        let wmax = p.iter().map(|q| q.2).fold(0.0f32, f32::max).max(0.1);
        let wmin = p.iter().map(|q| q.2).fold(f32::MAX, f32::min);
        let varies = wmax - wmin > wmax * 0.15 && !highlighter;
        let base = if varies { wmax / 1.63 } else { wmax } * PT;
        let mut buf = Vec::with_capacity(p.len() * 12);
        for (x, y, w) in &p {
            let pressure = if varies { ((w * PT / base) - 0.38) / 1.25 } else { 0.5 };
            for v in [(x + dx) * PT, (y + dy) * PT, pressure.clamp(0.0, 1.0)] {
                buf.extend_from_slice(&v.to_le_bytes());
            }
        }
        use base64::Engine;
        let mut j = json!({ "id": new_id(), "k": if highlighter { "highlighter" } else { "pen" }, "c": color, "w": base.clamp(0.2, 60.0), "pts": base64::engine::general_purpose::STANDARD.encode(&buf) });
        if !highlighter {
            j["pen"] = json!(if varies { "fountain" } else { "ball" });
        }
        if !shape.0.is_empty() {
            j["shape"] = json!(1);
        }
        page.strokes.push(j);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GOODNOTES_SAMPLES=<folder of .goodnotes files> cargo test goodnotes -- --nocapture
    #[test]
    fn goodnotes_samples() {
        let Ok(dir) = std::env::var("GOODNOTES_SAMPLES") else { return };
        let mut n = 0;
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.extension().map(|x| x != "goodnotes").unwrap_or(true) {
                continue;
            }
            let doc = convert(&std::fs::read(&p).unwrap(), "x").unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            let strokes: usize = doc.pages.iter().map(|p| p.strokes.len()).sum();
            let objects: usize = doc.pages.iter().map(|p| p.objects.len()).sum();
            println!("{}: \"{}\" {} pages, {} strokes, {} objects, {} assets, bg {:?}, warnings {:?}", p.file_name().unwrap().to_string_lossy(), doc.title, doc.pages.len(), strokes, objects, doc.assets.len(), doc.pages.iter().map(|p| p.bg.is_some()).collect::<Vec<_>>(), doc.warnings);
            for pg in &doc.pages {
                for o in &pg.objects {
                    if o["type"] == "text" {
                        println!("   text {:?} size {}", o["text"].as_str().unwrap_or("").chars().take(50).collect::<String>(), o["size"]);
                    }
                }
            }
            n += 1;
        }
        assert!(n > 0);
    }

    #[test]
    fn rtf() {
        let (t, size, color) = rtf_text(br"{\rtf1\ansi\ansicpg1252{\fonttbl\f0\fswiss HelveticaNeue;}{\colortbl;\red255\green255\blue255;\red230\green0\blue0;}\f0\fs40 \cf2 Hallo \'fcber\par Zeile \'802}");
        assert_eq!(t, "Hallo über\nZeile €2");
        assert_eq!(size, Some(40.0));
        assert_eq!(color.as_deref(), Some("#e60000"));
    }

    #[test]
    fn uuid_plus_one() {
        assert_eq!(next_uuid("A6B1FDA8-68E9-4F4B-B4DA-CE7ED8F15D14").unwrap(), "A6B1FDA8-68E9-4F4B-B4DA-CE7ED8F15D15");
        assert_eq!(next_uuid("27B0C0FB-E6F5-4C9E-BDA0-98553E08EC7F").unwrap(), "27B0C0FB-E6F5-4C9E-BDA0-98553E08EC80");
    }
}
