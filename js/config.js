// =====================================================================
//  골든밴드 — 설정 파일
// =====================================================================

export const CONFIG = {
  app: {
    name: '골든밴드',
    tagline: 'CPR 웨어러블 트레이너',
    teamName: '심장폭격기',
    team: '문지민 · 김장현 · 문유찬 · 신유진',
  },

  // ---- 블루투스(BLE) : 펌웨어의 DEVICE_NAME / UUID 와 반드시 같아야 함 ----
  // Nordic UART Service(NUS) 규격 UUID — nRF Connect 같은 앱으로도 테스트 가능
  ble: {
    namePrefix: 'CPR-Band',
    service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // 웹 → ESP32 (write)
    tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // ESP32 → 웹 (notify)
  },

  // ---- CPR 판정 기준 (보고서 03. 주요 알고리즘) ----
  cpr: {
    rateMin: 100, rateMax: 120,   // 분당 압박 횟수
    depthMin: 5.0, depthMax: 6.0, // cm (MPU6050 가속도 이중 적분)
    recoilMin: 90,                // 이완율 % — 압력 센서가 없을 때만 사용 (올라온 거리 / 내려간 거리)
    residualMaxKg: 2.5,           // FSR402: 이완 시 잔여 압력이 이 값 이상이면 "이완 부족" (보고서 기준)
    tiltMax: 15,                  // MPU6050: 손목 기울기(도) — 초과하면 "팔을 수직으로"
    elbowMin: 160,                // 팔꿈치 각도(도) — 미만이면 "팔을 곧게"
    bpm: 110,                     // 메트로놈
    pauseSec: 10,                 // 이 시간 동안 압박 없으면 중단 경고
    swapSec: 120,                 // 2분마다 교대 알림
    depthWindow: 3,               // 깊이 판정 시 최근 N회 평균
  },

  // ---- 점수 가중치 (팀 기준) — 합이 100이 아니어도 자동 정규화 ----
  score: { depth: 30, rate: 25, recoil: 20, tilt: 10, posture: 15, pausePenalty: 5 },

  // ---- 게이지 표시 범위 ----
  gauge: {
    rate: { min: 70, max: 140, ticks: [140, 120, 100, 80] },
    depth: { min: 0, max: 8, ticks: [8, 6, 5, 3, 0] },
    forceMax: 50,                 // 압력 그래프 최대값 (kg)
    tiltMax: 30,                  // 기울기 게이지 최대값 (도)
  },

  // ---- 카메라 자세 인식 (Google MediaPipe Pose) — 인터넷 없이 쓰도록 vendor 폴더에 들어 있음 ----
  pose: {
    lib: new URL('vendor/mediapipe/vision_bundle.mjs', document.baseURI).href,
    wasm: new URL('vendor/mediapipe/wasm', document.baseURI).href,
    model: new URL('vendor/mediapipe/pose_landmarker_lite.task', document.baseURI).href,
    numPoses: 2,      // 구조자 + 환자(마네킹)
    minVis: 0.5,
  },
};

// ---- 실시간 피드백 문구 (우선순위: 중단 > 깊이 > 속도 > 이완 > 기울기 > 자세) ----
export const FEEDBACK = {
  IDLE:    { level: 'info', icon: '✋', text: '가슴 중앙에 두 손을 겹쳐 올리고 압박을 시작하세요' },
  PAUSE:   { level: 'bad',  icon: '⛔', text: '압박이 멈췄어요! 즉시 다시 누르세요' },
  SHALLOW: { level: 'warn', icon: '⬇', text: '더 세게! 5cm 이상 눌러주세요' },
  DEEP:    { level: 'bad',  icon: '⬆', text: '너무 깊어요! 조금 약하게 (6cm 이하)' },
  SLOW:    { level: 'warn', icon: '⏩', text: '더 빠르게! 박자에 맞춰주세요' },
  FAST:    { level: 'warn', icon: '⏪', text: '조금 천천히! 박자에 맞춰주세요' },
  RECOIL:  { level: 'warn', icon: '↥', text: '손에 힘을 완전히 빼세요! 가슴이 끝까지 올라와야 해요' },
  TILT:    { level: 'warn', icon: '⟂', text: '손목이 기울었어요! 팔을 가슴과 수직으로 세우세요' },
  POSTURE: { level: 'warn', icon: '💪', text: '팔을 곧게 펴세요' },
  OK:      { level: 'good', icon: '✓', text: '좋아요! 이대로 유지하세요' },
};
