// The kill switch.
//
// The full app is a PWA: it registers a service worker that serves its own cached shell first, so
// it opens offline. That is exactly what it should do -- and exactly what it must NOT do here, where
// the server has been switched to the reader app. The installed worker keeps answering navigations
// with the old app's shell, so the reader app never reaches the screen and the reader is left
// looking at a tab called "Offline" that is not the offline tab.
//
// This file is served as /sw.js when the reader app is the front end, so the browser's ordinary
// service-worker update check replaces the old worker with this one. This one:
//
//   1. skips the waiting phase, so it takes over at once;
//   2. deletes every cache the old app left behind -- the precached shell, the static assets, the
//      capped API responses;
//   3. claims the pages that are already open, so they stop being controlled by the old worker;
//   4. reloads them, so the reader app is on the screen without the reader having to know any of
//      this happened;
//   5. and then does nothing at all: no fetch handler, so every request goes to the network.
//
// If the reader app is ever switched back to the full app, that app registers its own worker again
// and takes the scope back. Nothing here is permanent.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Every cache, whatever it is called: the old app's, and anything else on this origin.
    if (self.caches) {
      const names = await self.caches.keys();
      await Promise.all(names.map((name) => self.caches.delete(name)));
    }
    await self.clients.claim();
    // The pages that are open were served by the old worker. Reload them, so they are fetched from
    // the network -- which is the reader app now.
    const open = await self.clients.matchAll({ type: 'window' });
    for (const client of open) {
      try { await client.navigate(client.url); } catch { /* the page went away on its own */ }
    }
  })());
});

// No fetch handler on purpose. Every request goes to the network, and the reader app is three files
// that the browser is happy to re-fetch.
