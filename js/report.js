// =====================================================================
//  결과 리포트 — 깊이 · 이완 잔여 압력 그래프
// =====================================================================
import { CONFIG } from './config.js';


/** 압박 깊이 그래프 (초록 띠 = 5~6cm 적정 구간) */
export function drawDepthChart(canvas, series) {
  const { depthMin, depthMax } = CONFIG.cpr;
  drawChart(canvas, series.map((p) => ({ t: p.t, v: p.d })), {
    yMax: 8, ticks: [0, 2, 4, 6, 8], label: '깊이(cm)', band: [depthMin, depthMax], mode: 'line',
    tone: (v) => (v > depthMax ? '#E5372B' : v < depthMin ? '#F2A20C' : null),
  });
}

/** 이완 잔여 압력 그래프 (FSR402) — 점선 = 2.5kg 기준, 넘으면 노란 막대 */
export function drawResidualChart(canvas, series) {
  const lim = CONFIG.cpr.residualMaxKg;
  const pts = series.filter((p) => p.r != null).map((p) => ({ t: p.t, v: p.r }));
  drawChart(canvas, pts, {
    yMax: 5, ticks: [0, 1, 2, 3, 4, 5], label: '이완 잔여 압력(kg)', limit: lim, mode: 'bars',
    tone: (v) => (v >= lim ? '#F2A20C' : '#1DA866'), empty: '압력 센서 기록이 없어요',
  });
}

function drawChart(canvas, pts, o) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(10, rect.width), H = Math.max(10, rect.height);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const css = getComputedStyle(document.documentElement);
  const col = (n, f) => css.getPropertyValue(n).trim() || f;
  const font = col('--font', 'sans-serif');
  const pad = { l: 34, r: 12, t: 22, b: 26 };
  const yMax = o.yMax;
  const tMax = Math.max(10, pts.length ? pts[pts.length - 1].t : 10);
  const X = (t) => pad.l + (t / tMax) * (W - pad.l - pad.r);
  const Y = (d) => pad.t + (1 - Math.min(yMax, Math.max(0, d)) / yMax) * (H - pad.t - pad.b);

  // 적정 구간 띠
  if (o.band) {
    const [a, b] = o.band;
    ctx.fillStyle = 'rgba(29,168,102,.14)';
    ctx.fillRect(pad.l, Y(b), W - pad.l - pad.r, Y(a) - Y(b));
    ctx.strokeStyle = 'rgba(29,168,102,.55)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (const v of [a, b]) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 격자 & 축
  ctx.font = `600 11px ${font}`;
  ctx.fillStyle = col('--muted', '#888');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of o.ticks) {
    ctx.strokeStyle = 'rgba(0,0,0,.06)';
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke();
    ctx.fillText(String(v), pad.l - 8, Y(v));
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(o.label, 4, 12);
  ctx.textAlign = 'right';
  ctx.fillText(`시간(초) · 총 ${Math.round(tMax)}초`, W - pad.r, H - 6);

  if (pts.length < 2) {
    ctx.textAlign = 'center';
    ctx.fillText(o.empty || '압박 기록이 없어요', W / 2, H / 2);
    return;
  }

  if (o.mode === 'bars') {
    const bw = Math.max(1.4, Math.min(6, ((W - pad.l - pad.r) / pts.length) * 0.62));
    for (const p of pts) {
      ctx.fillStyle = o.tone(p.v);
      const x = X(p.t), y = Y(p.v);
      ctx.fillRect(x - bw / 2, y, bw, Y(0) - y);
    }
  } else {
    // 부드러운 곡선 (Catmull-Rom → Bezier)
    const xy = pts.map((p) => [X(p.t), Y(p.v)]);
    const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
    grad.addColorStop(0, col('--accent', '#EF3E2D'));
    grad.addColorStop(1, '#F7896F');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(xy[0][0], xy[0][1]);
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i - 1] || xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
    }
    ctx.stroke();
    // 범위 밖 값은 점으로 강조
    for (let i = 0; i < pts.length; i++) {
      const c = o.tone(pts[i].v);
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(xy[i][0], xy[i][1], 2.6, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 기준선
  if (o.limit != null) {
    ctx.strokeStyle = 'rgba(229,55,43,.8)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(o.limit)); ctx.lineTo(W - pad.r, Y(o.limit)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(229,55,43,.9)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`기준 ${o.limit}kg`, W - pad.r, Y(o.limit) - 3);
  }
}
