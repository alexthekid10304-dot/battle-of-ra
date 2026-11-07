'use strict';
const http=require('node:http');
const http2=require('node:http2');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
let webpush;
try {webpush=require('web-push');} catch (_) {console.warn('[rah] Web push library not installed; run npm install.');}
const ROOT=path.resolve(__dirname,'..');
const PUBLIC=path.join(ROOT,'public');
const DATA=process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR):path.join(ROOT,'data');
const PORT=Number(process.env.PORT||3100);
const IS_PRODUCTION=process.env.NODE_ENV==='production';
const ADMIN_PASSCODE=process.env.ADMIN_PASSCODE || (IS_PRODUCTION ? '' : '6387');
if(!ADMIN_PASSCODE){console.error('ADMIN_PASSCODE must be set in production');process.exit(1)}
if(IS_PRODUCTION&&ADMIN_PASSCODE.length<8)console.warn('WARNING: short scorekeeper code. Use a long private password before making the site public.');
const PUBLIC_BASE_URL=process.env.PUBLIC_BASE_URL||`http://localhost:${PORT}`;
const VAPID_PUBLIC_KEY=process.env.VAPID_PUBLIC_KEY||'';
const VAPID_PRIVATE_KEY=process.env.VAPID_PRIVATE_KEY||'';
if(webpush&&VAPID_PUBLIC_KEY&&VAPID_PRIVATE_KEY)webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:organizer@example.com',VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);
const APNS_BUNDLE_ID=process.env.APPLE_BUNDLE_ID||'';
const APNS_TEAM_ID=process.env.APPLE_TEAM_ID||'';
const APNS_KEY_ID=process.env.APPLE_KEY_ID||'';
const APNS_KEY_FILE=process.env.APNS_KEY_FILE||'';
const APNS_HOST=process.env.APNS_ENV==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
const webSubscriptions=new Map(), liveTokens=new Set(), normalTokens=new Set(), sessions=new Map(), loginFailures=new Map(), clients=new Set();
let game={},version=0,clockEndsAt=0,apnsTokenCache={token:'',until:0};
let serial=Promise.resolve();
const store=(name)=>path.join(DATA,name);
const jsonRead=async(file,fallback)=>{try{return JSON.parse(await fsp.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}};
async function writeJSON(filename,obj){const target=store(filename),temp=target+'.tmp';await fsp.writeFile(temp,JSON.stringify(obj,null,2));await fsp.rename(temp,target)}
function withSerial(work){const result=serial.then(work);serial=result.catch(err=>console.error('write error',err));return result}
function saneInt(x,min,max,otherwise){let n=Number(x);return Number.isInteger(n)&&n>=min&&n<=max?n:otherwise}
function saneText(v,max=120){return String(v??'').slice(0,max)}
function sanitizeGame(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Invalid game body');
 const teamCount=['eagles','vipers'];
 const sanitized={...game,
 eagles:saneInt(body.eagles,0,9999,game.eagles),vipers:saneInt(body.vipers,0,9999,game.vipers),
 time:saneInt(body.time,0,6000,game.time),quarter:saneInt(body.quarter,1,5,game.quarter),
 status:['PREGAME','LIVE','HALFTIME','FINAL'].includes(body.status)?body.status:game.status,
 possession:['','eagles','vipers'].includes(body.possession)?body.possession:'',
 running:!!body.running,
 plays:Array.isArray(body.plays)?body.plays.slice(0,300):game.plays,
 log:Array.isArray(body.log)?body.log.slice(0,120):game.log,
 players:Array.isArray(body.players)?body.players.slice(0,100):game.players};
 if(JSON.stringify(sanitized).length>750000)throw Error('Game data too large');
 for(const p of sanitized.players){if(!p||typeof p.id!=='string'||typeof p.name!=='string'||p.name.length>90||!teamCount.includes(p.team))throw Error('Invalid roster')}
 for(const p of sanitized.plays){if(!p||typeof p.id!=='string'||typeof p.type!=='string'||!teamCount.includes(p.team)||p.id.length>100||p.type.length>60)throw Error('Invalid play');p.note=saneText(p.note,150)}
 // Clock ownership: preserve server end-time for an already-running period, independent of client sync interval.
 const wasRunning=!!game.running;
 if(sanitized.running){
   if(wasRunning&&clockEndsAt){sanitized.time=Math.max(0,Math.ceil((clockEndsAt-Date.now())/1000))}
   else{clockEndsAt=Date.now()+sanitized.time*1000}
 }else{clockEndsAt=0}
 return sanitized;
}
function currentGame(){const g={...game};if(g.running&&clockEndsAt){g.time=Math.max(0,Math.ceil((clockEndsAt-Date.now())/1000));if(g.time===0)g.running=false}return g}
function sendJSON(res,status,body,headers={}){const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':bytes.length,'X-Content-Type-Options':'nosniff',...headers});res.end(bytes)}
function rateLimited(map,ip,limit,windowMs){const t=Date.now(),s=map.get(ip)||{hits:0,start:t};if(t-s.start>windowMs){s.hits=0;s.start=t};s.hits++;map.set(ip,s);return s.hits>limit}
function getCookies(req){const result={};for(const p of (req.headers.cookie||'').split(';')){const i=p.indexOf('=');if(i>0)result[p.slice(0,i).trim()]=p.slice(i+1).trim()}return result}
function authorized(req){const token=getCookies(req).rah_session;return token&&sessions.get(token)>Date.now()}
function cookie(val,maxAge){return `rah_session=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${IS_PRODUCTION?'; Secure':''}`}
function safeOrigin(req){if(!req.headers.origin)return true;try{return new URL(req.headers.origin).host===req.headers.host}catch{return false}}
async function readBody(req,limit=1000000){let total=0,chunks=[];for await(const c of req){total+=c.length;if(total>limit)throw Object.assign(new Error('Payload too large'),{status:413});chunks.push(c)}return Buffer.concat(chunks)}
async function jsonBody(req,max){const b=await readBody(req,max);try{return JSON.parse(b.toString('utf8'))}catch{throw Object.assign(new Error('Bad JSON'),{status:400})}}
function latestPlay(g){return g.plays&&g.plays[0]}
function playerName(g,id){return g.players?.find(p=>p.id===id)?.name||'a player'}
function description(play,g){if(!play)return 'Scoreboard update';const p=playerName(g,play.player),yards=Number(play.yards)||0;
 const title={pass:`${p} catches a ${yards}-yd pass`,rush:`${p} rushes for ${yards} yd`,td_pass:`Touchdown! ${p} catches ${yards}-yd TD`,td_rush:`Touchdown! ${p} rushes ${yards} yd`,td_kickoff:`Kickoff return TD! ${p} ${yards} yd`,td_punt:`Punt return TD! ${p} ${yards} yd`,td_interception:`Pick-six! ${p} ${yards} yd`,td_fumble:`Fumble return TD! ${p} ${yards} yd`,kickoff_return:`${p} returns kickoff ${yards} yd`,punt_return:`${p} returns punt ${yards} yd`,punt:`${p} punts ${yards} yd`,field_goal:`${p}: ${yards}-yd field goal ${play.result==='made'?'GOOD':'missed'}`,pat:`${p}: PAT ${play.result==='made'?'GOOD':'missed'}`,safety:`Safety by ${p}!`,interception:`Interception by ${p}`,penalty:`Flag on ${play.team}`};
 return (title[play.type]||`${p} — ${String(play.type).replace(/_/g,' ')}`)+ (play.points>0?` (+${play.points})`:'');
}
function eventFromDiff(old,g){const prev=latestPlay(old),p=latestPlay(g);const newPlay=p&&p.id!==prev?.id?p:null;
 const score=old.eagles!==g.eagles||old.vipers!==g.vipers;
 const metadata=old.status!==g.status||old.quarter!==g.quarter||!!old.running!==!!g.running||old.possession!==g.possession;
 if(!newPlay&&!score&&!metadata)return null;
 const bigPlay=!!newPlay&&Number(newPlay.yards)>=20;
 return {kind:newPlay?'play':'score',play:newPlay,scoring:score||!!(newPlay&&newPlay.points>0),bigPlay,description:newPlay?description(newPlay,g):`Egyptian Eagles ${g.eagles} – ${g.vipers} Nile Vipers`,quarter:g.quarter,status:g.status};
}
function shouldNotify(preference,event){return preference==='all'&&!!event.play||event.scoring||preference==='highlights'&&event.bigPlay}
function toActivityContent(g){return {eagles:g.eagles,vipers:g.vipers,quarter:g.quarter===5?'OT':'Q'+g.quarter,clock:String(Math.floor(g.time/60)).padStart(2,'0')+':'+String(g.time%60).padStart(2,'0'),status:g.status,lastPlay:description(latestPlay(g),g).slice(0,150),isRunning:!!g.running,clockEndsAt:Math.floor(clockEndsAt/1000)}}
function broadcast(){const payload=`event: game\ndata: ${JSON.stringify({version})}\n\n`;for(const res of clients){try{res.write(payload)}catch{clients.delete(res)}}}
async function sendWebPush(event){if(!webpush||!VAPID_PRIVATE_KEY||!VAPID_PUBLIC_KEY)return;const title=event.scoring?'🏈 Battle of Rah — Score Update':'🏈 Battle of Rah — Play Update';const body=event.description;const payload=JSON.stringify({title,body,tag:event.play?'rah-'+event.play.id:'rah-score-'+version});
 await Promise.all([...webSubscriptions].map(async([endpoint,entry])=>{
 if(!shouldNotify(entry.preference,event))return;
 try{await webpush.sendNotification(entry.subscription,payload)}catch(err){if([404,410].includes(err.statusCode))webSubscriptions.delete(endpoint);else console.warn('web push failed',err.statusCode||err.message)}
 }));await writeJSON('websubs.json',[...webSubscriptions.values()]);}
function apnsConfigReady(){return !!(APNS_TEAM_ID&&APNS_KEY_ID&&APNS_BUNDLE_ID&&APNS_KEY_FILE)}
function apnsAuth(){if(!apnsTokenCache.token||Date.now()>apnsTokenCache.until){const head=Buffer.from(JSON.stringify({alg:'ES256',kid:APNS_KEY_ID})).toString('base64url'),body=Buffer.from(JSON.stringify({iss:APNS_TEAM_ID,iat:Math.floor(Date.now()/1000)})).toString('base64url'),data=`${head}.${body}`;
 const signature=crypto.sign('sha256',Buffer.from(data),{key:fs.readFileSync(APNS_KEY_FILE),dsaEncoding:'ieee-p1363'}).toString('base64url');apnsTokenCache={token:data+'.'+signature,until:Date.now()+45*60*1000}}return apnsTokenCache.token}
async function apnsPost(token,topic,pushType,payload){const client=http2.connect(APNS_HOST);return await new Promise((resolve,reject)=>{
 let finished=false;const finish=(error,response)=>{if(finished)return;finished=true;client.close();if(error)reject(error);else resolve(response)};
 const stream=client.request({':method':'POST',':path':'/3/device/'+token,'authorization':'bearer '+apnsAuth(),'apns-topic':topic,'apns-push-type':pushType,'apns-priority':'10'});
 let status=0,content='';stream.on('response',h=>{status=Number(h[':status'])});stream.setEncoding('utf8');stream.on('data',d=>content+=d);stream.on('end',()=>finish(null,{status,content}));stream.on('error',finish);stream.end(JSON.stringify(payload));setTimeout(()=>finish(Error('APNs timeout')),12000).unref();
 })}
let activityLastSend=0;
async function sendAppleUpdates(event,g){if(!apnsConfigReady())return;const topic=APNS_BUNDLE_ID+'.push-type.liveactivity';const now=Date.now();if(!event.play&&!event.scoring&&now-activityLastSend<12000)return;activityLastSend=now;
 const content={'aps':{'timestamp':Math.floor(now/1000),'event':g.status==='FINAL'?'end':'update','content-state':toActivityContent(g)}};
 const normal={'aps':{alert:{title:'Battle of Rah',body:event.description},sound:'default'}};
 await Promise.all([...liveTokens].map(async token=>{try{const result=await apnsPost(token,topic,'liveactivity',content);if([400,410].includes(result.status)){console.warn('APNs live token rejected',result.content);liveTokens.delete(token)}}catch(err){console.warn('APNs live push error',err.message)}}));
 if(shouldNotify('highlights',event)){await Promise.all([...normalTokens].map(async token=>{try{const result=await apnsPost(token,APNS_BUNDLE_ID,'alert',normal);if([400,410].includes(result.status))normalTokens.delete(token)}catch(err){console.warn('APNs normal push error',err.message)}}))}
 await writeJSON('apns-tokens.json',{live:[...liveTokens],normal:[...normalTokens]});}
function safeToken(input){return typeof input==='string'&&/^[a-f\d]{32,512}$/i.test(input)}
const staticTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
async function staticFile(req,res,urlPath){let decoded;try{decoded=decodeURIComponent(urlPath)}catch{sendJSON(res,400,{error:'Bad URL'});return}const pathname=decoded==='/'?'/index.html':decoded;
 if(!/^\/[a-z0-9_./-]+$/i.test(pathname)||pathname.includes('..')){sendJSON(res,404,{error:'Not found'});return}
 const filename=path.resolve(PUBLIC,'.'+pathname);if(!filename.startsWith(PUBLIC+path.sep)){sendJSON(res,404,{error:'Not found'});return}
 try{const file=await fsp.readFile(filename);res.writeHead(200,{'Content-Type':staticTypes[path.extname(filename)]||'application/octet-stream','Content-Length':file.length,'Cache-Control':pathname==='/sw.js'?'no-cache':pathname==='/index.html'?'no-cache':'public,max-age=3600','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});if(req.method==='HEAD')res.end();else res.end(file)}catch(e){sendJSON(res,404,{error:'Not found'})}
}
async function handler(req,res){const url=new URL(req.url,'http://'+req.headers.host);const route=url.pathname;const method=req.method||'GET';
 if(!['GET','HEAD','POST','PUT','DELETE'].includes(method)){sendJSON(res,405,{error:'Method not allowed'});return}
 if(!['GET','HEAD'].includes(method)&&!safeOrigin(req)){sendJSON(res,403,{error:'Cross-origin request denied'});return}
 try{
  if(route==='/api/health'&&method==='GET')return sendJSON(res,200,{ok:true,version});
  if(route==='/api/game'&&method==='GET')return sendJSON(res,200,{version,game:currentGame()});
  if(route==='/api/push-config'&&method==='GET')return sendJSON(res,200,{publicKey:VAPID_PUBLIC_KEY});
  if(route==='/api/events'&&method==='GET'){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
  }
  if(route==='/api/login'&&method==='POST'){
   const ip=req.socket.remoteAddress||'unknown';if(rateLimited(loginFailures,ip,10,60000))return sendJSON(res,429,{error:'Too many login attempts'});
   const body=await jsonBody(req,2048),a=Buffer.from(String(body.code||'')),b=Buffer.from(ADMIN_PASSCODE);
   if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return sendJSON(res,401,{error:'Wrong code'});
   loginFailures.delete(ip);const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+8*3600000);
   return sendJSON(res,200,{ok:true},{'Set-Cookie':cookie(token,8*3600)});
  }
  if(route==='/api/logout'&&method==='POST'){
   const t=getCookies(req).rah_session;sessions.delete(t);return sendJSON(res,200,{ok:true},{'Set-Cookie':cookie('',0)});
  }
  if(route==='/api/game'&&method==='PUT'){
   if(!authorized(req))return sendJSON(res,401,{error:'Scorekeeper login required'});
   const body=await jsonBody(req,750000);
   return withSerial(async()=>{
    const old=currentGame(),next=sanitizeGame(body.game);
    game=next;version++;await writeJSON('game.json',{version,game,clockEndsAt});broadcast();
    const change=eventFromDiff(old,next);
    if(change){Promise.allSettled([sendWebPush(change),sendAppleUpdates(change,next)]).catch(console.warn)}
    return sendJSON(res,200,{ok:true,version});
   });
  }
  if(route==='/api/web-subscriptions'&&method==='POST'){
   const ip=req.socket.remoteAddress||'unknown';if(rateLimited(loginFailures,'push'+ip,35,3600000))return sendJSON(res,429,{error:'Rate limit'});
   const b=await jsonBody(req,10000),s=b.subscription,preference=['scores','highlights','all'].includes(b.preference)?b.preference:'scores';
   if(!s||typeof s.endpoint!=='string'||s.endpoint.length>2048||typeof s.keys?.auth!=='string'||typeof s.keys?.p256dh!=='string')return sendJSON(res,400,{error:'Bad subscription'});
   const target=new URL(s.endpoint);
   if(target.protocol!=='https:'||!(/(^|\.)(push\.apple\.com|push\.services\.mozilla\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|notify\.windows\.com)$/.test(target.hostname)))return sendJSON(res,400,{error:'Unsupported push service'});
   webSubscriptions.set(s.endpoint,{subscription:{endpoint:s.endpoint,keys:s.keys},preference});await writeJSON('websubs.json',[...webSubscriptions.values()]);return sendJSON(res,201,{ok:true});
  }
  if(route==='/api/apns-register'&&method==='POST'){
   const ip=req.socket.remoteAddress||'unknown';if(rateLimited(loginFailures,'apns'+ip,50,3600000))return sendJSON(res,429,{error:'Rate limit'});
   const b=await jsonBody(req,5000);if(!safeToken(b.token)||!['live','normal'].includes(b.kind))return sendJSON(res,400,{error:'Invalid APNs token'});
   const set=b.kind==='live'?liveTokens:normalTokens;set.add(b.token);await writeJSON('apns-tokens.json',{live:[...liveTokens],normal:[...normalTokens]});return sendJSON(res,201,{ok:true});
  }
  if(route.startsWith('/api/'))return sendJSON(res,404,{error:'Unknown API route'});
  if(method==='GET'||method==='HEAD')return staticFile(req,res,route);
  return sendJSON(res,405,{error:'Method not allowed'});
 }catch(e){console.error('Request error',e.message);sendJSON(res,e.status||400,{error:e.message})}
}
async function main(){await fsp.mkdir(DATA,{recursive:true});const saved=await jsonRead(store('game.json'),null);if(saved){game=saved.game;version=saved.version||0;clockEndsAt=saved.clockEndsAt||0}else{game=await jsonRead(path.join(__dirname,'initial-game.json'),{})}
 for(const s of await jsonRead(store('websubs.json'),[]))if(s.subscription?.endpoint)webSubscriptions.set(s.subscription.endpoint,s);
 const t=await jsonRead(store('apns-tokens.json'),{});for(const x of t.live||[])liveTokens.add(x);for(const x of t.normal||[])normalTokens.add(x);
 const server=http.createServer(handler);server.listen(PORT,'0.0.0.0',()=>console.log(`[rah] live game: ${PUBLIC_BASE_URL} (port ${PORT})`));
 setInterval(()=>{for(const c of clients){try{c.write(':keepalive\n\n')}catch{clients.delete(c)}};for(const [k,t] of sessions)if(t<Date.now())sessions.delete(k)},25000).unref();
}
if(require.main===module)main().catch(err=>{console.error(err);process.exit(1)});
module.exports={sanitizeGame,currentGame,description,eventFromDiff,toActivityContent};
