/* ===========================================================================
   Kenya Pulse — service worker

   Three jobs:
     PRECACHE   the built app, so it opens offline
     FEED       network-first on data.json, with the last copy as the fallback
     PUSH       show the daily briefing, and open the app when it is tapped

   The push handlers are why this file is hand-written rather than generated.
   A notification that cannot be tapped open is a dead end, and a notification
   that only fires while the page is running is not a notification at all —
   both need code that lives here, outside the page.
=========================================================================== */
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/* The app updates itself on the next load rather than asking. */
self.skipWaiting();
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

/* The readings: always try the network first, fall back to the last good copy.
   Six seconds is long enough for a slow mobile connection and short enough
   that a dead network does not hold the screen empty. */
registerRoute(
  ({ url }) => url.hostname === "gachichio.org"
    && url.pathname.startsWith("/pulse/")
    && url.pathname.endsWith(".json"),
  new NetworkFirst({ cacheName: "pulse-data", networkTimeoutSeconds: 6 })
);

/* ---------------------------------------------------------------------------
   PUSH
   The server sends JSON. Anything unreadable still surfaces something, because
   a push that resolves to no notification costs the site its permission on
   some browsers — userVisibleOnly is a promise the browser holds us to.
--------------------------------------------------------------------------- */
const FALLBACK = { title: "Kenya Pulse", body: "Today's readings are ready.", url: "/#edge" };

function payloadOf(event) {
  try {
    const d = event.data && event.data.json();
    if (!d || typeof d !== "object") return FALLBACK;
    return {
      title: typeof d.title === "string" && d.title ? d.title : FALLBACK.title,
      body: typeof d.body === "string" && d.body ? d.body : FALLBACK.body,
      url: typeof d.url === "string" && d.url.startsWith("/") ? d.url : FALLBACK.url,
    };
  } catch { return FALLBACK; }
}

self.addEventListener("push", event => {
  const p = payloadOf(event);
  event.waitUntil(self.registration.showNotification(p.title, {
    body: p.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "kp-daily",           // one Kenya Pulse notification at a time
    renotify: true,
    data: { url: p.url },
  }));
});

/* ---------------------------------------------------------------------------
   TAP
   Focus a window that is already open on this app and take it to the right
   tab; otherwise open one. Without this listener the tap does nothing at all,
   which is what it did before.
--------------------------------------------------------------------------- */
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of open) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      /* navigate() is not implemented everywhere; focusing still counts as
         opening the app, so a failure here is not worth surfacing. */
      if (typeof client.navigate === "function") {
        try { await client.navigate(target); } catch { /* focused anyway */ }
      }
      return;
    }
    await self.clients.openWindow(target);
  })());
});

/* ---------------------------------------------------------------------------
   ROTATION
   Push services retire subscriptions on their own schedule. When that happens
   the browser tells us once, and it is the only chance to hand the server the
   new address before the old one starts failing.
--------------------------------------------------------------------------- */
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const old = event.oldSubscription || await self.registration.pushManager.getSubscription();
    const key = old && old.options && old.options.applicationServerKey;
    if (!key) return;
    try {
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: key,
      });
      await fetch("https://gachichio.org/pulse/push/refresh", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldEndpoint: old.endpoint, subscription: fresh.toJSON() }),
      });
    } catch { /* the next app open resubscribes */ }
  })());
});
