// サロンストック：電波がなくても開けるようにする仕組み（Service Worker）
// ・アプリの画面（HTMLなど）：まずネットから最新版を取り、だめなら保存しておいた版を使う
// ・読み取り用の部品（外部ライブラリ）：一度取ったら保存した物を使う
// ・楽天などの商品検索：保存しない（常にネットに問い合わせる）
const CACHE = 'salon-stock-v1';
const CORE = ['./', './index.html', './guide.html', './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png'];
const LIBS = ['https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'];
const LIB_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);
    await Promise.all(LIBS.map(u => fetch(u, { mode: 'no-cors' }).then(r => c.put(u, r)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // 最新版を優先（古い版が出る問題を防ぐ）。圏外なら保存版
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        return (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? c.match('./index.html') : Response.error());
      }
    })());
    return;
  }

  if (LIB_HOSTS.includes(url.hostname)) {
    // ライブラリは版が固定なので、保存した物を優先
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    })());
  }
  // それ以外（楽天・商品データベースなど）は何もしない＝通常どおりネットへ
});
