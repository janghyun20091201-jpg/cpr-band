// =====================================================================
//  Session — 연습 1회의 기록, 실시간 판정, 점수 계산
//  (보고서 주요 알고리즘: 깊이 5~6cm · 속도 100~120 · 잔여 압력 2.5kg 미만 · 기울기 · 팔 자세)
// =====================================================================
import { CONFIG } from './config.js';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const has = (v) => v != null && !Number.isNaN(v);

export class Session {
  constructor() {
    this.c = CONFIG.cpr;
    this.reset();
  }

  reset() {
    this.running = false;
    this.startAt = 0;
    this.endAt = 0;
    this.comps = [];
    this.lastCompAt = 0;
    this.elbow = null;
    this.elbowAt = 0;
    this.pauses = 0;
    this._inPause = false;
  }

  start(now = performance.now()) {
    this.reset();
    this.running = true;
    this.startAt = now;
    this.lastCompAt = now;
  }

  stop(now = performance.now()) {
    this.running = false;
    this.endAt = now;
  }

  elapsed(now = performance.now()) {
    return ((this.running ? now : this.endAt) - this.startAt) / 1000;
  }

  /** 카메라(MediaPipe)에서 계산한 팔꿈치 각도 */
  setElbow(angle, now = performance.now()) {
    this.elbow = angle;
    this.elbowAt = now;
  }

  postureBad(now = performance.now()) {
    return this.elbow != null && now - this.elbowAt < 1000 && this.elbow < this.c.elbowMin;
  }

  /** 기기에서 받은 압박 1회
   *  depth: cm, rate: 회/분, recoil: %, peakKg/residualKg: FSR402 압력(kg), tilt: 손목 기울기(도) */
  addCompression(e, now = performance.now()) {
    const c = this.c;
    const fresh = this.elbow != null && now - this.elbowAt < 1000;
    const comp = {
      t: (now - this.startAt) / 1000,
      depth: e.depth,
      rate: e.rate > 0 ? e.rate : null,
      recoil: e.recoil,
      peakKg: has(e.peakKg) ? e.peakKg : null,
      residualKg: has(e.residualKg) ? e.residualKg : null,
      tilt: has(e.tilt) ? Math.abs(e.tilt) : null,
      elbow: fresh ? this.elbow : null,
    };
    comp.depthOk = comp.depth >= c.depthMin && comp.depth <= c.depthMax;
    comp.rateOk = comp.rate == null ? null : comp.rate >= c.rateMin && comp.rate <= c.rateMax;
    // 압력 센서가 있으면 "잔여 압력 2.5kg 미만"으로, 없으면 가속도 이완율로 판정
    comp.recoilOk = comp.residualKg != null ? comp.residualKg < c.residualMaxKg : comp.recoil >= c.recoilMin;
    comp.tiltOk = comp.tilt == null ? null : comp.tilt <= c.tiltMax;
    comp.postureOk = comp.elbow == null ? null : comp.elbow >= c.elbowMin;
    this.comps.push(comp);
    this.lastCompAt = now;
    this._inPause = false;
    return comp;
  }

  get last() { return this.comps[this.comps.length - 1] || null; }

  /** 지금 보여줄 피드백 1개 — 우선순위: 중단 > 깊이 > 속도 > 이완 > 기울기 > 자세 */
  feedback(now = performance.now()) {
    const c = this.c;
    if (!this.running) return 'IDLE';
    const since = (now - this.lastCompAt) / 1000;
    if (since >= c.pauseSec) {
      if (!this._inPause) { this._inPause = true; this.pauses++; }
      return 'PAUSE';
    }
    if (!this.comps.length) return 'IDLE';

    const recent = this.comps.slice(-c.depthWindow);
    const d = mean(recent.map((x) => x.depth));
    if (d < c.depthMin) return 'SHALLOW';
    if (d > c.depthMax) return 'DEEP';

    const last = this.last;
    if (last.rate != null) {
      if (last.rate < c.rateMin) return 'SLOW';
      if (last.rate > c.rateMax) return 'FAST';
    }
    if (recent.filter((x) => !x.recoilOk).length >= 2) return 'RECOIL';
    const tilts = recent.filter((x) => x.tilt != null).map((x) => x.tilt);
    if (tilts.length && mean(tilts) > c.tiltMax) return 'TILT';
    if (this.postureBad(now)) return 'POSTURE';
    return 'OK';
  }

  /** 결과 리포트용 요약 */
  summary(now = performance.now()) {
    const c = this.c;
    const W = CONFIG.score;
    const comps = this.comps;
    const pct = (arr) => (arr.length ? Math.round((100 * arr.filter(Boolean).length) / arr.length) : null);

    const metrics = {
      depth: pct(comps.map((x) => x.depthOk)),
      rate: pct(comps.filter((x) => x.rateOk != null).map((x) => x.rateOk)),
      recoil: pct(comps.map((x) => x.recoilOk)),
      tilt: pct(comps.filter((x) => x.tiltOk != null).map((x) => x.tiltOk)),
      posture: pct(comps.filter((x) => x.postureOk != null).map((x) => x.postureOk)),
    };

    // 측정 안 된 항목(예: 카메라 미사용 → 자세)은 빼고 가중 평균
    let sum = 0, wsum = 0;
    for (const k of Object.keys(metrics)) {
      if (metrics[k] != null) { sum += metrics[k] * W[k]; wsum += W[k]; }
    }
    let score = wsum ? sum / wsum : 0;
    score = Math.max(0, Math.round(score - this.pauses * W.pausePenalty));

    const rates = comps.filter((x) => x.rate != null).map((x) => x.rate);
    const peaks = comps.filter((x) => x.peakKg != null).map((x) => x.peakKg);
    const resid = comps.filter((x) => x.residualKg != null).map((x) => x.residualKg);
    const tilts = comps.filter((x) => x.tilt != null).map((x) => x.tilt);

    const detail = {
      shallow: comps.filter((x) => x.depth < c.depthMin).length,
      deep: comps.filter((x) => x.depth > c.depthMax).length,
      slow: rates.filter((r) => r < c.rateMin).length,
      fast: rates.filter((r) => r > c.rateMax).length,
      incomplete: comps.filter((x) => !x.recoilOk).length,
      tilted: comps.filter((x) => x.tiltOk === false).length,
    };

    const summary = {
      date: new Date().toISOString(),
      duration: Math.round(this.elapsed(now)),
      count: comps.length,
      avgRate: rates.length ? Math.round(mean(rates)) : null,
      avgDepth: comps.length ? +mean(comps.map((x) => x.depth)).toFixed(1) : null,
      avgPeakKg: peaks.length ? +mean(peaks).toFixed(1) : null,
      avgResidualKg: resid.length ? +mean(resid).toFixed(1) : null,
      avgTilt: tilts.length ? Math.round(mean(tilts)) : null,
      pauses: this.pauses,
      metrics,
      score: comps.length ? score : 0,
      series: comps.map((x) => ({ t: +x.t.toFixed(2), d: x.depth, r: x.residualKg, p: x.peakKg, a: x.tilt })),
      detail,
    };
    summary.grade = gradeOf(summary.score);
    summary.worst = worstOf(summary);
    return summary;
  }
}

export function gradeOf(score) {
  if (score >= 90) return { label: '우수', tone: 'good' };
  if (score >= 75) return { label: '양호', tone: 'good' };
  if (score >= 60) return { label: '보통', tone: 'warn' };
  return { label: '연습 필요', tone: 'bad' };
}

/** 가장 많이 틀린 항목 (적정 비율이 가장 낮은 항목) */
function worstOf(s) {
  if (!s.count) return null;
  const m = s.metrics;
  const d = s.detail;
  const items = {
    depth: { label: '압박 깊이', text: d.shallow >= d.deep
      ? `5cm보다 얕은 압박이 ${d.shallow}회 있었어요 — 팔을 펴고 체중을 실어 5cm 이상 눌러주세요.`
      : `6cm를 넘긴 압박이 ${d.deep}회 있었어요 — 조금 약하게 눌러주세요.` },
    rate: { label: '압박 속도', text: d.slow >= d.fast
      ? '속도가 느려요 — 부저 박자(분당 110회)에 맞춰 일정하게 눌러주세요.'
      : '속도가 너무 빨라요 — 부저 박자에 맞춰 리듬을 유지하세요.' },
    recoil: { label: '이완', text: `이완 때 손바닥 압력이 2.5kg 이상 남은 압박이 ${d.incomplete}회 있었어요 — 누른 뒤 손의 힘을 완전히 빼세요.` },
    tilt: { label: '손목 기울기', text: `손목이 15° 넘게 기운 압박이 ${d.tilted}회 있었어요 — 팔을 가슴과 수직으로 세우세요.` },
    posture: { label: '팔 자세', text: '팔꿈치가 160° 미만으로 굽었어요 — 팔을 곧게 펴고 상체 체중으로 누르세요.' },
  };
  let worst = null;
  for (const k of Object.keys(items)) {
    if (m[k] == null) continue;
    if (!worst || m[k] < worst.pct) worst = { key: k, pct: m[k], ...items[k] };
  }
  return worst;
}
