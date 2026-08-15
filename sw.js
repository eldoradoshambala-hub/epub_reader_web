/* Offline support for the application itself -- and only for that.
 *
 * The books are not here: they live in IndexedDB and are handed to the iframe
 * as blob URLs, which never reach a worker. That is deliberate. iOS stops the
 * service worker of a standalone web app whenever it feels like it, and a
 * reader that loses the ability to fetch its own pictures halfway through a
 * chapter is worse than one that has no worker at all. So this caches the
 * shell, and nothing it does can break a page that is already open.
 */

'use strict';

// Bumped on every release. The name is what forces the update: a shell cached
// under the old name is dropped wholesale when this worker activates, so the
// next launch gets the new files rather than the ones already on the phone.
const CACHE = 'reader-shell-v2';

const SHELL = [
  './',
  'index.html',
  'app.css',
  'reader.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/book.js',
  'js/epub.js',
  'js/library.js',
  'js/reader.js',
  'js/resources.js',
  'js/zip.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file must not fail the whole install.
    await Promise.all(SHELL.map((path) => cache.add(path).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

const SHELL_PATHS = new Set(SHELL.map((path) => new URL(path, self.location).pathname));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Anything that is not part of the application is none of this worker's
  // business -- books above all. Passing them through a cache would store a
  // second copy of every megabyte, and standing between the page and a large
  // response is a good way to break it in ways that are hard to see.
  if (request.mode !== 'navigate' && !SHELL_PATHS.has(url.pathname)) return;

  // The page itself comes from the network when there is one, so a new
  // version is picked up on the next launch rather than the one after.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('index.html', response.clone());
        return response;
      } catch {
        return (await caches.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then((response) => {
      if (response && response.ok) {
        caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
