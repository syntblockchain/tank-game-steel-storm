// AirGesture-style right-hand webcam control (4 triangles + center circle)
// replacing / driving the right joystick on both laptop and mobile.
// Uses MediaPipe Hands when reachable, with an offline pure-JS CV tracker fallback
// and an interactive pad fallback when no camera is available.

import { clamp, TAU } from './util.js';
import { fontSpec, tr } from './i18n.js';

const MP_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/';
const MP_HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Barycentric AirGesture 5-zone classification:
// center circle (radius = min(w, h) * 0.20) + 4 triangles (up, down, left, right).
export function classifyAirGesture(x, y, w, h, handState, circleRatio = 0.20) {
  if (!handState || handState === 'none') {
    return { action: 'none', zone: 'none', dx: 0, dy: 0, angle: null, fire: false };
  }
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * circleRatio;
  const d = Math.hypot(x - cx, y - cy);
  const nx = (x - cx) / Math.max(1, w / 2);
  const ny = (y - cy) / Math.max(1, h / 2);

  let zone = 'circle';
  if (d > r) {
    if (Math.abs(ny) >= Math.abs(nx)) zone = ny < 0 ? 'up' : 'down';
    else zone = nx < 0 ? 'left' : 'right';
  }

  const dirs = {
    up: { dx: 0, dy: -1, angle: -Math.PI / 2 },
    down: { dx: 0, dy: 1, angle: Math.PI / 2 },
    left: { dx: -1, dy: 0, angle: Math.PI },
    right: { dx: 1, dy: 0, angle: 0 },
    circle: { dx: 0, dy: 0, angle: null },
  };
  const dir = dirs[zone];

  if (handState === 'open') {
    return { action: 'fire', zone, dx: dir.dx, dy: dir.dy, angle: dir.angle, fire: true };
  }
  if (zone === 'circle') {
    return { action: 'idle', zone: 'circle', dx: 0, dy: 0, angle: null, fire: false };
  }
  return { action: zone, zone, dx: dir.dx, dy: dir.dy, angle: dir.angle, fire: false };
}

export function classifyLandmarksOpenClosed(lm, prevOpen = false) {
  if (!lm || lm.length < 21) return 'none';
  const palm = Math.max(1e-4, dist2(lm[0], lm[9]), dist2(lm[0], lm[5]));
  const fingers = [
    [5, 6, 8],
    [9, 10, 12],
    [13, 14, 16],
    [17, 18, 20],
  ];
  let ext = 0;
  let spreadSum = 0;
  for (const [mcp, pip, tip] of fingers) {
    const dTipWrist = dist2(lm[tip], lm[0]);
    const dPipWrist = dist2(lm[pip], lm[0]);
    const dTipMcp = dist2(lm[tip], lm[mcp]);
    spreadSum += dTipWrist / palm;
    if (dTipWrist > dPipWrist * 1.10 && dTipMcp > palm * 0.55) ext++;
  }
  // Thumb extension relative to pinky MCP (17) and index MCP (5)
  if (dist2(lm[4], lm[17]) > dist2(lm[2], lm[17]) * 1.15 && dist2(lm[4], lm[5]) > palm * 0.42) ext++;
  const avgSpread = spreadSum / 4;

  if (prevOpen) {
    return (ext <= 1 && avgSpread < 1.25) ? 'closed' : 'open';
  }
  return (ext >= 3 || (ext >= 2 && avgSpread >= 1.55)) ? 'open' : 'closed';
}

export function palmCenter(lm) {
  const ids = [0, 5, 9, 13, 17];
  let sx = 0, sy = 0;
  for (const i of ids) {
    sx += lm[i].x;
    sy += lm[i].y;
  }
  return { x: clamp(sx / ids.length, 0, 1), y: clamp(sy / ids.length, 0, 1) };
}

export function pickRightHand(results) {
  const lms = results && results.multiHandLandmarks;
  if (!lms || !lms.length) return null;
  if (lms.length === 1) return lms[0];
  const handed = results.multiHandedness || [];
  let bestIdx = -1;
  let bestScore = -1e9;
  for (let i = 0; i < lms.length; i++) {
    const h = handed[i];
    const isRight = h && (h.label === 'Right' || h.displayName === 'Right');
    const c = palmCenter(lms[i]);
    const score = (isRight ? 10 : 0) + c.x;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return lms[bestIdx >= 0 ? bestIdx : 0];
}

// Offline pure-JS skin + motion blob tracker fallback when MediaPipe is unavailable.
export class FallbackCvTracker {
  constructor() {
    this.w = 72;
    this.h = 54;
    this.canvas = null;
    this.ctx = null;
    this.prevGray = null;
    this.prevOpen = false;
    this.smoothX = 0.5;
    this.smoothY = 0.5;
    this.hasLock = false;
    this.missCount = 0;
  }

  _ensureCanvas() {
    if (this.canvas || typeof document === 'undefined') return;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prevGray = new Uint8Array(this.w * this.h);
  }

  process(video) {
    this._ensureCanvas();
    if (!this.ctx) return null;
    const { w, h, ctx } = this;
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    const data = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const p = idx * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        const motion = Math.abs(lum - this.prevGray[idx]);
        this.prevGray[idx] = lum;

        const isSkin = lum > 42 && cb >= 76 && cb <= 129 && cr >= 133 && cr <= 176 && r > g * 1.03 && r > b;
        if (isSkin && (motion > 7 || (this.hasLock && Math.hypot(x / w - this.smoothX, y / h - this.smoothY) < 0.28))) {
          mask[idx] = 1;
        }
      }
    }

    // Connected component search over mask
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let bestBlob = null;
    let bestScore = 0;

    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || seen[i]) continue;
      let head = 0, tail = 0;
      queue[tail++] = i;
      seen[i] = 1;
      let area = 0, sx = 0, sy = 0;
      let minX = w, maxX = 0, minY = h, maxY = 0;
      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur / w) | 0;
        area++;
        sx += cx;
        sy += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const nbs = [cur - 1, cur + 1, cur - w, cur + w];
        for (const nb of nbs) {
          if (nb < 0 || nb >= w * h || seen[nb] || !mask[nb]) continue;
          const nx = nb % w;
          if (Math.abs(nx - cx) > 1) continue;
          seen[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (area < 24) continue;
      const cxN = sx / area / w;
      const cyN = sy / area / h;
      const rightBias = 0.7 + cxN * 0.5;
      const lockBonus = this.hasLock && Math.hypot(cxN - this.smoothX, cyN - this.smoothY) < 0.22 ? 1.5 : 1.0;
      const score = area * rightBias * lockBonus;
      if (score > bestScore) {
        bestScore = score;
        bestBlob = { area, cxN, cyN, minX, maxX, minY, maxY };
      }
    }

    if (!bestBlob) {
      this.missCount++;
      if (this.missCount > 8) this.hasLock = false;
      return null;
    }

    this.missCount = 0;
    const alpha = this.hasLock ? 0.45 : 1;
    this.smoothX += (bestBlob.cxN - this.smoothX) * alpha;
    this.smoothY += (bestBlob.cyN - this.smoothY) * alpha;
    this.hasLock = true;

    const bw = Math.max(1, bestBlob.maxX - bestBlob.minX + 1);
    const bh = Math.max(1, bestBlob.maxY - bestBlob.minY + 1);
    const solidity = bestBlob.area / (bw * bh);

    // Count distinct finger runs across top 35% of the blob
    const probeY = clamp(Math.round(bestBlob.minY + bh * 0.28), 0, h - 1);
    let runs = 0, inRun = false;
    for (let x = bestBlob.minX; x <= bestBlob.maxX; x++) {
      const on = mask[probeY * w + x] === 1;
      if (on && !inRun) runs++;
      inRun = on;
    }

    const state = this.prevOpen
      ? (solidity > 0.62 && runs <= 2 ? 'closed' : 'open')
      : (solidity < 0.49 || runs >= 3 ? 'open' : 'closed');
    this.prevOpen = state === 'open';

    return {
      x: this.smoothX,
      y: this.smoothY,
      state,
      bbox: {
        x0: bestBlob.minX / w,
        y0: bestBlob.minY / h,
        x1: (bestBlob.maxX + 1) / w,
        y1: (bestBlob.maxY + 1) / h,
      },
    };
  }
}

export class FreeHandController {
  constructor() {
    this.enabled = false;
    this.mode = 'smart'; // 'smart' (AirGesture move+aim when left idle, right stick aim when driving) | 'aim' (aim+fire only)
    this.status = 'off'; // 'off' | 'loading' | 'ready' | 'fallback' | 'nocam'
    this.backend = 'none'; // 'none' | 'mediapipe' | 'cv' | 'pad'
    this.video = null;
    this.stream = null;
    this.hands = null;
    this._busy = false;
    this._lastSend = 0;
    this._cv = new FallbackCvTracker();
    this._mpState = 'none';

    this.detected = false;
    this.handX = 0.5;
    this.handY = 0.5;
    this.handState = 'none'; // 'open' | 'closed' | 'none'
    this.landmarks = null;
    this.bbox = null;
    this.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');

    // Interactive pad state when webcam is absent/denied
    this.padPointerId = null;
    this.padOpen = false;
    this.lastDetectAt = 0;
  }

  toggleMode() {
    this.mode = this.mode === 'smart' ? 'aim' : 'smart';
  }

  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.detected = false;
    this.handState = 'none';
    this.landmarks = null;
    this.bbox = null;
    this.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');

    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.status = 'nocam';
      this.backend = 'pad';
      return;
    }

    this.status = 'loading';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
      if (!this.enabled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.srcObject = stream;
      await video.play().catch(() => {});
      this.video = video;

      // Start offline CV fallback immediately while MediaPipe initializes in background
      this.backend = 'cv';
      this.status = 'fallback';
      this._initMediaPipe();
    } catch {
      if (!this.enabled) return;
      this.status = 'nocam';
      this.backend = 'pad';
    }
  }

  disable() {
    this.enabled = false;
    this.status = 'off';
    this.backend = 'none';
    this.detected = false;
    this.handState = 'none';
    this.landmarks = null;
    this.bbox = null;
    this.padPointerId = null;
    this.padOpen = false;
    this.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video = null;
  }

  async _initMediaPipe() {
    try {
      const base = await this._loadHandsScript();
      if (!this.enabled || !window.Hands) return;
      const hands = new window.Hands({
        locateFile: (file) => `${base}${file}`,
      });
      hands.setOptions({
        selfieMode: true,
        maxNumHands: 2,
        modelComplexity: 0,
        minDetectionConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
      hands.onResults((res) => this._onMpResults(res));
      await hands.initialize();
      if (!this.enabled) {
        hands.close().catch(() => {});
        return;
      }
      this.hands = hands;
      this.backend = 'mediapipe';
      this.status = 'ready';
    } catch {
      if (this.enabled && this.video) {
        this.backend = 'cv';
        this.status = 'fallback';
      }
    }
  }

  _loadHandsScript() {
    if (typeof window !== 'undefined' && window.Hands) {
      return Promise.resolve(this._mpBase || MP_CDN);
    }
    const tryLoad = (base) =>
      new Promise((resolve, reject) => {
        if (typeof document === 'undefined') return reject(new Error('no dom'));
        const s = document.createElement('script');
        s.src = `${base}hands.js`;
        s.crossOrigin = 'anonymous';
        const timer = setTimeout(() => {
          s.remove();
          reject(new Error('timeout'));
        }, 7000);
        s.onload = () => {
          clearTimeout(timer);
          this._mpBase = base;
          resolve(base);
        };
        s.onerror = () => {
          clearTimeout(timer);
          s.remove();
          reject(new Error('load error'));
        };
        document.head.appendChild(s);
      });

    return tryLoad('./assets/mediapipe/hands/').catch(() => tryLoad(MP_CDN));
  }

  _onMpResults(results) {
    if (!this.enabled || this.backend !== 'mediapipe') return;
    const lm = pickRightHand(results);
    if (!lm) {
      if (performance.now() - this.lastDetectAt > 180) {
        this.detected = false;
        this.handState = 'none';
        this.landmarks = null;
        this.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
      }
      return;
    }
    const c = palmCenter(lm);
    const prevOpen = this._mpState === 'open';
    const state = classifyLandmarksOpenClosed(lm, prevOpen);
    this._mpState = state;
    this.landmarks = lm;
    this.bbox = null;
    this.detected = true;
    this.handX = c.x;
    this.handY = c.y;
    this.handState = state;
    this.lastDetectAt = performance.now();
    this.gesture = classifyAirGesture(c.x, c.y, 1, 1, state);
  }

  setPadInput(nx, ny, open) {
    this.detected = true;
    this.handX = clamp(nx, 0, 1);
    this.handY = clamp(ny, 0, 1);
    this.handState = open ? 'open' : 'closed';
    this.landmarks = null;
    this.bbox = null;
    this.lastDetectAt = performance.now();
    this.gesture = classifyAirGesture(this.handX, this.handY, 1, 1, this.handState);
  }

  clearPadInput() {
    this.padPointerId = null;
    if (this.backend === 'pad') {
      this.detected = false;
      this.handState = 'none';
      this.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
    }
  }

  update(nowMs) {
    if (!this.enabled) return;
    if (this.backend === 'mediapipe' && this.hands && this.video && this.video.readyState >= 2) {
      if (!this._busy && nowMs - this._lastSend >= 36) {
        this._busy = true;
        this._lastSend = nowMs;
        this.hands.send({ image: this.video }).catch(() => {}).finally(() => {
          this._busy = false;
        });
      }
      return;
    }
    if (this.backend === 'cv' && this.video && this.video.readyState >= 2) {
      if (nowMs - this._lastSend >= 40) {
        this._lastSend = nowMs;
        const res = this._cv.process(this.video);
        if (res) {
          this.detected = true;
          this.handX = res.x;
          this.handY = res.y;
          this.handState = res.state;
          this.bbox = res.bbox;
          this.landmarks = null;
          this.lastDetectAt = nowMs;
          this.gesture = classifyAirGesture(res.x, res.y, 1, 1, res.state);
        } else if (nowMs - this.lastDetectAt > 200) {
          this.detected = false;
          this.handState = 'none';
          this.bbox = null;
          this.gesture = classifyAirGesture(0.5, 0.5, 1, 1, 'none');
        }
      }
    }
  }
}

export function getFreeHandRect(layout) {
  const { w, h, narrow, padR, padB, minimap, buttons } = layout;
  if (w >= 960) {
    const topY = minimap.y + minimap.size + 14;
    const footerH = 24;
    const maxBottom = buttons.msl.y - buttons.msl.r - 10;
    const ph = clamp(maxBottom - topY - footerH, 90, 174);
    const pw = Math.round((ph * 4) / 3);
    return {
      x: w - padR - pw,
      y: topY,
      w: pw,
      h: ph,
      footerH,
    };
  }
  if (!narrow || h < 500) {
    // Mobile landscape (even compact 568x320): place cleanly at bottom-center between the two joysticks
    const pw = clamp(Math.round(w * 0.2), 112, 176);
    const ph = Math.round(pw * 0.72);
    return {
      x: Math.round(w / 2 - pw / 2),
      y: h - padB - ph - 22,
      w: pw,
      h: ph,
      footerH: 22,
    };
  }
  // Mobile portrait: right side under minimap + score, well above tank center and right buttons
  const pw = 148;
  const ph = 110;
  return {
    x: w - padR - pw,
    y: minimap.y + minimap.size + 62,
    w: pw,
    h: ph,
    footerH: 22,
  };
}

export function hitFreeHandPanel(x, y, layout, fh = null) {
  const r = getFreeHandRect(layout);
  if (x >= r.x && x <= r.x + r.w && y >= r.y + r.h && y <= r.y + r.h + r.footerH + 4) {
    if (fh && fh.backend === 'pad' && x >= r.x + r.w * 0.62) return 'padOpen';
    return 'mode';
  }
  if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
    return 'pad';
  }
  return null;
}

export function drawFreeHandOverlay(game, ctx, layout) {
  const fh = game.freeHand;
  if (!fh || !fh.enabled || game.state !== 'playing') return;

  const r = getFreeHandRect(layout);
  const { x, y, w, h, footerH } = r;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = Math.min(w, h) * 0.20;
  const g = fh.gesture;
  const t = tr(game.lang);

  ctx.save();

  // Panel backing
  ctx.fillStyle = 'rgba(10,14,12,0.82)';
  ctx.fillRect(x, y, w, h + footerH);

  // Mirrored webcam feed inside (x, y, w, h)
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (fh.video && fh.video.readyState >= 2) {
    ctx.save();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(fh.video, 0, 0, w, h);
    ctx.restore();
    ctx.fillStyle = 'rgba(8,12,10,0.28)';
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.fillStyle = 'rgba(18,24,20,0.92)';
    ctx.fillRect(x, y, w, h);
  }

  // 4 triangles overlay (Up, Down, Left, Right) + center Circle matching AirGesture
  const tris = [
    ['up', [[x, y], [x + w, y], [cx, cy]], 'rgba(79,195,247,0.16)', 'rgba(79,195,247,0.44)'],
    ['down', [[x, y + h], [x + w, y + h], [cx, cy]], 'rgba(79,195,247,0.16)', 'rgba(79,195,247,0.44)'],
    ['left', [[x, y], [x, y + h], [cx, cy]], 'rgba(232,211,106,0.14)', 'rgba(232,211,106,0.42)'],
    ['right', [[x + w, y], [x + w, y + h], [cx, cy]], 'rgba(232,211,106,0.14)', 'rgba(232,211,106,0.42)'],
  ];

  for (const [zone, pts, idleFill, activeFill] of tris) {
    const active = fh.detected && g.zone === zone;
    ctx.fillStyle = active ? (g.fire ? 'rgba(255,106,58,0.42)' : activeFill) : idleFill;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.closePath();
    ctx.fill();
  }

  // Diagonal zone dividers
  ctx.strokeStyle = 'rgba(232,211,106,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y + h);
  ctx.moveTo(x + w, y);
  ctx.lineTo(x, y + h);
  ctx.stroke();

  // Center circle ("Do nothing" neutral zone when closed; Fire glow when open)
  const inCircle = fh.detected && g.zone === 'circle';
  ctx.fillStyle = inCircle
    ? (g.fire ? 'rgba(255,106,58,0.52)' : 'rgba(100,150,255,0.42)')
    : 'rgba(60,100,180,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = inCircle && g.fire ? '#ff8a3a' : 'rgba(140,190,255,0.75)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Subtle zone direction glyphs
  ctx.font = fontSpec(game.lang, Math.round(clamp(h * 0.1, 9, 13)), 'mono');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('▲', cx, y + h * 0.16);
  ctx.fillText('▼', cx, y + h * 0.84);
  ctx.fillText('◀', x + w * 0.14, cy);
  ctx.fillText('▶', x + w * 0.86, cy);

  // Hand skeleton / bbox / tracked center dot
  if (fh.detected) {
    if (fh.landmarks) {
      ctx.strokeStyle = g.fire ? 'rgba(255,140,80,0.9)' : 'rgba(125,255,138,0.85)';
      ctx.lineWidth = 1.5;
      for (const [a, b] of MP_HAND_CONNECTIONS) {
        const la = fh.landmarks[a], lb = fh.landmarks[b];
        ctx.beginPath();
        ctx.moveTo(x + la.x * w, y + la.y * h);
        ctx.lineTo(x + lb.x * w, y + lb.y * h);
        ctx.stroke();
      }
    } else if (fh.bbox) {
      ctx.strokeStyle = g.fire ? '#ff8a3a' : '#7dff8a';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        x + fh.bbox.x0 * w,
        y + fh.bbox.y0 * h,
        (fh.bbox.x1 - fh.bbox.x0) * w,
        (fh.bbox.y1 - fh.bbox.y0) * h
      );
    }
    const hx = x + fh.handX * w;
    const hy = y + fh.handY * h;
    ctx.fillStyle = g.fire ? '#ff4a3a' : '#7dff8a';
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Top status pill inside frame
  const statusText = !fh.detected
    ? (fh.status === 'nocam' ? t.freeHandPadHint : fh.status === 'loading' ? t.freeHandLoading : t.freeHandShow)
    : g.fire
      ? t.freeHandFire
      : t.freeHandZones[g.zone] || t.freeHandIdle;
  ctx.fillStyle = g.fire ? 'rgba(190,45,20,0.86)' : 'rgba(10,14,12,0.72)';
  ctx.fillRect(x, y, w, 18);
  ctx.font = fontSpec(game.lang, 10, 'mono');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = g.fire ? '#fff4d0' : fh.detected ? '#7dff8a' : '#e8d36a';
  ctx.fillText(statusText, cx, y + 9);

  ctx.restore();

  // Outer panel border
  ctx.strokeStyle = g.fire ? '#ff7a3a' : 'rgba(232,211,106,0.55)';
  ctx.lineWidth = g.fire ? 2 : 1.5;
  ctx.strokeRect(x, y, w, h);

  // Footer mode switch bar (MOVE+AIM vs AIM ONLY, plus [OPEN] pad test button when no camera)
  const splitPad = fh.backend === 'pad';
  const modeW = splitPad ? w * 0.62 : w;
  ctx.fillStyle = 'rgba(18,24,18,0.94)';
  ctx.fillRect(x, y + h, modeW, footerH);
  ctx.strokeStyle = 'rgba(232,211,106,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y + h, modeW, footerH);
  ctx.font = fontSpec(game.lang, 9.5, 'mono');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8d36a';
  const modeTxt = fh.mode === 'smart' ? t.freeHandModeSmart : t.freeHandModeAim;
  ctx.fillText(modeTxt, x + modeW / 2, y + h + footerH / 2);

  if (splitPad) {
    const ox = x + modeW;
    const ow = w - modeW;
    ctx.fillStyle = fh.padOpen ? 'rgba(210,70,28,0.9)' : 'rgba(28,36,28,0.94)';
    ctx.fillRect(ox, y + h, ow, footerH);
    ctx.strokeStyle = fh.padOpen ? '#ffaa6a' : 'rgba(232,211,106,0.45)';
    ctx.strokeRect(ox, y + h, ow, footerH);
    ctx.fillStyle = fh.padOpen ? '#ffffff' : '#ffb347';
    ctx.fillText(t.freeHandTestOpen, ox + ow / 2, y + h + footerH / 2);
  }

  ctx.restore();
}
