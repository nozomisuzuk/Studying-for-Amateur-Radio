// Service Worker: アプリ本体は「ネット優先・失敗したら保存分」、問題画像は「保存分優先・裏で更新」

const VERSION = '2026-11-06.4';
const SHELL_CACHE = `ama1-shell-${VERSION}`;
const IMG_CACHE = 'ama1-img-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/components.js',
  'js/data.js',
  'js/engine.js',
  'js/explain.js',
  'js/store.js',
  'js/textview.js',
  'js/ui.js',
  'js/views/custom.js',
  'js/views/drill.js',
  'js/views/exam.js',
  'js/views/home.js',
  'js/views/list.js',
  'js/views/settings.js',
  'js/views/stats.js',
  'data/questions.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ama1-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([fetch(request), timeout(4000)]);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const index = await cache.match('index.html');
      if (index) return index;
    }
    throw e;
  }
}

async function cacheFirst(request, event) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/img/')) {
    event.respondWith(cacheFirst(request, event));
  } else {
    event.respondWith(networkFirst(request));
  }
});
