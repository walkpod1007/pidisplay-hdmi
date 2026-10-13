'use strict';
const dgram = require('node:dgram');
const {parseStringPromise,processors} = require('xml2js');
const {isIP} = require('node:net');
const {platformFromUri,qualityFromRes,artCandidates,appleSongId,AppleArtLookup} = require('./track-info');
const array = v => v ? (Array.isArray(v)?v:[v]):[];
const xml = s => parseStringPromise(s,{explicitArray:false,mergeAttrs:true,tagNameProcessors:[processors.stripPrefix]});
function localIPv4(ip){if(isIP(ip)!==4)return false;const p=ip.split('.').map(Number);return p[0]===10||p[0]===192&&p[1]===168||p[0]===172&&p[1]>=16&&p[1]<=31;}
function speakerURL(value){try{const u=new URL(value);return u.protocol==='http:'&&localIPv4(u.hostname)&&u.port==='1400'&&!u.username&&!u.password?u:null;}catch{return null;}}
async function readLimited(url,options={},timeout=7000){
 const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error('Sonos HTTP '+r.status);
 const chunks=[];let size=0;for await(const b of r.body){size+=b.length;if(size>8*1024*1024)throw Error('Response too large');chunks.push(Buffer.from(b));}return {body:Buffer.concat(chunks),type:r.headers.get('content-type')||''};
}
async function soap(host,service,action){
 if(!localIPv4(host))throw Error('Invalid Sonos address');
 const path=service==='ZoneGroupTopology'?'/ZoneGroupTopology/Control':'/MediaRenderer/AVTransport/Control';
 const args=service==='AVTransport'?'<InstanceID>0</InstanceID>':'';
 const body=`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${args}</u:${action}></s:Body></s:Envelope>`;
 const r=await readLimited(`http://${host}:1400${path}`,{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"urn:schemas-upnp-org:service:${service}:1#${action}"`},body});
 return (await xml(r.body.toString())).Envelope.Body[action+'Response'];
}
function discover(){return new Promise(resolve=>{const hosts=new Set(),socket=dgram.createSocket('udp4');let closed=false;
 const done=()=>{if(closed)return;closed=true;clearTimeout(timer);try{socket.close();}catch{}resolve([...hosts]);};const timer=setTimeout(done,2500);
 socket.on('error',done);socket.on('message',(bytes,info)=>{const s=bytes.toString();const loc=s.match(/^location:\s*(.+)$/im)?.[1]?.trim(),u=speakerURL(loc);if(u&&u.hostname===info.address&&/zoneplayer|sonos/i.test(s))hosts.add(u.hostname);});
 socket.bind(0,()=>{const req=Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');socket.send(req,1900,'239.255.255.250',err=>{if(err)done();});});});}
function timeMs(s){if(typeof s!=='string'||!/^\d+:\d+:\d+$/.test(s))return 0;return s.split(':').reduce((n,v)=>n*60+Number(v),0)*1000;}
async function groupList(raw){const d=await xml(raw);return array((d.ZoneGroupState?.ZoneGroups||d.ZoneGroups)?.ZoneGroup).flatMap(g=>{const members=array(g.ZoneGroupMember),c=members.find(m=>m.UUID===g.Coordinator),u=speakerURL(c?.Location);return u?[{id:g.Coordinator,name:c.ZoneName+(members.length>1?` + ${members.length-1}`:''),host:u.hostname}]:[];});}
async function normalize(info,state,group){
 if(!info.TrackMetaData||info.TrackMetaData==='NOT_IMPLEMENTED')return null;
 const d=await xml(info.TrackMetaData),i=array(d['DIDL-Lite']?.item)[0];if(!i?.title)return null;
 const text=v=>typeof v==='object'?v?._||'':v||'';
 return {source:'Sonos',title:text(i.title),artist:text(i.creator),album:text(i.album),playing:state.CurrentTransportState==='PLAYING',progress:timeMs(info.RelTime),duration:timeMs(info.TrackDuration),zone:group.name,service:platformFromUri(text(info.TrackURI)||text(i.res)),trackURI:text(info.TrackURI)||text(i.res),quality:qualityFromRes(i.res),artURI:text(i.albumArtURI)};
}
class SonosReader{
 constructor(){this.groups=[];this.tracks=new Map();this.artURLs=new Map();this.apple=new AppleArtLookup();this.soap=soap;this.get=readLimited;this.jobs=new Map();this.big=new Map();this.message='正在搜尋區網 Sonos';this.busy=false;this.nextScan=0;}
 async scan(){const hosts=await discover();for(const host of hosts){try{const s=await soap(host,'ZoneGroupTopology','GetZoneGroupState');this.groups=await groupList(s.ZoneGroupState);this.message=this.groups.length?'Sonos 已找到':'找不到 Sonos 播放群組';return;}catch{}}
 this.groups=[];this.tracks.clear();this.artURLs.clear();this.message='尚未找到 Sonos，請確認同一區網';}
 async poll(selected=''){
 if(this.busy)return;this.busy=true;
 try{if(Date.now()>this.nextScan){this.nextScan=Date.now()+30000;await this.scan();}
 const targets=selected?this.groups.filter(g=>g.id===selected):this.groups.slice(0,8);
 const live=new Set(targets.map(g=>g.id));for(const id of this.tracks.keys())if(!live.has(id))this.drop(id);
 await Promise.allSettled(targets.map(async g=>{try{const [info,state]=await Promise.all([this.soap(g.host,'AVTransport','GetPositionInfo'),this.soap(g.host,'AVTransport','GetTransportInfo')]);const t=await normalize(info,state,g);if(!t){this.drop(g.id);return;}
 const u=new URL(t.artURI||'/',`http://${g.host}:1400`);
 if(t.artURI&&this.allowedArt(u)){const key=t.title+'|'+t.trackURI;this.artURLs.set(g.id,[u.href]);t.art=`/api/sonos-art/${encodeURIComponent(g.id)}?v=${encodeURIComponent(t.title)}`;this.startBig(g.id,key,t.trackURI,u.href,{title:t.title,artist:t.artist,album:t.album,service:t.service});if(this.big.get(g.id)?.key===key)t.art+='&h=1';}else{t.art='';this.drop(g.id);}
 delete t.artURI;delete t.trackURI;this.tracks.set(g.id,t);
 }catch{this.drop(g.id);}}));
 for(const id of [...this.jobs.keys()])if(!live.has(id))this.drop(id);
 }finally{this.busy=false;}}
 drop(id){this.tracks.delete(id);this.artURLs.delete(id);this.jobs.delete(id);this.big.delete(id);}
 // 大圖全在背景取：同一個群組同時只有一條工作；每首歌最多 1 次加 2 次重試（間隔 60 秒）；只留目前這首歌的一張。
 startBig(id,key,trackURI,origHref,meta={}){
  let job=this.jobs.get(id);
  if(job&&job.key===key){if(job.state!=='failed'||job.tries>=3||Date.now()<job.nextAt)return;}
  else{this.big.delete(id);job={key,tries:0};this.jobs.set(id,job);}
  job.state='running';job.tries++;
  this.runBig(id,job,trackURI,origHref,meta).catch(()=>{}).then(()=>{if(job.state==='running'){job.state='failed';job.nextAt=Date.now()+60000;}});
 }
 async runBig(id,job,trackURI,origHref,meta={}){
  const cands=[];let apple=await this.apple.bigArt(appleSongId(trackURI));
  if(!apple&&meta.service!=='電台'&&meta.title&&meta.artist)apple=await this.apple.bigArtBySearch(meta.artist,meta.title,meta.album);
  if(apple)cands.push(apple);
  const all=artCandidates(origHref);cands.push(...all.slice(0,-1));
  for(const c of cands){try{if(!this.allowedArt(new URL(c)))continue;const r=await this.get(c,{},20000);if(!/^image\/(jpeg|png|webp)(;|$)/i.test(r.type))continue;
   if(this.jobs.get(id)!==job)return;this.big.set(id,{key:job.key,body:r.body,type:r.type});job.state='done';return;}catch{}}
 }
 allowedArt(u){return (u.protocol==='http:'&&u.port==='1400'&&this.groups.some(g=>g.host===u.hostname))||(u.protocol==='https:'&&!u.username&&!u.password&&['scdn.co','mzstatic.com','resources.tidal.com','static.qobuz.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)));}
 track(id){return id?this.tracks.get(id)||null:[...this.tracks.values()].find(t=>t.playing)||[...this.tracks.values()][0]||null;}
 async image(id,wantBig=false){
  if(wantBig){const b=this.big.get(id);if(b)return {body:b.body,type:b.type};}
  const list=this.artURLs.get(id)||[];let last=Error('No art');for(const v of list){try{if(!this.allowedArt(new URL(v)))continue;const r=await this.get(v);if(!/^image\/(jpeg|png|webp)(;|$)/i.test(r.type))throw Error('Not a raster image');return r;}catch(e){last=e;}}throw last;}
}
module.exports={SonosReader,localIPv4,speakerURL,timeMs,groupList,normalize};
