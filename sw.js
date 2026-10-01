const CACHE='procurement-quiz-v23-2-9';
const ASSETS=[
  './',
  './index.html',
  './firebase-config.js',
  './firebase-sync.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  "./law-parts.json",
  "./law-assets/part001/page-001.png",
  "./law-assets/part001/page-002.png",
  "./law-assets/part001/page-003.png",
  "./law-assets/part001/page-004.png",
  "./law-assets/part001/page-005.png",
  "./law-assets/part001/page-006.png",
  "./law-assets/part001/page-007.png",
  "./law-assets/part001/page-008.png"
];

self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);

  if(request.method!=='GET'||url.origin!==self.location.origin){
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response=>{
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(request,copy));
        return response;
      })
      .catch(()=>caches.match(request).then(match=>match||caches.match('./index.html')))
  );
});
