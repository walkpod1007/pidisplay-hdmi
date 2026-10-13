'use strict';
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const express = require('express');
const QR = require('qrcode');
const {wifiQR, selectRoonTrack, applyZones, secureEqual} = require('./model');
const {SonosReader} = require('./sonos-reader');
const {chooseSource,setupPhase} = require('./source-choice');
const dir = process.env.PIDISPLAY_STATE || path.join(os.homedir(), '.local/state/pidisplay');
fs.mkdirSync(dir, {recursive:true, mode:0o700});
const file = path.join(dir,'settings.json');
let config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {pin:crypto.randomInt(100000,1000000).toString(), source:'auto', zone:'', hotspotPassword:crypto.randomBytes(12).toString('base64url')};
function save() { const temp=file+'.tmp'; fs.writeFileSync(temp,JSON.stringify(config),{mode:0o600}); fs.renameSync(temp,file); }
if (!['auto','sonos','roon'].includes(config.source)) config.source='auto';
save();
const app = express(), sessions = new Map(), zones = {};
let core = null, net = {available:false};
const demo = process.env.PIDISPLAY_DEMO === '1';
const port = Number(process.env.PORT || 8787);
const sonos = new SonosReader();
function network(action, args={}) {
  if (demo) return Promise.resolve({available:false, message:'展示模式：未操作 Wi-Fi'});
  return new Promise((resolve,reject) => {
    const child=spawn('sudo',['-n','/usr/local/libexec/pidisplay-network'],{stdio:['pipe','pipe','pipe']});
    let out='';
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('網路操作逾時'));},70000);
    child.stdout.on('data',b=>{out+=b;if(out.length>262144)child.kill();});
    child.stderr.resume();
    child.on('error',()=>{clearTimeout(timer);reject(new Error('網路工具尚未安裝'));});
    child.on('close',code=>{clearTimeout(timer);try {if(code)throw Error();resolve(JSON.parse(out));}catch {reject(new Error('網路設定未成功，請檢查 Wi-Fi 或安裝狀態'));}});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({action,...args}));
  });
}
const {createNetworkMonitor}=require('./network-monitor');
const networkMonitor=createNetworkMonitor(network,()=>config.hotspotPassword);
async function refreshNetwork() {net=await networkMonitor.poll(()=>connecting);}
function addresses() {if(demo)return [`http://127.0.0.1:${port}`];return Object.values(os.networkInterfaces()).flat().filter(a=>a.family==='IPv4'&&!a.internal&&!a.address.startsWith('169.254.')).map(a=>`http://${a.address}:${port}`);}
app.disable('x-powered-by');
app.use((req,res,next)=>{const allowed=['127.0.0.1','localhost','[::1]',os.hostname(),os.hostname()+'.local','pidisplay.local',...Object.values(os.networkInterfaces()).flat().map(a=>a.address)];if(!allowed.includes(req.hostname))return res.sendStatus(403);next();});
app.use(express.json({limit:'16kb'}));
app.use((req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Content-Security-Policy',"default-src 'self'; img-src 'self' data: https://i.scdn.co https://mosaic.scdn.co; style-src 'self'; script-src 'self'; frame-ancestors 'none'");next();});
function local(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);}
app.use('/api', (req,res,next)=>{
  if(req.method==='POST') {
    const origin=req.get('origin');
    if(!req.is('application/json') || (origin && origin!==`${req.protocol}://${req.get('host')}`)) return res.sendStatus(403);
  }
  next();
});
const attempts = new Map();
app.post('/api/login',(req,res)=>{
  const ip=req.socket.remoteAddress, now=Date.now(); let a=attempts.get(ip);
  if(!a||now>a.until){a={count:0,until:now+60000};attempts.set(ip,a);}
  if(++a.count>8)return res.status(429).json({error:'請一分鐘後再試'});
  if(!secureEqual(req.body.pin,config.pin))return res.status(401).json({error:'配對碼不正確'});
  const token=crypto.randomBytes(32).toString('hex');sessions.set(token,now+86400000);
  res.cookie('session',token,{httpOnly:true,sameSite:'strict',maxAge:86400000});res.json({ok:true});
});
function auth(req,res,next){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8);if((sessions.get(token)||0)<Date.now())return res.status(401).json({error:'請輸入 HDMI 螢幕上的配對碼'});next();}
app.get('/api/status',(req,res)=>{
  const track = demo ? {source:'展示',title:'歌曲畫面預覽',artist:'Sonos · Roon',album:'連結播放器後顯示真實歌曲',playing:true,progress:42000,duration:240000,art:''} : chooseSource(config.source,sonos.track(config.sonosGroup),selectRoonTrack(zones,config.zone));
  res.json({track,phase:setupPhase(net,config.sourceConfigured,demo),sonosGroups:sonos.groups.map(g=>({id:g.id,name:g.name})),sonosGroup:config.sonosGroup||'',sonosStatus:sonos.message,source:config.source,zone:config.zone,zones:Object.values(zones).map(z=>({id:z.zone_id,name:z.display_name})),roonStatus:core?'Roon 已連結':'請至 Roon → 設定 → 擴充功能啟用 PiDisplay HDMI',network:{available:net.available,connected:net.connected,hotspot:net.hotspot,message:net.message},addresses:addresses(),demo});
});
app.get('/api/local-setup', async(req,res)=>{
  if(!local(req))return res.sendStatus(403);
  const url=(net.hotspot?`http://10.42.0.1:${port}`:addresses()[0]||`http://pidisplay.local:${port}`)+'/setup';
  res.json({pin:config.pin,url,qr:await QR.toDataURL(url),wifiQR:net.hotspot?await QR.toDataURL(wifiQR('PiDisplay-Setup',config.hotspotPassword)):null});
});
app.get('/api/settings',auth,(req,res)=>res.json({sonosGroup:config.sonosGroup||'',source:config.source,zone:config.zone}));
app.post('/api/settings',auth,(req,res)=>{const {source,zone,sonosGroup=''}=req.body;if(typeof sonosGroup!=='string'||sonosGroup.length>256||!['auto','sonos','roon'].includes(source)||typeof zone!=='string'||zone.length>256)return res.sendStatus(400);config.source=source;config.zone=zone;config.sonosGroup=sonosGroup;config.sourceConfigured=true;save();res.json({ok:true});});
app.post('/api/sonos/scan',auth,async(req,res)=>{if(demo)return res.json({groups:[],message:'展示模式不搜尋裝置'});sonos.nextScan=0;await sonos.poll(config.sonosGroup);res.json({groups:sonos.groups.map(g=>({id:g.id,name:g.name})),message:sonos.message});});
app.post('/api/setup/skip',auth,(req,res)=>{config.sourceConfigured=true;save();res.json({ok:true});});
app.get('/api/sonos-art/:id',async(req,res)=>{try{const r=await sonos.image(req.params.id,req.query.h==='1');res.type(r.type).send(r.body);}catch{res.sendStatus(404);}});
app.get('/api/wifi',auth,async(req,res)=>{try{res.json(await network('scan'));}catch(e){res.status(503).json({error:e.message});}});
let connecting=false;
app.post('/api/wifi',auth,async(req,res)=>{
  const {ssid,password}=req.body;
  if(typeof ssid!=='string'||!ssid||Buffer.byteLength(ssid)>32||typeof password!=='string'||password.length>64)return res.status(400).json({error:'Wi-Fi 名稱或密碼格式不正確'});
  if(connecting)return res.status(409).json({error:'正在連線，請稍候'});
  if(demo)return res.status(409).json({error:'展示模式不變更 Wi-Fi'});
  connecting=true;res.status(202).json({ok:true,message:'正在切換 Wi-Fi。請把手機切回室內 Wi-Fi，查看 HDMI 螢幕的新網址。失敗會恢復設定熱點。'});
  try{await network('connect',{ssid,password,hotspotPassword:config.hotspotPassword});}catch{net.message='連線失敗，已要求恢復設定熱點';}finally{connecting=false;await refreshNetwork();}
});
if(!demo){
  const RoonApi=require('node-roon-api'),Transport=require('node-roon-api-transport'),Image=require('node-roon-api-image');
  process.chdir(dir);
  const roon=new RoonApi({extension_id:'local.pidisplay.hdmi',display_name:'PiDisplay HDMI',display_version:'1.0.0',publisher:'PiDisplay local',email:'',core_paired:c=>{core=c;c.services.RoonApiTransport.subscribe_zones((cmd,d)=>{if(core===c)applyZones(zones,cmd,d);});},core_unpaired:c=>{if(core===c){core=null;Object.keys(zones).forEach(k=>delete zones[k]);}}});
  roon.init_services({required_services:[Transport,Image]});roon.start_discovery();
}
app.get('/api/roon-art/:key',(req,res)=>{if(!core)return res.sendStatus(404);let sent=false;const timer=setTimeout(()=>{sent=true;res.sendStatus(504);},10000);core.services.RoonApiImage.get_image(req.params.key,{scale:'fit',width:1536,height:1536,format:'image/jpeg'},(err,type,body)=>{clearTimeout(timer);if(sent)return;if(err)return res.sendStatus(404);res.type(type).send(body);});});
app.get('/setup',(req,res)=>res.sendFile(path.join(__dirname,'public/setup.html')));
app.use(express.static(path.join(__dirname,'public')));
app.use((err,req,res,next)=>res.status(400).json({error:'無法處理要求'}));
app.listen(port,process.env.PIDISPLAY_BIND||'0.0.0.0',()=>console.log(`PiDisplay HDMI listening on ${port}`));
refreshNetwork();
setInterval(refreshNetwork,15000).unref();
setInterval(()=>{for(const [k,v]of sessions)if(v<Date.now())sessions.delete(k);for(const[k,v]of attempts)if(v.until<Date.now())attempts.delete(k);},60000).unref();

if(!demo)(async function sonosLoop(){try{await sonos.poll(config.sonosGroup);}catch{sonos.message='Sonos 連線中斷，正在重試';}setTimeout(sonosLoop,3000).unref();})();
