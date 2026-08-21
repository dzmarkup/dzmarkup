/**
 * COI Service Worker — injects Cross-Origin-Opener-Policy and
 * Cross-Origin-Embedder-Policy headers so FFmpeg.wasm works on any host
 * (including Brave Browser) without server-side header configuration.
 *
 * Upload this file to the SAME folder as mp4-joiner.html on your server.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (!response || response.status === 0 || response.type === 'opaque') return response;

        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
        newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      })
      .catch(() => fetch(event.request))
  );
});
