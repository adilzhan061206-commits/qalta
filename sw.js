// Қалта service worker: қосымшаны интернетсіз ашу үшін файлдарды кэштейді.
// Жаңа нұсқа шығарғанда VERSION-ды өзгертіңіз.
const VERSION = "qalta-v24";
const CORE = [
  "./",
  "./index.html",
  "./config.js",
  "./vendor/supabase.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon.svg"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Supabase API сұраулары әрқашан желіден өтеді
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("supabase.in")) return;
  // Валюта бағамы әрқашан жаңа болсын (офлайнда қосымша соңғы сақталған бағамды қолданады)
  if (url.hostname === "open.er-api.com" || url.pathname.includes("currency-api")) return;

  // Беттің өзі: алдымен желі (жаңа нұсқа үшін), болмаса кэш
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; })
        .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  // Қалғаны (шрифттер, белгішелер, скрипттер): кэш, фонда жаңарту
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// Daily reminder from the server (see supabase function qalta-remind)
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(d.title || "Қалта", {
    body: d.body || "", tag: d.tag || "qalta", icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: {url: d.url || "./"}
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && "focus" in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
