// =====================================================================
//  PoseTracker — 웹캠 + Google MediaPipe Pose (33개 랜드마크)
//   · 구조자 팔꿈치 각도: 어깨(11,12)–팔꿈치(13,14)–손목(15,16)
//   · 환자(마네킹) 압박점: 양 어깨(11,12)와 골반 중점(23,24)을 잇는 삼각형의 무게중심
// =====================================================================
import { CONFIG } from './config.js';

export const L = {
  NOSE: 0, L_EYE: 2, R_EYE: 5,
  L_SH: 11, R_SH: 12, L_EL: 13, R_EL: 14, L_WR: 15, R_WR: 16, L_HIP: 23, R_HIP: 24,
};

// 카메라 설정 기억 (브라우저마다 따로 저장)
const loadPref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } };

export class PoseTracker {
  constructor() {
    this.stream = null;
    this.video = null;
    this.landmarker = null;
    this.modelState = 'idle'; // idle | loading | ready | error
    this.onResult = null;
    this._raf = 0;
    this._lastVideoTime = -1;
    this.facing = loadPref('cpr.facing', 'user');   // 'user'(전면) | 'environment'(후면)
    this.actualFacing = null;                        // 실제로 켜진 카메라 방향 (기기가 알려줄 때)
    this.view = loadPref('cpr.view', 'side');        // 'side'(옆에서 · 노트북) | 'top'(위에서 · 핸드폰)
  }

  get cameraOn() { return !!this.stream; }

  /** 전면 카메라면 거울처럼 좌우 반전해서 보여줌 */
  get mirrored() { return (this.actualFacing || this.facing) !== 'environment'; }

  setView(v) {
    this.view = v === 'top' ? 'top' : 'side';
    savePref('cpr.view', this.view);
  }

  /** 기기에 달린 카메라 개수 (전면/후면 전환 가능 여부 확인용) */
  static async cameraCount() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return list.filter((d) => d.kind === 'videoinput').length;
    } catch { return 1; }
  }

  /** 전면 ↔ 후면 카메라 바꾸기 (카메라가 켜져 있으면 바로 다시 켬) */
  async setFacing(f) {
    const prev = this.facing;
    this.facing = f === 'environment' ? 'environment' : 'user';
    savePref('cpr.facing', this.facing);
    if (!this.stream) return;
    const video = this.video;
    this.stop();
    try {
      await this.start(video);
    } catch (e) {
      this.facing = prev;
      savePref('cpr.facing', prev);
      await this.start(video).catch(() => {});
      throw e;
    }
  }

  /** 카메라 켜기 (모델은 loadModel()로 따로 — 모델 실패해도 카메라는 유지) */
  async start(videoEl) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저에서는 카메라를 사용할 수 없어요. (HTTPS 또는 localhost 필요)');
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: this.facing } },
        audio: false,
      });
      const set = this.stream.getVideoTracks()[0]?.getSettings?.() || {};
      this.actualFacing = set.facingMode || null;
      // 노트북 웹캠처럼 방향 정보가 없고 카메라가 1개뿐이면 전면으로 봄 (좌우 반전 유지)
      if (!this.actualFacing && (await PoseTracker.cameraCount()) < 2) this.actualFacing = 'user';
    }
    await this.attach(videoEl);
    this._loop();
  }

  async attach(videoEl) {
    if (!this.stream || !videoEl) return;
    this.video = videoEl;
    if (videoEl.srcObject !== this.stream) videoEl.srcObject = this.stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    try { await videoEl.play(); } catch { /* 자동재생 정책 — 사용자 클릭 후 재시도됨 */ }
    this._lastVideoTime = -1;
  }

  async loadModel() {
    if (this.landmarker || this.modelState === 'loading') return;
    this.modelState = 'loading';
    try {
      const { FilesetResolver, PoseLandmarker } = await import(CONFIG.pose.lib);
      const files = await FilesetResolver.forVisionTasks(CONFIG.pose.wasm);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: CONFIG.pose.model, delegate },
        runningMode: 'VIDEO',
        numPoses: CONFIG.pose.numPoses,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(files, opts('GPU'));
      } catch {
        this.landmarker = await PoseLandmarker.createFromOptions(files, opts('CPU'));
      }
      this.modelState = 'ready';
    } catch (e) {
      console.warn('[pose] model load failed', e);
      this.modelState = 'error';
      throw new Error('자세 인식 모델을 불러오지 못했어요. 인터넷 연결을 확인하세요.');
    }
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  _loop() {
    cancelAnimationFrame(this._raf);
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      const v = this.video;
      if (!v || !this.landmarker || v.readyState < 2 || !v.videoWidth) return;
      if (v.currentTime === this._lastVideoTime) return;
      this._lastVideoTime = v.currentTime;
      let res;
      try { res = this.landmarker.detectForVideo(v, performance.now()); } catch (e) { return; }
      this.onResult?.(analyze(res, v.videoWidth, v.videoHeight, this.view), v);
    };
    tick();
  }
}

// ------------------------------------------------------------ 계산
const vis = (p) => (p?.visibility ?? 1) >= CONFIG.pose.minVis;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** 압박 위치 = 양 어깨와 골반 중점을 잇는 삼각형의 무게중심 (가슴뼈 아래쪽 절반) */
function chestTarget(lm) {
  const hp = mid(lm[L.L_HIP], lm[L.R_HIP]);
  return {
    x: (lm[L.L_SH].x + lm[L.R_SH].x + hp.x) / 3,
    y: (lm[L.L_SH].y + lm[L.R_SH].y + hp.y) / 3,
  };
}

/** b에서의 각도(도) — 화면 비율을 반영해 픽셀 좌표로 계산 */
export function jointAngle(a, b, c, W = 1, H = 1) {
  const v1x = (a.x - b.x) * W, v1y = (a.y - b.y) * H;
  const v2x = (c.x - b.x) * W, v2y = (c.y - b.y) * H;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!m) return null;
  return (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / m))) * 180) / Math.PI;
}

export function analyze(res, W, H, view = 'side') {
  const poses = res?.landmarks || [];
  const out = { poses, rescuer: null, patient: null, upperBody: false, W, H, view };
  if (view === 'top') return analyzeTop(poses, out, W, H);
  const info = poses.map((lm) => {
    const sh = mid(lm[L.L_SH], lm[L.R_SH]);
    const hp = mid(lm[L.L_HIP], lm[L.R_HIP]);
    const dx = (hp.x - sh.x) * W, dy = (hp.y - sh.y) * H;
    const hipsVisible = vis(lm[L.L_HIP]) && vis(lm[L.R_HIP]);
    const flat = hipsVisible ? Math.abs(dx) / Math.max(1, Math.abs(dy)) : 0;   // 클수록 몸통이 가로로 누움
    // 팔이 아래로 뻗어 있음(손목이 어깨보다 한참 아래) = 가슴을 누르는 구조자 자세
    const torso = Math.max(Math.hypot(dx, dy), 1);
    const drops = [[L.L_SH, L.L_WR], [L.R_SH, L.R_WR]]
      .filter(([a, b]) => vis(lm[a]) && vis(lm[b]))
      .map(([a, b]) => (lm[b].y - lm[a].y) * H);
    const armsDown = drops.length > 0 && Math.max(...drops) > torso * 0.5;
    const lying = flat > 1.2 && !armsDown;   // 몸통이 가로 + 팔을 아래로 뻗지 않음 → 환자
    const armsVis = [L.L_SH, L.R_SH, L.L_EL, L.R_EL, L.L_WR, L.R_WR].filter((i) => vis(lm[i])).length;
    return { lm, sh, hp, flat, lying, armsVis };
  });

  // 환자: 누운 사람 중 몸통이 가장 가로인 사람 / 구조자: 나머지 중 팔이 가장 잘 보이는 사람
  const patient = info.filter((p) => p.lying).sort((a, b) => b.flat - a.flat)[0];
  const rescuer = info.filter((p) => p !== patient && p.armsVis >= 3).sort((a, b) => b.armsVis - a.armsVis)[0];

  if (rescuer) {
    const lm = rescuer.lm;
    const left = vis(lm[L.L_SH]) && vis(lm[L.L_EL]) && vis(lm[L.L_WR]) ? jointAngle(lm[L.L_SH], lm[L.L_EL], lm[L.L_WR], W, H) : null;
    const right = vis(lm[L.R_SH]) && vis(lm[L.R_EL]) && vis(lm[L.R_WR]) ? jointAngle(lm[L.R_SH], lm[L.R_EL], lm[L.R_WR], W, H) : null;
    const angles = [left, right].filter((a) => a != null);
    out.rescuer = {
      lm,
      left, right,
      elbow: angles.length ? Math.min(...angles) : null, // 더 굽은 팔 기준
    };
    out.upperBody = [L.L_SH, L.R_SH, L.L_EL, L.R_EL].every((i) => vis(lm[i]));
  }
  if (patient) out.patient = { lm: patient.lm, target: chestTarget(patient.lm) };
  return out;
}

/**
 * 핸드폰 모드 — 휴대폰을 위에 들고 누운 사람을 내려다봄
 *  · 위에서 보면 누운 사람은 화면에 '정면 모습'으로 보이고, 방향(가로/세로)은 휴대폰을 든 방향에 따라 달라짐
 *    → '몸통이 가로로 누움' 조건 대신, 얼굴이 보이고(하늘을 보고 누움) 몸통이 가장 크게 보이는 사람을 환자로 선택
 *  · 골반이 안 보이는 상반신 마네킹도 코 → 어깨 방향으로 가슴 위치를 추정
 *  · 위에서는 팔꿈치 각도를 정확히 잴 수 없어서 구조자 자세 판정은 하지 않음
 */
function analyzeTop(poses, out, W, H) {
  let best = null;
  for (const lm of poses) {
    if (!vis(lm[L.L_SH]) || !vis(lm[L.R_SH])) continue;
    const sh = mid(lm[L.L_SH], lm[L.R_SH]);
    const shW = Math.hypot((lm[L.L_SH].x - lm[L.R_SH].x) * W, (lm[L.L_SH].y - lm[L.R_SH].y) * H);
    if (shW < 8) continue;
    const hipsVisible = vis(lm[L.L_HIP]) && vis(lm[L.R_HIP]);
    const faceUp = vis(lm[L.NOSE]) && vis(lm[L.L_EYE]) && vis(lm[L.R_EYE]);
    let target = null;
    if (hipsVisible) {
      target = chestTarget(lm);
    } else if (vis(lm[L.NOSE])) {
      // 코 → 어깨 중점 방향으로 어깨너비의 0.6배만큼 내려간 곳 ≈ 가슴뼈 아래쪽 절반
      const dx = (sh.x - lm[L.NOSE].x) * W, dy = (sh.y - lm[L.NOSE].y) * H;
      const n = Math.hypot(dx, dy);
      if (n > 1) target = { x: sh.x + ((dx / n) * shW * 0.6) / W, y: sh.y + ((dy / n) * shW * 0.6) / H };
    }
    if (!target) continue;
    const score = shW * (hipsVisible ? 1.5 : 1) * (faceUp ? 1.5 : 1);
    if (!best || score > best.score) best = { lm, target, score };
  }
  if (best) out.patient = { lm: best.lm, target: best.target };
  return out;
}

// ------------------------------------------------------------ 그리기
const ARM_L = [[L.L_SH, L.L_EL], [L.L_EL, L.L_WR]];
const ARM_R = [[L.R_SH, L.R_EL], [L.R_EL, L.R_WR]];
const TORSO = [[L.L_SH, L.R_SH], [L.L_SH, L.L_HIP], [L.R_SH, L.R_HIP], [L.L_HIP, L.R_HIP]];

/** 구조자 골격 그리기 (팔이 굽으면 빨간색) */
export function drawRescuer(ctx, r, W, H, elbowMin = CONFIG.cpr.elbowMin) {
  if (!r) return;
  const lm = r.lm;
  const lw = Math.max(3, W / 220);
  const seg = (pairs, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    for (const [a, b] of pairs) {
      if (!vis(lm[a]) || !vis(lm[b])) continue;
      ctx.beginPath();
      ctx.moveTo(lm[a].x * W, lm[a].y * H);
      ctx.lineTo(lm[b].x * W, lm[b].y * H);
      ctx.stroke();
    }
  };
  const GOOD = '#3BE38A', BAD = '#FF4D3D', NEUTRAL = 'rgba(255,255,255,.75)';
  // 몸통도 팔 상태에 맞춰 색칠: 팔이 곧으면 초록, 굽으면 빨강, 아직 각도를 못 재면 흰색
  seg(TORSO, r.elbow == null ? NEUTRAL : r.elbow >= elbowMin ? GOOD : BAD);
  seg(ARM_L, r.left == null ? NEUTRAL : r.left >= elbowMin ? GOOD : BAD);
  seg(ARM_R, r.right == null ? NEUTRAL : r.right >= elbowMin ? GOOD : BAD);
  for (const i of [L.L_SH, L.R_SH, L.L_EL, L.R_EL, L.L_WR, L.R_WR]) {
    if (!vis(lm[i])) continue;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(lm[i].x * W, lm[i].y * H, lw * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 상체 전체 골격 (연결 화면) */
export function drawUpperBody(ctx, lm, W, H, color = '#3BE38A') {
  const pairs = [...TORSO, ...ARM_L, ...ARM_R];
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, W / 240);
  ctx.lineCap = 'round';
  for (const [a, b] of pairs) {
    if (!vis(lm[a]) || !vis(lm[b])) continue;
    ctx.beginPath();
    ctx.moveTo(lm[a].x * W, lm[a].y * H);
    ctx.lineTo(lm[b].x * W, lm[b].y * H);
    ctx.stroke();
  }
}
