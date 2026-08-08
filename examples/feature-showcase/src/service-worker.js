/* This file is emitted as /sw.js by the resource-query rule in runtime-config.ts. */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/*
 * The showcase intentionally does not intercept fetch requests. It demonstrates
 * Nami's delayed Service Worker registration without making development output
 * appear stale because of an example-level cache policy.
 */
