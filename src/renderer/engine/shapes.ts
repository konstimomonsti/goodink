// Shape recognition for draw-and-hold and the shape tool. Input: x,y,p triples. Output: clean
// geometry as x,y,p triples, or null when the stroke does not look like a shape.

export interface ShapeResult {
  kind: 'line' | 'polyline' | 'triangle' | 'rectangle' | 'polygon' | 'ellipse' | 'circle';
  pts: Float32Array;
  closed: boolean;
}

type P = [number, number];

function toPoints(pts: Float32Array): P[] {
  const out: P[] = [];
  for (let i = 0; i < pts.length; i += 3) out.push([pts[i], pts[i + 1]]);
  return out;
}

function pathLength(p: P[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

function resample(p: P[], n: number): P[] {
  const total = pathLength(p);
  if (total === 0 || p.length < 2) return p.slice();
  const step = total / (n - 1);
  const out: P[] = [p[0]];
  let acc = 0;
  let prev = p[0];
  for (let i = 1; i < p.length; i++) {
    let cur = p[i];
    let d = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const q: P = [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
      out.push(q);
      prev = q;
      d = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push(p[p.length - 1]);
  return out.slice(0, n);
}

function perpDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

function perpSegDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

function douglasPeucker(p: P[], eps: number): P[] {
  if (p.length < 3) return p.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = perpDist(p[i], p[0], p[p.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    const a = douglasPeucker(p.slice(0, idx + 1), eps);
    const b = douglasPeucker(p.slice(idx), eps);
    return a.slice(0, -1).concat(b);
  }
  return [p[0], p[p.length - 1]];
}

const pack = (p: P[], pressure = 0.5): Float32Array => {
  const out = new Float32Array(p.length * 3);
  p.forEach(([x, y], i) => {
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = pressure;
  });
  return out;
};

function snapAngle(a: P, b: P): P {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ang = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(ang - snapped) < (4 * Math.PI) / 180) {
    const len = Math.hypot(dx, dy);
    return [a[0] + Math.cos(snapped) * len, a[1] + Math.sin(snapped) * len];
  }
  return b;
}

function interiorAngle(a: P, b: P, c: P): number {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const d = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) || 1);
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

function fitEllipse(p: P[]) {
  let cx = 0, cy = 0;
  for (const [x, y] of p) {
    cx += x;
    cy += y;
  }
  cx /= p.length;
  cy /= p.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of p) {
    sxx += (x - cx) ** 2;
    syy += (y - cy) ** 2;
    sxy += (x - cx) * (y - cy);
  }
  sxx /= p.length;
  syy /= p.length;
  sxy /= p.length;
  const tr = sxx + syy, dt = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - dt));
  const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - dt));
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let a = Math.sqrt(2 * l1), b = Math.sqrt(2 * Math.max(l2, 1e-6));
  const c = Math.cos(theta), s = Math.sin(theta);
  // refine radii with mean projected extents, then score
  let err = 0;
  for (const [x, y] of p) {
    const u = (x - cx) * c + (y - cy) * s, v = -(x - cx) * s + (y - cy) * c;
    err += Math.abs(Math.sqrt((u / a) ** 2 + (v / b) ** 2) - 1);
  }
  err /= p.length;
  return { cx, cy, a, b, theta, err };
}

function ellipsePoints(cx: number, cy: number, a: number, b: number, theta: number, n = 72): P[] {
  const out: P[] = [];
  const c = Math.cos(theta), s = Math.sin(theta);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const u = a * Math.cos(t), v = b * Math.sin(t);
    out.push([cx + u * c - v * s, cy + u * s + v * c]);
  }
  return out;
}

export function recognizeShape(raw: Float32Array): ShapeResult | null {
  const pts = toPoints(raw);
  if (pts.length < 4) return null;
  const L = pathLength(pts);
  if (L < 12) return null;
  const p = resample(pts, 96);
  const first = p[0], last = p[p.length - 1];
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
  const closed = gap < Math.max(0.18 * L, 10);

  if (!closed) {
    let maxDev = 0;
    for (const q of p) maxDev = Math.max(maxDev, perpDist(q, first, last));
    if (maxDev < Math.max(0.045 * L, 3)) return { kind: 'line', pts: pack([first, snapAngle(first, last)]), closed: false };
    const simp = douglasPeucker(p, 0.05 * L);
    if (simp.length <= 4) {
      const sharp = simp.slice(1, -1).every((v, i) => interiorAngle(simp[i], v, simp[i + 2]) < 2.6);
      if (sharp) return { kind: 'polyline', pts: pack(simp), closed: false };
    }
    return null;
  }

  // closed: compare polygon fit vs ellipse fit
  const loop = p.slice(0, -1);
  const ell = fitEllipse(loop);
  // Rotate the loop so DP starts at the point farthest from the centroid (a likely corner)
  let far = 0, farD = -1;
  loop.forEach((q, i) => {
    const d = Math.hypot(q[0] - ell.cx, q[1] - ell.cy);
    if (d > farD) {
      farD = d;
      far = i;
    }
  });
  const rot = loop.slice(far).concat(loop.slice(0, far));
  rot.push(rot[0]);
  let poly = douglasPeucker(rot, 0.06 * L).slice(0, -1);
  // merge near-duplicate vertices
  poly = poly.filter((v, i) => i === 0 || Math.hypot(v[0] - poly[i - 1][0], v[1] - poly[i - 1][1]) > L * 0.04);
  const corners = poly.length;
  const sharpPoly = corners >= 3 && corners <= 5 && poly.every((v, i) => interiorAngle(poly[(i - 1 + corners) % corners], v, poly[(i + 1) % corners]) < 2.55);

  // Mean distance from the stroke to the candidate polygon, relative to its size, so it can be
  // compared with the ellipse fit error (which is relative to the radius).
  let polyErr = Infinity;
  if (sharpPoly) {
    let sum = 0;
    for (const q of loop) {
      let best = Infinity;
      for (let k = 0; k < corners; k++) best = Math.min(best, perpSegDist(q, poly[k], poly[(k + 1) % corners]));
      sum += best;
    }
    polyErr = sum / loop.length / ((ell.a + ell.b) / 2);
  }

  if (sharpPoly && polyErr < ell.err * 0.9) {
    if (corners === 4) {
      const angles = poly.map((v, i) => interiorAngle(poly[(i + 3) % 4], v, poly[(i + 1) % 4]));
      const rightish = angles.every((a) => Math.abs(a - Math.PI / 2) < 0.35);
      if (rightish) {
        // Fit an oriented rectangle along the first edge; snap to axis when nearly aligned.
        let ang = Math.atan2(poly[1][1] - poly[0][1], poly[1][0] - poly[0][0]);
        const snapped = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(ang - snapped) < 0.14) ang = snapped;
        const c = Math.cos(ang), s = Math.sin(ang);
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const [x, y] of poly) {
          const u = x * c + y * s, v = -x * s + y * c;
          u0 = Math.min(u0, u);
          u1 = Math.max(u1, u);
          v0 = Math.min(v0, v);
          v1 = Math.max(v1, v);
        }
        const back = (u: number, v: number): P => [u * c - v * s, u * s + v * c];
        const r = [back(u0, v0), back(u1, v0), back(u1, v1), back(u0, v1)];
        return { kind: 'rectangle', pts: pack([...r, r[0]]), closed: true };
      }
    }
    if (corners === 3) return { kind: 'triangle', pts: pack([...poly, poly[0]]), closed: true };
    return { kind: 'polygon', pts: pack([...poly, poly[0]]), closed: true };
  }

  if (ell.err < 0.16) {
    let { a, b, theta } = ell;
    const isCircle = Math.min(a, b) / Math.max(a, b) > 0.86;
    if (isCircle) {
      a = b = (a + b) / 2;
      theta = 0;
    } else {
      const snapped = Math.round(theta / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(theta - snapped) < 0.15) theta = snapped;
    }
    return { kind: isCircle ? 'circle' : 'ellipse', pts: pack(ellipsePoints(ell.cx, ell.cy, a, b, theta)), closed: true };
  }
  return null;
}
