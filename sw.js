const CACHE='rah-assets-v2';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/manifest.webmanifest','/icons/icon-192.png'])));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});
self.addEventListener('push',e=>{let data={};try{data=e.data.json()}catch(_){data={title:'Battle of Rah',body:'New game update'}};e.waitUntil(self.registration.showNotification(data.title||'Battle of Rah',{body:data.body||'New game update',icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:data.tag||'rah-event',data:{url:'/'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if(c.url.includes(self.location.origin)){c.focus();return}}return self.clients.openWindow('/')}))});
