const {test}=require('node:test'),assert=require('node:assert/strict');
const {platformFromUri,qualityFromRes,artCandidates}=require('./track-info');
const {normalize,SonosReader}=require('./sonos-reader');
test('platform from real URI shapes (Apple Music shape captured live 2026-10-03; others from Sonos public URI schemes)',()=>{
 const cases={
  'x-sonos-http:song%3a1802208396.mp4?sid=204&flags=8232&sn=16':'Apple Music',
  'x-sonos-http:track%3a4uLU6hMCjMI75M1A2tKUQC.mp4?sid=9&flags=8232&sn=3':'Spotify',
  'x-sonos-spotify:spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC?sid=12&flags=8232&sn=2':'Spotify',
  'x-sonos-vli:RINCON_949F3E56BBCC01400:2,spotify:0123abcd':'Spotify',
  'x-sonos-http:abc123.mp4?sid=284&flags=8232&sn=1':'YouTube Music',
  'x-sonos-http:track%3a12345.flac?sid=174&flags=8232&sn=1':'Tidal',
  'x-sonos-http:track%3a1.flac?sid=31&flags=8232&sn=1':'Qobuz',
  'x-sonos-http:trk-1.mp4?sid=227&flags=8232&sn=1':'KKBOX',
  'x-sonos-vli:RINCON_949F3E56BBCC01400:1,airplay:abcdef':'AirPlay',
  'x-sonosapi-stream:s12345?sid=254&flags=8224&sn=0':'電台',
  'x-sonosapi-hls-static:ALC%3a1?sid=303&flags=0&sn=0':'電台',
  'x-rincon-mp3radio://radio.example/stream':'電台',
  'x-file-cmp:\\\\NAS\\music\\a.flac':'音樂庫',
  'x-smb://NAS/music/a.flac':'音樂庫',
  'x-rincon-stream:RINCON_949F3E56BBCC01400':'Line-In',
  'x-sonos-htastream:RINCON_949F3E56BBCC01400:spdif':'電視',
 };
 for(const [u,e] of Object.entries(cases))assert.equal(platformFromUri(u),e,u);
 assert.equal(platformFromUri('x-sonos-http:a.mp4?sid=99999&flags=0'),'');
 assert.equal(platformFromUri(''),'');assert.equal(platformFromUri(undefined),'');assert.equal(platformFromUri('weird:thing'),'');
});
test('quality: full, partial, none; never invented',()=>{
 assert.equal(qualityFromRes({protocolInfo:'sonos.com-http:*:audio/flac:*',bitsPerSample:'24',sampleFrequency:'48000'}),'FLAC 24-bit／48 kHz');
 assert.equal(qualityFromRes({protocolInfo:'http-get:*:audio/flac:*',bitsPerSample:'16',sampleFrequency:'44100'}),'FLAC 16-bit／44.1 kHz');
 assert.equal(qualityFromRes({protocolInfo:'x:*:audio/mpeg:*'}),'MP3');
 assert.equal(qualityFromRes({protocolInfo:'x:*:audio/flac:*'}),'FLAC');
 assert.equal(qualityFromRes({protocolInfo:'x:*:audio/mpeg:*',sampleFrequency:'44100'}),'MP3 44.1 kHz');
 // the Apple Music res captured live: container only, no codec/rate -> nothing shown
 assert.equal(qualityFromRes({protocolInfo:'sonos.com-http:*:audio/mp4:*',duration:'0:04:39',_:'x-sonos-http:song%3a1.mp4?sid=204'}),'');
 assert.equal(qualityFromRes({protocolInfo:'x:*:audio/mp4:*',bitrate:'256000'}),'');
 assert.equal(qualityFromRes(undefined),'');assert.equal(qualityFromRes('text'),'');
});
test('normalize fills service and quality from the speaker reply',async()=>{
 const meta=(res)=>`<DIDL-Lite xmlns:dc="dc" xmlns:upnp="upnp"><item><res protocolInfo="sonos.com-http:*:audio/mp4:*" duration="0:04:39">${res}</res><dc:title>T</dc:title></item></DIDL-Lite>`;
 const uri='x-sonos-http:song%3a1802208396.mp4?sid=204&flags=8232&sn=16';
 const t=await normalize({TrackMetaData:meta(uri.replace(/&/g,'&amp;')),TrackURI:uri,RelTime:'0:00:01',TrackDuration:'0:04:39'},{CurrentTransportState:'PLAYING'},{name:'書房'});
 assert.equal(t.service,'Apple Music');assert.equal(t.quality,'');assert.equal(t.zone,'書房');
 const u=await normalize({TrackMetaData:meta('x-weird:foo')},{},{name:'R'});assert.equal(u.service,'');
});
test('cover URL upscaling stays inside allowed hosts and falls back to the original',async()=>{
 assert.deepEqual(artCandidates('https://is1-ssl.mzstatic.com/image/thumb/Music/ab/cd/x.jpg/600x600bb.jpg'),['https://is1-ssl.mzstatic.com/image/thumb/Music/ab/cd/x.jpg/1536x1536bb.jpg','https://is1-ssl.mzstatic.com/image/thumb/Music/ab/cd/x.jpg/600x600bb.jpg']);
 assert.deepEqual(artCandidates('https://i.scdn.co/image/ab67616d00001e02aaaa'),['https://i.scdn.co/image/ab67616d0000b273aaaa','https://i.scdn.co/image/ab67616d00001e02aaaa']);
 assert.equal(artCandidates('https://resources.tidal.com/images/a/b/320x320.jpg')[0],'https://resources.tidal.com/images/a/b/1280x1280.jpg');
 assert.equal(artCandidates('https://static.qobuz.com/images/covers/aa/bb/xyz_600.jpg')[0],'https://static.qobuz.com/images/covers/aa/bb/xyz_max.jpg');
 // no size token, speaker proxy, other host: unchanged single candidate
 assert.deepEqual(artCandidates('https://is1-ssl.mzstatic.com/image/x.jpg'),['https://is1-ssl.mzstatic.com/image/x.jpg']);
 assert.deepEqual(artCandidates('http://192.168.4.20:1400/getaa?s=1&u=x'),['http://192.168.4.20:1400/getaa?s=1&u=x']);
 assert.deepEqual(artCandidates('https://evil.example/600x600bb.jpg'),['https://evil.example/600x600bb.jpg']);
 // reader: big fails -> original used; rewrite never leaves the allowlist
 const r=new SonosReader();r.groups=[{host:'192.168.4.20'}];
 const orig='https://is1-ssl.mzstatic.com/a.jpg/600x600bb.jpg';
 r.artURLs.set('g',artCandidates(orig).filter(h=>r.allowedArt(new URL(h))));
 assert.equal(r.artURLs.get('g').length,2);
 const calls=[],real=global.fetch;
 global.fetch=async(u)=>{calls.push(u);if(u.includes('1536x1536'))return {ok:false,status:404};return {ok:true,status:200,headers:{get:()=>'image/jpeg'},body:(async function*(){yield Buffer.from('jpg');})()};};
 try{const img=await r.image('g');assert.equal(img.body.toString(),'jpg');assert.equal(calls.length,2);assert(calls[1].endsWith('600x600bb.jpg'));}finally{global.fetch=real;}
});
const {appleSongId,appleBigArt,AppleArtLookup}=require('./track-info');
const lookupBody=(arts)=>({ok:true,status:200,body:(async function*(){yield Buffer.from(JSON.stringify({resultCount:arts.length,results:arts.map(a=>({artworkUrl100:a}))}));})()});
test('Apple song id extraction accepts only sid=204 numeric ids',()=>{
 assert.equal(appleSongId('x-sonos-http:song%3a1802208396.mp4?sid=204&flags=8232&sn=16'),'1802208396');
 assert.equal(appleSongId('x-sonos-http:song:55.mp4?sid=204&flags=8232'),'55');
 assert.equal(appleSongId('x-sonos-http:song%3a1802208396.mp4?sid=9&flags=8232'),'');
 assert.equal(appleSongId('x-sonos-http:song%3a18abc.mp4?sid=204'),'');
 assert.equal(appleSongId('x-sonos-http:song%3a1%2f..%2fx.mp4?sid=204'),'');
 assert.equal(appleSongId(''),'');assert.equal(appleSongId(undefined),'');
});
test('lookup rewrites artworkUrl100 to 1536 and rejects non-numeric ids without any request',async()=>{
 assert.equal(appleBigArt('https://is1-ssl.mzstatic.com/image/thumb/Music/x/y.jpg/100x100bb.jpg'),'https://is1-ssl.mzstatic.com/image/thumb/Music/x/y.jpg/1536x1536bb.jpg');
 assert.equal(appleBigArt('http://is1-ssl.mzstatic.com/a/100x100bb.jpg'),'');assert.equal(appleBigArt('https://x.example/a.jpg'),'');
 const calls=[];const L=new AppleArtLookup(async(u)=>{calls.push(u);return lookupBody(['https://is1-ssl.mzstatic.com/a/100x100bb.jpg']);});
 for(const bad of ['abc','12 3','1;2','../x','',undefined])assert.equal(await L.bigArt(bad),'');
 assert.equal(calls.length,0);
 assert.equal(await L.bigArt('123'),'https://is1-ssl.mzstatic.com/a/1536x1536bb.jpg');
 assert.equal(calls.length,1);assert.equal(calls[0],'https://itunes.apple.com/lookup?id=123&country=tw');
});
test('lookup falls back tw -> us -> jp, then to nothing; failures fall through',async()=>{
 const calls=[];const L=new AppleArtLookup(async(u)=>{calls.push(u.match(/country=(\w+)/)[1]);const c=calls.at(-1);if(c==='tw')return lookupBody([]);if(c==='us')throw Error('net');return lookupBody(['https://is1-ssl.mzstatic.com/j/100x100bb.jpg']);});
 assert.equal(await L.bigArt('9'),'https://is1-ssl.mzstatic.com/j/1536x1536bb.jpg');assert.deepEqual(calls,['tw','us','jp']);
 const none=new AppleArtLookup(async()=>lookupBody([]));assert.equal(await none.bigArt('9'),'');
 const bad=new AppleArtLookup(async()=>({ok:false,status:500}));assert.equal(await bad.bigArt('9'),'');
 const huge=new AppleArtLookup(async()=>({ok:true,status:200,body:(async function*(){yield Buffer.alloc(300*1024);})()}));assert.equal(await huge.bigArt('9'),'');
});
test('lookup cache: success forever, failure retried only after 10 minutes',async()=>{
 let t=0,n=0,ok=false;const L=new AppleArtLookup(async()=>{n++;return ok?lookupBody(['https://is1-ssl.mzstatic.com/a/100x100bb.jpg']):{ok:false,status:500};},()=>t);
 assert.equal(await L.bigArt('7'),'');assert.equal(n,3);
 t=9*60*1000;assert.equal(await L.bigArt('7'),'');assert.equal(n,3);
 ok=true;t=10*60*1000+1;assert.equal(await L.bigArt('7'),'https://is1-ssl.mzstatic.com/a/1536x1536bb.jpg');assert.equal(n,4);
 t=99e9;assert.equal(await L.bigArt('7'),'https://is1-ssl.mzstatic.com/a/1536x1536bb.jpg');assert.equal(n,4);
});
test('platform detection is anchored to the URI scheme (no substring guesses)',()=>{
 for(const u of ['x-rincon-mp3radio://my.airplay.fm/stream','http://evil/airplay.mp3','x-rincon-mp3radio://radio.example/a?sid=204','aac://radio.example/s?sid=9','x-sonos-vli:RINCON_X:2,unknown:abc','x-sonos-http:a.mp4','x-rincon-playlist:RINCON_X#A:ALBUM/1'])
  assert.notEqual(platformFromUri(u),'AirPlay',u);
 assert.equal(platformFromUri('x-rincon-mp3radio://my.airplay.fm/stream'),'電台');
 assert.equal(platformFromUri('x-rincon-mp3radio://radio.example/a?sid=204'),'電台');
 assert.equal(platformFromUri('x-sonos-vli:RINCON_X:2,unknown:abc'),'');
 assert.equal(platformFromUri('x-sonos-http:a.mp4'),'');
 assert.equal(platformFromUri('file:///music/airplay.mp3'),'');
});
const track=(title='T',uri='x-sonos-http:song%3a1802208398.mp4?sid=204&flags=8232&sn=16')=>({
 soap:async(host,svc,action)=>action==='GetPositionInfo'?{TrackMetaData:`<DIDL-Lite xmlns:dc="dc" xmlns:upnp="upnp"><item><res protocolInfo="sonos.com-http:*:audio/mp4:*">${uri.replace(/&/g,'&amp;')}</res><upnp:albumArtURI>/getaa?s=1</upnp:albumArtURI><dc:title>${title}</dc:title></item></DIDL-Lite>`,TrackURI:uri,RelTime:'0:00:01',TrackDuration:'0:04:00'}:{CurrentTransportState:'PLAYING'}});
const mk=(over={})=>{const r=new SonosReader();r.groups=[{id:'G',host:'192.168.4.20',name:'書房'}];r.nextScan=Date.now()+1e9;Object.assign(r,over);return r;};
const BIGJ=Buffer.from('BIGJPEG'),ORIGJ=Buffer.from('ORIGJPEG');
const never=()=>new Promise(()=>{});
test('poll never waits for lookup or big image: black-hole network still returns fast with the original art URL',async()=>{
 const r=mk({...track(),get:async(u)=>{if(u.includes('/getaa'))return {body:ORIGJ,type:'image/jpeg'};return never();}});
 r.apple=new AppleArtLookup(()=>never());
 const t0=Date.now();await r.poll();const ms=Date.now()-t0;
 assert(ms<1000,'poll took '+ms);
 const t=r.track('G');assert.equal(t.service,'Apple Music');assert.equal(t.art,'/api/sonos-art/G?v=T');assert(!t.art.includes('h=1'));
 await r.poll();assert(!r.track('G').art.includes('h=1'));
 const img=await r.image('G',true);assert.equal(img.body.toString(),'ORIGJPEG');
});
test('late big image: next poll changes art URL, endpoint serves bytes from memory with no new outbound request',async()=>{
 let release,gate=new Promise(res=>release=res);const calls=[];
 const r=mk({...track(),get:async(u)=>{calls.push(u);if(u.includes('mzstatic'))return gate.then(()=>({body:BIGJ,type:'image/jpeg'}));return {body:ORIGJ,type:'image/jpeg'};}});
 r.apple=new AppleArtLookup(async()=>lookupBody(['https://is1-ssl.mzstatic.com/a/100x100bb.jpg']));
 await r.poll();const first=r.track('G').art;assert(!first.includes('h='));
 await new Promise(x=>setTimeout(x,30));await r.poll();assert.equal(r.track('G').art,first,'still original while download pending');
 release();await new Promise(x=>setTimeout(x,30));
 await r.poll();const second=r.track('G').art;assert.notEqual(second,first);assert(second.endsWith('&h=1'));
 const n=calls.length;const big=await r.image('G',true);assert.equal(big.body.toString(),'BIGJPEG');assert.equal(calls.length,n,'no outbound request at serve time');
 assert.equal((await r.image('G',false)).body.toString(),'ORIGJPEG');
 // song change drops the big bytes; a stale h=1 request falls back to the original
 r.soap=track('Next','x-sonos-http:song%3a999.mp4?sid=204&flags=1').soap;
 await r.poll();assert(!r.track('G').art.includes('h=1'));assert(!r.big.has('G')||r.big.get('G').key.startsWith('Next'));
 assert.equal((await r.image('G',true)).body.toString(),'ORIGJPEG');
});
test('big image failure keeps original and retries at most twice, 60s apart, one job at a time',async()=>{
 let now=1e12;const realNow=Date.now;Date.now=()=>now;let bigCalls=0;
 try{
  const r=mk({...track(),get:async(u)=>{if(u.includes('mzstatic')){bigCalls++;throw Error('slow');}return {body:ORIGJ,type:'image/jpeg'};}});
  r.nextScan=now+1e9;r.apple=new AppleArtLookup(async()=>lookupBody(['https://is1-ssl.mzstatic.com/a/100x100bb.jpg']),()=>now);
  const tick=async(ms)=>{now+=ms;await r.poll();await new Promise(x=>setTimeout(x,10));};
  await tick(0);assert.equal(bigCalls,1);
  await tick(1000);assert.equal(bigCalls,1);
  await tick(60000);assert.equal(bigCalls,2);
  await tick(61000);assert.equal(bigCalls,3);
  await tick(61000);await tick(61000);assert.equal(bigCalls,3);
  assert(!r.track('G').art.includes('h=1'));
 }finally{Date.now=realNow;}
});
// ---- P2：非 Apple Music 服務以歌名＋歌手精確比對搜尋 ----
const {pickSearchMatch}=require('./track-info');
const art=(n)=>`https://is1-ssl.mzstatic.com/image/thumb/Music/${n}/100x100bb.jpg`;
const big=(n)=>`https://is1-ssl.mzstatic.com/image/thumb/Music/${n}/1536x1536bb.jpg`;
const searchBody=(rs)=>({ok:true,status:200,body:(async function*(){yield Buffer.from(JSON.stringify({resultCount:rs.length,results:rs}));})()});
const R=(artistName,trackName,collectionName,n)=>({artistName,trackName,collectionName,artworkUrl100:art(n)});
const TOMOO=[R('TOMOO','ソナーレ','ソナーレ - Single','right'),R('西脇睦宏','ソナーレ (オルゴール)','オルゴール','w1'),R('Various','ソナーレ','Cover','v1'),R('Someone','ソナーレ','X','s1'),R('Other','ソナーレ - Single','Y','o1')];
test('search: TOMOO fixture picks the first (correct) result and yields a 1536 URL',async()=>{
 const calls=[];const L=new AppleArtLookup(async(u)=>{calls.push(u);return searchBody(TOMOO);});
 assert.equal(await L.bigArtBySearch('TOMOO','ソナーレ','ソナーレ'),big('right'));
 assert.equal(calls.length,1);
 assert(calls[0].startsWith('https://itunes.apple.com/search?term='+encodeURIComponent('TOMOO ソナーレ')+'&entity=song&limit=5&country=tw'));
 assert(!calls[0].includes(encodeURIComponent('ソナーレ ソナーレ')),'album must not be sent');
});
test('search: wrong-album counterexample (only 西脇睦宏 オルゴール版 etc.) is never adopted',async()=>{
 const wrong=[R('西脇睦宏','ソナーレ (オルゴール)','オルゴール','w1'),R('西脇睦宏','ソナーレ','オルゴール2','w2'),R('Orgel Cover','ソナーレ','C','w3'),R('TOMOO feat. X','ソナーレ','D','w4'),R('TOMOO','ソナーレ2','E','w5')];
 assert.equal(pickSearchMatch(wrong,'TOMOO','ソナーレ',''),null);
 const L=new AppleArtLookup(async()=>searchBody(wrong));
 assert.equal(await L.bigArtBySearch('TOMOO','ソナーレ',''),'');
 // 歌名只被包含也不行
 assert.equal(pickSearchMatch([R('TOMOO','ソナーレ ～Piano～ 完全版','A','p')],'TOMOO','ソナーレ',''),null);
});
test('search: feat. titles match same string and stripped form; different artist still rejected',()=>{
 const rs=[R('李玖哲','遊蕩的人 (feat. 李玖哲)','A','f1')];
 assert.equal(pickSearchMatch(rs,'李玖哲','遊蕩的人 (feat. 李玖哲)','')?.artworkUrl100,art('f1'));
 assert.equal(pickSearchMatch(rs,'李玖哲','遊蕩的人','')?.artworkUrl100,art('f1'));
 assert.equal(pickSearchMatch([R('李玖哲','遊蕩的人','A','f2')],'李玖哲','遊蕩的人 (feat. 李玖哲)','')?.artworkUrl100,art('f2'));
 assert.equal(pickSearchMatch([R('李玖哲','遊蕩的人 - Single','A','f3')],'李玖哲','遊蕩的人','')?.artworkUrl100,art('f3'));
 assert.equal(pickSearchMatch(rs,'別人','遊蕩的人 (feat. 李玖哲)',''),null);
 assert.equal(pickSearchMatch(rs,'李玖哲','別首 (feat. 李玖哲)',''),null);
});
test('search: normalization (NFKC, case, spaces, punctuation) and preference order',()=>{
 assert.equal(pickSearchMatch([R('ＴＯＭＯＯ','Sonare!','A','n1')],'tomoo','SONARE','')?.artworkUrl100,art('n1'));
 // 全文相等優先於去尾綴相等；同級時專輯相等優先
 const rs=[R('A','Song (Live)','Live','l'),R('A','Song','Studio','s'),R('A','Song','Wanted','w')];
 assert.equal(pickSearchMatch(rs,'A','Song','Wanted')?.artworkUrl100,art('w'));
 assert.equal(pickSearchMatch(rs,'A','Song','')?.artworkUrl100,art('s'));
 assert.equal(pickSearchMatch([R('A','(Live)','x','z')],'A','(Live)','')?.artworkUrl100,art('z'));
 assert.equal(pickSearchMatch([],'A','B',''),null);assert.equal(pickSearchMatch(undefined,'A','B',''),null);
});
test('search: empty artist/title makes no request; query is truncated to 200 chars',async()=>{
 const calls=[];const L=new AppleArtLookup(async(u)=>{calls.push(u);return searchBody([]);});
 for(const [a,t] of [['','T'],['A',''],['  ','T'],['A','  '],[undefined,'T'],['A',null]])assert.equal(await L.bigArtBySearch(a,t),'');
 assert.equal(calls.length,0);
 await L.bigArtBySearch('A'.repeat(150),'B'.repeat(150));
 assert.equal(decodeURIComponent(calls[0].match(/term=([^&]*)/)[1]).length,200);
});
test('search: failures cached 10 min, success forever, size cap and HTTP errors fall through',async()=>{
 let t=0,n=0,ok=false;const L=new AppleArtLookup(async()=>{n++;return ok?searchBody([R('A','B','C','k')]):{ok:false,status:500};},()=>t);
 assert.equal(await L.bigArtBySearch('A','B'),'');assert.equal(n,3);
 t=9*60*1000;assert.equal(await L.bigArtBySearch('A','B'),'');assert.equal(n,3);
 ok=true;t=10*60*1000+1;assert.equal(await L.bigArtBySearch('A','B'),big('k'));assert.equal(n,4);
 assert.equal(await L.bigArtBySearch('A','B'),big('k'));assert.equal(n,4);
 const huge=new AppleArtLookup(async()=>({ok:true,status:200,body:(async function*(){yield Buffer.alloc(300*1024);})()}));assert.equal(await huge.bigArtBySearch('A','B'),'');
 // 非 mzstatic 圖網址不採用
 const evil=new AppleArtLookup(async()=>searchBody([{artistName:'A',trackName:'B',artworkUrl100:'https://evil.example/100x100bb.jpg'}]));assert.equal(await evil.bigArtBySearch('A','B'),'');
});
const AMZ='x-sonosapi-hls-static:catalog%3atrack%3aasin%3aB0G6Y98JMZ?sid=201';
const trackMeta=(title,artist,uri,album='ALB')=>({
 soap:async(host,svc,action)=>action==='GetPositionInfo'?{TrackMetaData:`<DIDL-Lite xmlns:dc="dc" xmlns:upnp="upnp"><item><res protocolInfo="x:*:audio/mp4:*">${uri.replace(/&/g,'&amp;')}</res><upnp:albumArtURI>/getaa?s=1</upnp:albumArtURI><dc:title>${title}</dc:title><dc:creator>${artist}</dc:creator><upnp:album>${album}</upnp:album></item></DIDL-Lite>`,TrackURI:uri,RelTime:'0:00:01',TrackDuration:'0:04:00'}:{CurrentTransportState:'PLAYING'}});
const sleep=ms=>new Promise(x=>setTimeout(x,ms));
test('reader: Amazon track gets big art via search in background; later poll shows h=1',async()=>{
 const r=mk({...trackMeta('ソナーレ','TOMOO',AMZ),get:async(u)=>u.includes('mzstatic')?{body:BIGJ,type:'image/jpeg'}:{body:ORIGJ,type:'image/jpeg'}});
 const urls=[];r.apple=new AppleArtLookup(async(u)=>{urls.push(u);return searchBody(TOMOO);});
 await r.poll();assert.equal(r.track('G').service,'Amazon Music');await sleep(30);await r.poll();
 assert(r.track('G').art.endsWith('&h=1'));assert.equal((await r.image('G',true)).body.toString(),'BIGJPEG');
 assert.equal(urls.length,1);assert(urls[0].includes('/search?'));
});
test('reader: Apple id lookup miss falls back to search; radio and missing artist never search',async()=>{
 const urls=[];const mkR=(title,artist,uri)=>{const r=mk({...trackMeta(title,artist,uri),get:async(u)=>u.includes('mzstatic')?{body:BIGJ,type:'image/jpeg'}:{body:ORIGJ,type:'image/jpeg'}});r.apple=new AppleArtLookup(async(u)=>{urls.push(u);return u.includes('/lookup')?lookupBody([]):searchBody(TOMOO);});return r;};
 const a=mkR('ソナーレ','TOMOO','x-sonos-http:song%3a1802208398.mp4?sid=204&flags=8232&sn=16');await a.poll();await sleep(30);await a.poll();
 assert(a.track('G').art.endsWith('&h=1'));assert(urls.some(u=>u.includes('/lookup'))&&urls.some(u=>u.includes('/search')));
 urls.length=0;
 const radio=mkR('ソナーレ','TOMOO','x-sonosapi-stream:s1234?sid=254&flags=32');await radio.poll();await sleep(30);assert.equal(radio.track('G').service,'電台');
 const noArtist=mkR('ソナーレ','',AMZ);await noArtist.poll();await sleep(30);
 assert.equal(urls.length,0);
});
test('reader: search black hole - poll returns within 1s with original art URL',async()=>{
 const r=mk({...trackMeta('ソナーレ','TOMOO',AMZ),get:async()=>({body:ORIGJ,type:'image/jpeg'})});
 r.apple=new AppleArtLookup(()=>never());
 const t0=Date.now();await r.poll();assert(Date.now()-t0<1000);await r.poll();
 assert.equal(r.track('G').art,'/api/sonos-art/G?v=%E3%82%BD%E3%83%8A%E3%83%BC%E3%83%AC');
 assert.equal((await r.image('G',true)).body.toString(),'ORIGJPEG');
});
test('reader: one search per song — 30 song changes then 10 polls of the same song count correctly',async()=>{
 let n=0;const r=mk({get:async()=>({body:ORIGJ,type:'image/jpeg'})});
 r.apple=new AppleArtLookup(async()=>{n++;return searchBody([]);});
 for(let i=0;i<30;i++){r.soap=trackMeta('Song'+i,'Art',AMZ).soap;await r.poll();await sleep(5);}
 assert.equal(n,30*3,'3 countries per song, once');
 const before=n;for(let i=0;i<10;i++){await r.poll();await sleep(2);}
 assert.equal(n,before);
 // 回到第 0 首：失敗快取 10 分鐘內不重查
 r.soap=trackMeta('Song0','Art',AMZ).soap;await r.poll();await sleep(10);assert.equal(n,before);
});
// ---- P2 FIX1 ----
test('FIX1 MED-1: version tails are never treated as the same song (both directions)',()=>{
 const one=(playing,found)=>pickSearchMatch([R('A',found,'X','z')],'A',playing,'');
 for(const v of ['Song (Live)','Song - Remix','Song (Instrumental)','Song (Acoustic)','Song (Karaoke Version)','Song - Live at Budokan','Song (Demo)','Song (Ver. 2)','Song (Part 1)','ソナーレ (ライブ)'])
  assert.equal(one('Song',v),null,'Song vs '+v);
 assert.equal(one('Song (Live)','Song'),null);
 assert.equal(one('Song (Remix)','Song (Instrumental)'),null);
 assert.equal(one('Song (Part 1)','Song (Part 2)'),null);
 assert.equal(one('ソナーレ','ソナーレ (オルゴール)'),null);
 assert.equal(one('ソナーレ (オルゴール)','ソナーレ'),null);
 // 允許的尾綴
 for(const [p,f] of [['Song','Song - Single'],['Song','Song - EP'],['Song','Song (feat. B)'],['Song (feat. B)','Song'],['Song','Song (2011 Remastered)'],['Song - Remastered 2011','Song']])
  assert.equal(one(p,f)?.artworkUrl100,art('z'),p+' vs '+f);
});
test('FIX1 MED-2: search cache key includes album so a Live-album hit is not reused for the studio album',async()=>{
 const rs=[R('A','Song','Live Album','l'),R('A','Song','Studio Album','s')];let n=0;
 const L=new AppleArtLookup(async()=>{n++;return searchBody(rs);});
 assert.equal(await L.bigArtBySearch('A','Song','Live Album'),big('l'));
 assert.equal(await L.bigArtBySearch('A','Song','Studio Album'),big('s'));
 assert.equal(n,2);assert.equal(await L.bigArtBySearch('A','Song','Studio Album'),big('s'));assert.equal(n,2);
});
test('FIX1 LOW-1: term truncation is surrogate-safe and lone surrogates do not throw',async()=>{
 const calls=[];const L=new AppleArtLookup(async(u)=>{calls.push(u);return searchBody([]);});
 await L.bigArtBySearch('A','😀'.repeat(250));
 const term=decodeURIComponent(calls[0].match(/term=([^&]*)/)[1]);assert.equal(Array.from(term).length,200);assert(term.isWellFormed());
 const before=calls.length;await L.bigArtBySearch('A','bad\uD800title');assert.equal(calls.length,before+3);
});
test('FIX1 LOW-4: appleBigArt rejects ports and userinfo',()=>{
 for(const u of ['https://user:p@is1-ssl.mzstatic.com/a/100x100bb.jpg','https://is1-ssl.mzstatic.com:8443/a/100x100bb.jpg','https://u@is1-ssl.mzstatic.com/a/100x100bb.jpg'])assert.equal(appleBigArt(u),'');
 assert.equal(appleBigArt('https://is1-ssl.mzstatic.com:443/a/100x100bb.jpg'),'https://is1-ssl.mzstatic.com/a/1536x1536bb.jpg');
});
