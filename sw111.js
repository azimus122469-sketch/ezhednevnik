/* Ежедневник — офлайн-оболочка */
const CACHE = "ezh-shell-v3";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", ev => {
  ev.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", ev => {
  const url = new URL(ev.request.url);

  // запросы к базе никогда не кэшируем — только живая сеть
  if (url.origin !== self.location.origin) return;
  if (ev.request.method !== "GET") return;

  // оболочка: сначала сеть, при её отсутствии — кэш
  ev.respondWith(
    fetch(ev.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(ev.request, copy));
        return res;
      })
      .catch(() => caches.match(ev.request).then(r => r || caches.match("./index.html")))
  );
});
