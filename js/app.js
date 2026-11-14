// =====================================================================
//  골든밴드 — 화면 흐름 컨트롤러
//  연습 모드: 홈 → 1.기기 연결 · 환자 촬영 → 2.실시간 연습 → 3.결과 리포트
//  실전 모드: 기기를 연결하면 바로 박자 안내 시작 (자세 교정 · 결과 리포트 생략)
// =====================================================================
import { CONFIG, FEEDBACK } from './config.js';
import { DeviceLink } from './device.js';
import { Session } from './session.js';
import { PoseTracker, drawRescuer, drawUpperBody } from './pose.js';
import { drawDepthChart, drawResidualChart } from './report.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const RING_C = 2 * Math.PI * 52;
const fmtKg = (v) => (v == null ? '—' : v.toFixed(1));

const device = new DeviceLink();
const pose = new PoseTracker();
const session = new Session();

const S = {
  screen: 'home',
  cdId: 0,
  pendingReal: false,     // 실전 모드 버튼을 눌렀는데 기기가 아직 연결 안 됨 → 연결되면 바로 시작
  lastPose: null,
  lastPoseAt: 0,
  liveDepth: 0,
  liveKg: null,
  liveTilt: null,
  forceHist: [],          // 최근 4초 손바닥 압력 [{t, kg}]
  real: { phase: 'idle', raf: 0, fb: null, swapN: 0 },
  practice: { phase: 'idle', raf: 0, fb: null, swapN: 0 },
  scan: { state: 'off', frames: 0, start: 0, sx: 0, sy: 0, n: 0, target: null },
  result: null,
};

// =====================================================================
//  라우터
// =====================================================================
const FLOW = ['connect', 'practice', 'report'];

function go(name) {
  if (name === S.screen) return;
  if (name !== 'real' && name !== 'connect') S.pendingReal = false;
  if (name === 'real' && !device.connected) {
    S.pendingReal = true;
    toast('기기를 연결하면 바로 박자 안내가 시작돼요', 'warn');
    name = 'connect';
  } else if (name === 'practice' && !device.connected) {
    toast('먼저 웨어러블을 연결하세요', 'warn');
    name = 'connect';
  }
  if (name === 'report' && !S.result) name = 'home';
  leave(S.screen);
  S.screen = name;
  document.body.dataset.screen = name;
  $$('.screen').forEach((el) => el.classList.toggle('active', el.dataset.screen === name));
  const idx = FLOW.indexOf(name);
  $$('#navSteps li').forEach((li, i) => {
    li.classList.toggle('now', i === idx);
    li.classList.toggle('done', idx > i);
  });
  window.scrollTo(0, 0);
  enter(name);
}

function enter(name) {
  if (name === 'connect') enterConnect();
  else if (name === 'practice') enterPractice();
  else if (name === 'report') renderReport();
  else if (name === 'real') enterReal();
}

function leave(name) {
  if (name === 'practice') leavePractice();
  if (name === 'real') leaveReal();
}

// =====================================================================
//  공통 UI
// =====================================================================
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3200);
}

function bump(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function setCount(v) {
  const el = $('#ovCount');
  el.textContent = v;
  bump(el, 'tick');
}

/** 3·2·1 카운트다운 오버레이. 화면을 벗어나면 false */
async function countdown({ title, sub, seconds = 3, go: goText = '' }) {
  const id = ++S.cdId;
  $('#overlay').hidden = false;
  $('#ovTitle').textContent = title;
  $('#ovSub').textContent = sub;
  for (let i = seconds; i > 0; i--) {
    if (id !== S.cdId) return false;
    setCount(String(i));
    await sleep(1000);
  }
  if (id !== S.cdId) return false;
  if (goText) {
    setCount(goText);
    await sleep(600);
  }
  if (id !== S.cdId) return false;
  $('#overlay').hidden = true;
  return true;
}

function cancelCountdown() {
  S.cdId++;
  $('#overlay').hidden = true;
}

function setRing(sel, score) {
  const el = $(sel);
  el.style.strokeDashoffset = String(RING_C * (1 - Math.max(0, Math.min(100, score)) / 100));
  el.style.stroke = score >= 75 ? 'var(--good)' : score >= 60 ? 'var(--warn)' : 'var(--accent)';
}

function toneOf(v) {
  if (v == null) return '';
  return v >= 80 ? 'good' : v >= 60 ? 'warn' : 'bad';
}

function friendlyError(e) {
  if (!e) return '알 수 없는 오류';
  if (e.name === 'NotAllowedError') return '권한이 거부됐어요. 주소창 왼쪽 자물쇠 아이콘에서 허용해 주세요.';
  if (e.name === 'NetworkError') return '기기와 통신하지 못했어요. 기기를 껐다 켠 뒤 다시 시도하세요.';
  if (e.name === 'SecurityError') return 'HTTPS(또는 localhost)에서만 사용할 수 있어요.';
  return e.message || String(e);
}

// =====================================================================
//  기기 연결 상태
// =====================================================================
function renderDevice(busy = false) {
  const on = device.connected;
  const dotCls = 'dot' + (busy ? ' busy' : on ? ' on' : '');
  const chip = $('#deviceChip');
  chip.querySelector('.dot').className = dotCls;
  chip.querySelector('span').textContent = on ? device.name : '미연결';

  $('#btOrb').className = 'bt-orb' + (busy ? ' busy' : on ? ' on' : '');
  const st = $('#connState');
  st.querySelector('.dot').className = dotCls;
  st.querySelector('span').textContent = busy ? '연결 중…' : on ? '연결됨' : '연결 안 됨';
  $('#connMeta').textContent = on ? `${device.name} · Bluetooth` : 'CPR-Band 전원을 켜고 연결을 눌러주세요';
  $('#btnBle').textContent = on ? '연결 해제' : '기기 연결';

  $('#btnReady').disabled = !on;
  $('#readyHint').textContent = !on
    ? (S.pendingReal ? '실전 모드: 기기를 연결하면 바로 박자 안내가 시작돼요' : '웨어러블을 먼저 연결하세요')
    : !pose.cameraOn ? '카메라를 켜서 누운 사람의 압박 위치를 확인하세요'
    : S.scan.state !== 'done' ? (pose.view === 'top'
      ? '휴대폰을 누운 사람 위에 들고 얼굴~가슴이 화면에 들어오게 비춰주세요 — 압박 위치를 자동으로 잡아요'
      : '카메라에 누운 사람(마네킹)이 윤곽선에 맞게 보이게 놓아주세요 — 압박 위치를 자동으로 잡아요')
    : '준비가 끝났어요! 시작을 누르면 3초 뒤 압박을 시작해요';
}

device.addEventListener('status', (e) => {
  renderDevice(!!e.detail.connecting);
  if (e.detail.lost) toast('기기 연결이 끊어졌어요. 다시 연결해 주세요', 'bad');
  // 실전 모드: 기기와 연결되면 바로 박자 안내 시작
  if (e.detail.connected && S.pendingReal) {
    S.pendingReal = false;
    go('real');
  }
});
device.addEventListener('depth', (e) => {
  const d = e.detail;
  S.liveDepth = d.cm;
  S.liveKg = d.kg;
  if (d.tilt != null) S.liveTilt = Math.abs(d.tilt);
  if (d.kg != null) {
    const now = performance.now();
    S.forceHist.push({ t: now, kg: d.kg });
    while (S.forceHist.length && now - S.forceHist[0].t > 4000) S.forceHist.shift();
  }
});
device.addEventListener('compression', (e) => {
  if (S.screen === 'real') onRealCompression(e.detail);
  else onCompression(e.detail);
});

// =====================================================================
//  1. 기기 연결 · 환자 촬영
// =====================================================================
function enterConnect() {
  renderDevice();
  if (pose.cameraOn) {
    pose.attach($('#setupVideo'));
    $('#setupEmpty').hidden = true;
    $('#setupBadge').hidden = false;
    $('#setupActions').hidden = false;
    if (S.scan.state === 'done' && S.scan.target) showScanDone(false);
    else startScan();
  }
  const sup = DeviceLink.support();
  const w = $('#supportWarn');
  if (!sup.secure) {
    w.textContent = '보안 연결(HTTPS 또는 localhost)이 아니라서 블루투스·카메라를 쓸 수 없어요.';
    w.hidden = false;
  } else if (!sup.ble) {
    w.textContent = '이 브라우저는 Web Bluetooth를 지원하지 않아요. PC·안드로이드의 Chrome/Edge를 사용하세요.';
    w.hidden = false;
  } else {
    w.hidden = true;
  }
}

async function connectBle() {
  renderDevice(true);
  try {
    await device.connectBLE();
    toast('웨어러블이 연결되었어요', 'good');
  } catch (e) {
    // 사용자가 선택 창을 닫은 경우(NotFoundError)는 조용히 무시
    if (e?.name !== 'NotFoundError') toast(friendlyError(e), 'bad');
  } finally {
    renderDevice();
  }
}

async function enableCamera(where) {
  const video = where === 'setup' ? $('#setupVideo') : $('#pracVideo');
  try {
    await pose.start(video);
  } catch (e) {
    toast(e?.name === 'NotFoundError' ? '카메라를 찾을 수 없어요' : friendlyError(e), 'bad');
    return false;
  }
  applyCamPrefs();
  if (where === 'setup') {
    $('#setupEmpty').hidden = true;
    const badge = $('#setupBadge');
    badge.hidden = false;
    badge.className = 'cam-badge';
    badge.textContent = 'AI 자세 모델 불러오는 중…';
    $('#setupActions').hidden = false;
    startScan();
  }
  renderDevice();
  pose.loadModel()
    .then(() => toast('자세 인식 준비 완료', 'good'))
    .catch((e) => toast(e.message, 'warn'));
  return true;
}

pose.onResult = (r, video) => {
  S.lastPose = r;
  S.lastPoseAt = performance.now();
  if (S.screen === 'connect') drawSetup(r, video);
  else if (S.screen === 'practice') onPracticePose(r);
};

function drawSetup(r, video) {
  scanStep(r, performance.now());
  const c = $('#setupCanvas');
  if (c.width !== video.videoWidth) { c.width = video.videoWidth; c.height = video.videoHeight; }
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (r.patient && S.scan.state !== 'done') drawUpperBody(ctx, r.patient.lm, W, H, '#3BE38A');   // 누운 사람 인식됨
  if (r.rescuer) drawRescuer(ctx, r.rescuer, W, H);   // 압박하는 사람 자세선 (팔이 곧으면 초록, 굽으면 빨강)
  if (S.scan.state === 'scanning' && r.patient) drawTarget(ctx, r.patient.target, W, H);
  if (S.scan.state === 'done' && S.scan.target) drawTarget(ctx, S.scan.target, W, H);
}

// =====================================================================
//  2. 실시간 연습
// =====================================================================
function buildGauge(sel, { min, max, okMin, okMax, ticks }) {
  const el = $(sel);
  const pct = (v) => ((v - min) / (max - min)) * 100;
  el.dataset.min = min;
  el.dataset.max = max;
  el.innerHTML = `
    <div class="g-title">${el.dataset.title}</div>
    <div class="g-body">
      <div class="g-rail">
        <div class="g-track">
          <div class="g-high" style="height:${100 - pct(okMax)}%"></div>
          <div class="g-zone" style="bottom:${pct(okMin)}%;height:${pct(okMax) - pct(okMin)}%"></div>
          <div class="g-fill"></div>
        </div>
        <div class="g-marker"></div>
      </div>
      <div class="g-ticks">${ticks.map((t) => `<span style="top:${100 - pct(t)}%">${t}</span>`).join('')}</div>
    </div>
    <div class="g-value"><b>—</b><small>${el.dataset.unit}</small></div>`;
}

function gaugePct(el, v) {
  const min = +el.dataset.min, max = +el.dataset.max;
  return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
}

function setGauge(sel, value, label, tone) {
  const el = $(sel);
  el.querySelector('.g-marker').style.top = `${100 - gaugePct(el, value)}%`;
  const v = el.querySelector('.g-value');
  v.querySelector('b').textContent = label;
  v.className = `g-value ${tone || ''}`;
}

function setGaugeFill(sel, value) {
  const el = $(sel);
  el.querySelector('.g-fill').style.height = `${gaugePct(el, value)}%`;
}

function resetHud() {
  $('#pTimer').textContent = '00:00';
  $('#pCount').textContent = '0';
  for (const sel of ['#rateGauge', '#depthGauge']) {
    const el = $(sel);
    el.querySelector('.g-marker').style.top = '100%';
    el.querySelector('.g-fill').style.height = '0%';
    el.querySelector('.g-value').className = 'g-value';
    el.querySelector('.g-value b').textContent = '—';
  }
  const fb = FEEDBACK.IDLE;
  $('#feedback').dataset.level = fb.level;
  $('#fbIcon').textContent = fb.icon;
  $('#fbText').textContent = fb.text;
  $('#swapBanner').hidden = true;
  $('#elbowTag').hidden = true;
  $('#forceNow').textContent = '—';
  $('#forcePeak').textContent = '—';
  $('#forceResid').textContent = '—';
  $('#forceResid').className = '';
  $('#tiltNow').textContent = '—';
}

async function enterPractice() {
  const P = S.practice;
  Object.assign(P, { phase: 'countdown', fb: null, swapN: 0 });
  S.result = null;
  S.liveDepth = 0;
  S.forceHist = [];
  session.reset();
  resetHud();
  renderDevice();
  setupPip();

  // '시작' → 3초 카운트다운 → 기기 작동 시작 (부저 110 BPM + 측정)
  const ok = await countdown({ title: '가슴 압박 시작', sub: '3초 뒤 부저 박자(분당 110회)에 맞춰 5~6cm 깊이로 누르세요', seconds: 3, go: '시작!' });
  if (!ok || S.screen !== 'practice') return;

  session.start();
  P.phase = 'running';
  device.send(`BPM,${CONFIG.cpr.bpm}`);
  device.send('START');
  P.raf = requestAnimationFrame(practiceTick);
}

function leavePractice() {
  cancelCountdown();
  const P = S.practice;
  cancelAnimationFrame(P.raf);
  if (P.phase === 'running') {
    session.stop();
    device.send('STOP');
  }
  P.phase = 'idle';
  if (S.scan.state !== 'done') S.scan.state = 'off';
  $('#pip').classList.remove('big');
}

function finishPractice() {
  const P = S.practice;
  if (P.phase !== 'running') {
    if (P.phase === 'countdown') go('connect');
    return;
  }
  P.phase = 'done';
  cancelAnimationFrame(P.raf);
  session.stop();
  device.send('STOP');
  S.result = session.summary();
  go('report');
}

function practiceTick() {
  const P = S.practice;
  if (P.phase !== 'running' || S.screen !== 'practice') return;
  P.raf = requestAnimationFrame(practiceTick);
  const now = performance.now();
  const el = session.elapsed(now);
  $('#pTimer').textContent = fmtTime(el);

  applyFeedback(session.feedback(now));

  const n = Math.floor(el / CONFIG.cpr.swapSec);
  if (n > P.swapN) { P.swapN = n; showSwap(); }

  setGaugeFill('#depthGauge', S.liveDepth);
  drawPip(now);
  drawDock(now);
}

// ------------------------------------------------------------ 손목 기기 센서 (압력 그래프 · 기울기)
function drawDock(now) {
  // 손바닥 압력 (FSR402)
  $('#forceNow').innerHTML = S.liveKg == null ? '—' : `${S.liveKg.toFixed(1)}<small>kg</small>`;
  drawSpark($('#forceSpark'), now);
  // 손목 기울기 (MPU6050)
  const t = S.liveTilt;
  const max = CONFIG.gauge.tiltMax;
  $('#tiltNeedle').style.transform = `rotate(${((Math.min(max, t ?? 0) / max) * 180 - 90).toFixed(1)}deg)`;
  const tn = $('#tiltNow');
  tn.textContent = t == null ? '—' : `${Math.round(t)}°`;
  tn.className = t == null ? '' : t > CONFIG.cpr.tiltMax ? 'warn' : 'good';
}

function drawSpark(c, now) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const max = CONFIG.gauge.forceMax;
  const Y = (kg) => h - 3 - Math.sqrt(Math.max(0, Math.min(max, kg)) / max) * (h - 6); // 작은 압력이 잘 보이게 √ 눈금
  const X = (t) => w - ((now - t) / 4000) * w;
  // 잔여 압력 기준선 2.5kg
  const ly = Y(CONFIG.cpr.residualMaxKg);
  ctx.strokeStyle = 'rgba(229,55,43,.55)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w, ly); ctx.stroke();
  ctx.setLineDash([]);
  const H = S.forceHist;
  if (H.length < 2) {
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.font = '600 11px Paperlogy, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(device.hasForce ? '압박을 기다리는 중' : '압력 센서 신호 없음', w / 2, h / 2 + 4);
    return;
  }
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(239,62,45,.28)');
  g.addColorStop(1, 'rgba(239,62,45,0)');
  ctx.beginPath();
  ctx.moveTo(X(H[0].t), h);
  for (const p of H) ctx.lineTo(X(p.t), Y(p.kg));
  ctx.lineTo(X(H[H.length - 1].t), h);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  H.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.kg)) : ctx.moveTo(X(p.t), Y(p.kg))));
  ctx.strokeStyle = '#EF3E2D';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function applyFeedback(code) {
  const P = S.practice;
  if (code === P.fb) return;
  P.fb = code;
  const fb = FEEDBACK[code];
  const el = $('#feedback');
  el.dataset.level = fb.level;
  $('#fbIcon').textContent = fb.icon;
  $('#fbText').textContent = fb.text;
  bump(el, 'pop');
}

function onCompression(d) {
  if (S.screen !== 'practice' || S.practice.phase !== 'running') return;
  const c = CONFIG.cpr;
  const comp = session.addCompression(d);
  $('#pCount').textContent = String(session.comps.length);
  // 속도/깊이가 기준을 벗어나면 게이지를 빨간색으로
  if (comp.rate != null) setGauge('#rateGauge', comp.rate, String(Math.round(comp.rate)), comp.rateOk ? 'good' : 'bad');
  setGauge('#depthGauge', comp.depth, comp.depth.toFixed(1), comp.depthOk ? 'good' : 'bad');
  if (comp.peakKg != null) $('#forcePeak').innerHTML = `${fmtKg(comp.peakKg)}<small>kg</small>`;
  if (comp.residualKg != null) {
    const r = $('#forceResid');
    r.innerHTML = `${fmtKg(comp.residualKg)}<small>kg</small>`;
    r.className = comp.recoilOk ? 'good' : 'warn';
  }
  if (comp.tilt != null && S.liveTilt == null) S.liveTilt = comp.tilt;
}

function showSwap(sel = '#swapBanner') {
  const b = $(sel);
  b.hidden = false;
  bump(b, 'pop');
  clearTimeout(S._swapT);
  S._swapT = setTimeout(() => { b.hidden = true; }, 4000);
}

// ------------------------------------------------------------ 카메라 + 압박 위치 스캔
function setPipStatus(text, cls = '') {
  const el = $('#pipStatus');
  el.textContent = text;
  el.className = `pip-status ${cls}`;
}

// 스캔 화면: 연결 화면 카메라(setup) / 연습 화면 작은 카메라(pip) — 같은 스캔 결과를 같이 씀
function scanView() {
  return S.screen === 'connect'
    ? { sil: $('#setupSil'), status: setSetupBadge }
    : { sil: $('#silhouette'), status: setPipStatus };
}

function setSetupBadge(text, cls = '') {
  const b = $('#setupBadge');
  b.hidden = false;
  b.textContent = text;
  b.className = `cam-badge ${cls}`;
  $('#setupFrame').classList.toggle('ok', cls === 'ok');
}

function showScanDone(announce) {
  const v = scanView();
  v.sil.hidden = true;
  v.status(S.screen === 'connect' ? '압박 위치 확인 완료 · 시작을 누르세요' : '압박 위치 확인됨', 'ok');
  if (announce) toast('스캔 완료. 압박 부위를 표시합니다.', 'good');
  renderDevice();
}

/** 누운 사람(마네킹) 압박점 스캔: 윤곽 맞춤 → 3초 스캔 → 빨간 원 고정 */
function scanStep(r, now) {
  const sc = S.scan;
  const v = scanView();
  if (sc.state === 'align') {
    sc.frames = r.patient ? sc.frames + 1 : Math.max(0, sc.frames - 1);
    v.status(r.patient ? '누운 사람 인식 중… 그대로 두세요' : alignMsg());
    if (sc.frames >= 12) {
      Object.assign(sc, { state: 'scanning', start: now, sx: 0, sy: 0, n: 0 });
      v.sil.classList.add('scanning');
    }
  }
  if (sc.state === 'scanning') {
    if (r.patient) { sc.sx += r.patient.target.x; sc.sy += r.patient.target.y; sc.n++; }
    const left = 3 - (now - sc.start) / 1000;
    v.status(`압박 위치 스캔 중… ${Math.max(0, Math.ceil(left))}`);
    if (left <= 0) {
      if (sc.n) {
        sc.target = { x: sc.sx / sc.n, y: sc.sy / sc.n };
        sc.state = 'done';
        showScanDone(true);
      } else {
        startScan();
      }
    }
  }
}

function setupPip() {
  const on = pose.cameraOn;
  $('#pipOff').hidden = on;
  $('#pipStatus').hidden = !on;
  $('#silhouette').hidden = !on;
  $('.pip-actions').hidden = !on;
  if (on) {
    pose.attach($('#pracVideo'));
    if (S.scan.state === 'done' && S.scan.target) showScanDone(false);   // 연결 화면에서 이미 잡은 위치 그대로
    else startScan();
  } else {
    S.scan.state = 'off';
    $('#pracCanvas').getContext('2d').clearRect(0, 0, 9999, 9999);
  }
}

// 카메라 보는 방향 (노트북·옆에서 / 핸드폰·위에서) + 전면·후면 카메라
function alignMsg() {
  return pose.view === 'top'
    ? '위에서 누운 사람의 얼굴~가슴을 비춰주세요'
    : '윤곽선에 맞춰 누운 사람(마네킹)을 비춰주세요';
}

function applyCamPrefs() {
  document.body.classList.toggle('cam-top', pose.view === 'top');
  document.body.classList.toggle('cam-nomirror', !pose.mirrored);
  $$('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === pose.view));
  $$('[data-facing]').forEach((b) => b.classList.toggle('on', b.dataset.facing === pose.facing));
  $('#btnPipView').textContent = pose.view === 'top' ? '📱 위에서' : '💻 옆에서';
  if (pose.view === 'top') $('#elbowTag').hidden = true;
}

async function setFacing(f, quiet = false) {
  if (pose.cameraOn && f !== pose.facing && (await PoseTracker.cameraCount()) < 2) {
    if (!quiet) toast('이 기기에는 카메라가 1개뿐이라 전환할 수 없어요', 'warn');
    applyCamPrefs();
    return;
  }
  try {
    await pose.setFacing(f);
  } catch (e) {
    toast(e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? '그 카메라를 찾을 수 없어요' : friendlyError(e), 'bad');
  }
  applyCamPrefs();
  if (pose.cameraOn) {
    startScan();
    if (!quiet) toast(pose.facing === 'environment' ? '후면 카메라로 바꿨어요' : '전면 카메라로 바꿨어요');
  }
}

async function setView(v) {
  if (pose.view === v) return;
  pose.setView(v);
  if (v === 'top' && pose.facing !== 'environment') await setFacing('environment', true);   // 위에서 비출 땐 보통 후면 카메라
  applyCamPrefs();
  if (pose.cameraOn) startScan();
  toast(v === 'top'
    ? '핸드폰 모드: 위에서 누운 사람을 찾아요 (팔꿈치 자세 판정은 꺼져요)'
    : '노트북 모드: 옆에서 누운 사람과 구조자 팔 자세를 함께 봐요', 'good');
}

function startScan() {
  Object.assign(S.scan, { state: 'align', frames: 0, start: 0, sx: 0, sy: 0, n: 0, target: null });
  const v = scanView();
  v.sil.hidden = false;
  v.sil.classList.remove('scanning');
  if (pose.modelState === 'error') v.status('자세 인식 모델을 불러오지 못했어요', 'bad');
  else v.status(alignMsg());
  renderDevice();
}

function onPracticePose(r) {
  // 구조자 팔 자세: 어깨-팔꿈치-손목 각도 160° 미만이면 팔이 굽은 것
  if (r.rescuer?.elbow != null) {
    session.setElbow(r.rescuer.elbow);
    const tag = $('#elbowTag');
    const ok = r.rescuer.elbow >= CONFIG.cpr.elbowMin;
    tag.hidden = false;
    tag.textContent = `팔꿈치 ${Math.round(r.rescuer.elbow)}°`;
    tag.className = `elbow-tag ${ok ? '' : 'bad'}`;
  }
  // 환자(마네킹) 압박점 — 연결 화면에서 이미 잡았으면 그대로 사용
  scanStep(r, performance.now());
}

/** 압박 위치 빨간 원 */
function drawTarget(ctx, t, W, H) {
  const x = t.x * W, y = t.y * H;
  const R = Math.max(14, W / 38);
  ctx.fillStyle = 'rgba(239,62,45,.25)';
  ctx.beginPath(); ctx.arc(x, y, R * 1.7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#EF3E2D';
  ctx.lineWidth = R * 0.26;
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#EF3E2D';
  ctx.beginPath(); ctx.arc(x, y, R * 0.32, 0, Math.PI * 2); ctx.fill();
}

function drawPip(now) {
  const v = $('#pracVideo'), c = $('#pracCanvas');
  if (!pose.cameraOn || !v.videoWidth) return;
  if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const r = now - S.lastPoseAt < 500 ? S.lastPose : null;
  if (r?.rescuer) drawRescuer(ctx, r.rescuer, W, H);
  if (S.scan.state === 'scanning' && r?.patient) drawTarget(ctx, r.patient.target, W, H);
  if (S.scan.state === 'done' && S.scan.target) drawTarget(ctx, S.scan.target, W, H);
}

// =====================================================================
//  실전 모드 — 기기 연결 즉시 박자 안내 (자세 교정 · 결과 리포트 생략)
// =====================================================================
function enterReal() {
  const R = S.real;
  Object.assign(R, { phase: 'running', fb: null, swapN: 0 });
  session.start();
  $('#realSwap').hidden = true;
  $('#realCount').textContent = '0';
  $('#realTime').textContent = '00:00';
  $$('.r-tile').forEach((t) => { t.className = 'r-tile'; t.querySelector('b').textContent = '—'; });
  setRealFb('IDLE');
  device.send(`BPM,${CONFIG.cpr.bpm}`);
  device.send('START');
  R.raf = requestAnimationFrame(realTick);
}

function leaveReal() {
  const R = S.real;
  cancelAnimationFrame(R.raf);
  if (R.phase === 'running') {
    session.stop();
    device.send('STOP');
  }
  R.phase = 'idle';
}

function finishReal() {
  const n = session.comps.length;
  go('home');
  toast(`실전 모드를 종료했어요 · 총 ${n}회 압박`, 'good');
}

function setRealFb(code) {
  const fb = FEEDBACK[code];
  const el = $('#realFb');
  el.dataset.level = fb.level;
  el.textContent = code === 'IDLE' ? '박자에 맞춰 가슴 중앙을 세게, 빠르게 누르세요' : fb.text;
}

function realTick() {
  const R = S.real;
  if (R.phase !== 'running' || S.screen !== 'real') return;
  R.raf = requestAnimationFrame(realTick);
  const now = performance.now();
  const el = session.elapsed(now);
  $('#realTime').textContent = fmtTime(el);
  const code = session.feedback(now);
  if (code !== R.fb) {
    R.fb = code;
    setRealFb(code);
    bump($('#realFb'), 'pop');
  }
  const n = Math.floor(el / CONFIG.cpr.swapSec);
  if (n > R.swapN) { R.swapN = n; showSwap('#realSwap'); }
}

function onRealCompression(d) {
  if (S.real.phase !== 'running') return;
  const comp = session.addCompression(d);
  $('#realCount').textContent = String(session.comps.length);
  const tile = (k, v, ok) => {
    const t = $(`.r-tile[data-k="${k}"]`);
    t.querySelector('b').textContent = v;
    t.className = `r-tile ${ok == null ? '' : ok ? 'good' : 'warn'}`;
  };
  if (comp.rate != null) tile('rate', String(Math.round(comp.rate)), comp.rateOk);
  tile('depth', comp.depth.toFixed(1), comp.depthOk);
  if (comp.residualKg != null) tile('resid', fmtKg(comp.residualKg), comp.recoilOk);
  else tile('resid', `${Math.round(comp.recoil)}%`, comp.recoilOk);
  if (comp.tilt != null) tile('tilt', String(Math.round(comp.tilt)), comp.tiltOk);
}

// =====================================================================
//  3. 결과 리포트 — 종합 점수 · 가장 많이 틀린 항목 · 그래프
// =====================================================================
function renderReport() {
  const r = S.result;
  if (!r) return;
  // 점수 카운트업
  const target = r.score;
  const num = $('#rScore');
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    num.textContent = String(Math.round(target * (1 - Math.pow(1 - k, 3))));
    if (k < 1 && S.screen === 'report') requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  setRing('#rRing', 0);
  requestAnimationFrame(() => requestAnimationFrame(() => setRing('#rRing', target)));

  $('#rGrade').textContent = r.count ? r.grade.label : '기록 없음';
  $('#rSummary').textContent = r.count
    ? `${fmtTime(r.duration)} 동안 ${r.count}회 압박 · 평균 ${r.avgRate ?? '—'}회/분 · 평균 ${r.avgDepth ?? '—'}cm${r.pauses ? ` · 중단 ${r.pauses}회` : ''}`
    : '압박이 감지되지 않았어요. 기기 착용과 연결을 확인해 주세요.';

  const w = r.worst;
  $('#rWorst').hidden = !w;
  if (w) {
    $('#rWorstLabel').textContent = `${w.label} · 적정 ${w.pct}%`;
    $('#rWorstText').textContent = w.text;
  }

  for (const k of ['depth', 'rate', 'recoil', 'tilt', 'posture']) {
    const v = r.metrics[k];
    const card = $(`.r-metrics [data-k="${k}"]`);
    card.className = `metric card ${toneOf(v)}${w && w.key === k ? ' worst' : ''}`;
    card.querySelector('b').innerHTML = v == null ? '—' : `${v}<small>%</small>`;
    card.querySelector('.bar > i').style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => (card.querySelector('.bar > i').style.width = `${v ?? 0}%`)));
    if (k === 'posture') card.querySelector('span').textContent = v == null ? '자세 (미측정)' : '자세 적정';
    if (k === 'tilt') card.querySelector('span').textContent = v == null ? '기울기 (미측정)' : '기울기 적정';
  }
  requestAnimationFrame(() => drawCharts(r));
}

function drawCharts(r) {
  drawDepthChart($('#rChart'), r.series);
  drawResidualChart($('#rChart2'), r.series);
}

// =====================================================================
//  이벤트 연결 & 시작
// =====================================================================
function bind() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) go(b.dataset.go);
  });

  // 연결 · 촬영
  $('#btnBle').addEventListener('click', () => {
    if (device.connected) { device.disconnect(); return; }
    connectBle();
  });
  $('#btnCam').addEventListener('click', () => enableCamera('setup'));
  $('#btnReady').addEventListener('click', () => go('practice'));
  $('#btnSetupRescan').addEventListener('click', startScan);
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('[data-facing]').forEach((b) => b.addEventListener('click', () => setFacing(b.dataset.facing)));

  // 연습
  $('#btnFinish').addEventListener('click', finishPractice);
  $('#btnCamPractice').addEventListener('click', async () => {
    if (await enableCamera('practice')) setupPip();
  });
  $('#btnRescan').addEventListener('click', startScan);
  $('#btnPipView').addEventListener('click', () => setView(pose.view === 'top' ? 'side' : 'top'));
  $('#btnPipFlip').addEventListener('click', () => setFacing(pose.facing === 'environment' ? 'user' : 'environment'));
  $('#btnPipSize').addEventListener('click', (e) => {
    const big = $('#pip').classList.toggle('big');
    e.currentTarget.textContent = big ? '작게' : '크게';
  });

  // 실전 모드
  $('#btnRealStop').addEventListener('click', finishReal);

  // 리포트
  $('#btnRetry').addEventListener('click', () => go(device.connected ? 'practice' : 'connect'));
  window.addEventListener('resize', () => {
    if (S.screen === 'report' && S.result) drawCharts(S.result);
  });
}

function init() {
  $('#footTeam').textContent = `${CONFIG.app.name} · ${CONFIG.app.tagline} — 팀 ${CONFIG.app.teamName} (${CONFIG.app.team})`;
  // 기울기 게이지의 적정 구간 (0 ~ tiltMax)
  {
    const k = CONFIG.cpr.tiltMax / CONFIG.gauge.tiltMax;
    const a = Math.PI * (1 - k);
    $('#tiltOk').setAttribute('d', `M10 60 A50 50 0 0 1 ${(60 + 50 * Math.cos(a)).toFixed(1)} ${(60 - 50 * Math.sin(a)).toFixed(1)}`);
  }
  const c = CONFIG.cpr;
  buildGauge('#rateGauge', { ...CONFIG.gauge.rate, okMin: c.rateMin, okMax: c.rateMax });
  buildGauge('#depthGauge', { ...CONFIG.gauge.depth, okMin: c.depthMin, okMax: c.depthMax });
  bind();
  applyCamPrefs();
  document.body.dataset.screen = 'home';
  renderDevice();
}

init();
