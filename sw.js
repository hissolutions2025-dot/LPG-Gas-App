// Minimal service worker whose only job is to stop phones running this app as a
// home-screen ("standalone") PWA from silently serving a stale index.html after a
// new version has been deployed - see index.html's registration script (near the
// end of its main <script> block) for the other half of this fix, which prompts a
// reload once a new version actually takes over.
//
// Deliberately NOT a general offline-asset cache: this app needs a live connection
// to sync (Supabase + the Sheets proxy) anyway, so there's no real offline mode to
// support beyond "don't hard-fail if the network blips while loading the shell".
// Only the app shell itself (this origin's navigation requests, i.e. index.html) is
// ever cached, and only as a last-resort fallback when the network is genuinely
// unreachable - every online load goes to the network FIRST, bypassing the HTTP
// cache entirely (cache:'no-store'), so a fresh deploy is picked up on the very
// next load, not whenever the phone's own cache happens to expire.
var SHELL_CACHE = 'gas-app-shell-v1';

self.addEventListener('install', function(e){
  // Don't wait for every open tab to close before this version takes over - see
  // the 'activate' handler's clients.claim() for the other half of that.
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){return k!==SHELL_CACHE;}).map(function(k){return caches.delete(k);}));
    }).then(function(){return self.clients.claim();})
  );
});

self.addEventListener('fetch', function(e){
  if(e.request.method!=='GET')return; // never intercept POSTs (Supabase/Sheets sync calls)
  if(e.request.mode!=='navigate')return; // only the page shell itself - not API calls, images, fonts
  e.respondWith(
    fetch(e.request,{cache:'no-store'}).then(function(res){
      var copy=res.clone();
      caches.open(SHELL_CACHE).then(function(c){c.put(e.request,copy);}).catch(function(){});
      return res;
    }).catch(function(){
      return caches.open(SHELL_CACHE).then(function(c){return c.match(e.request);}).then(function(cached){
        return cached || Response.error();
      });
    })
  );
});
