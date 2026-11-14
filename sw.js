// =====================================================================
//  오프라인 캐시 (서비스 워커) — 한 번 인터넷으로 열면 그다음부터는 인터넷 없이도 동작
//  ★ 사이트 파일을 고친 뒤 다시 배포할 때는 VERSION 숫자를 올려야 휴대폰에도 새 버전이 받아져요
// =====================================================================
const VERSION = 'goldenband-v5';
const FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/apple-touch-icon.png",
  "assets/favicon.svg",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "css/style.css",
  "js/app.js",
  "js/config.js",
  "js/device.js",
  "js/pose.js",
  "js/report.js",
  "js/session.js",
  "vendor/fonts/Paperlogy-4Regular.woff2",
  "vendor/fonts/Paperlogy-5Medium.woff2",
  "vendor/fonts/Paperlogy-6SemiBold.woff2",
  "vendor/fonts/Paperlogy-7Bold.woff2",
  "vendor/fonts/Paperlogy-8ExtraBold.woff2",
  "vendor/fonts/SeoulAlrimTTF-ExtraBold.woff2",
  "vendor/fonts/SeoulAlrimTTF-Heavy.woff2",
  "vendor/mediapipe/pose_landmarker_lite.task",
  "vendor/mediapipe/vision_bundle.mjs",
  "vendor/mediapipe/wasm/vision_wasm_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_internal.wasm",
  "vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 인터넷(서버)이 되면 최신 파일 → 저장해 두고, 안 되면 저장해 둔 파일로
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
