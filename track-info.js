'use strict';
// 平台、音質與封面網址判斷。對照表來源：2026-10-03 對家裡 Sonos（192.168.4.20）
// MusicServices/ListAvailableServices 唯讀實查（喇叭自己回的 sid→名稱）。查不到的 sid 一律回空字串，不猜。
const SID = {
  204: 'Apple Music', 9: 'Spotify', 12: 'Spotify', 284: 'YouTube Music', 174: 'Tidal', 31: 'Qobuz',
  227: 'KKBOX', 201: 'Amazon Music', 2: 'Deezer', 160: 'SoundCloud', 157: 'Bandcamp', 212: 'Plex',
  254: '電台', 333: '電台', 303: '電台', 271: 'IDAGIO', 222: 'nugs',
};
function platformFromUri(uri) {
  if (typeof uri !== 'string' || !uri) return '';
  const u = uri.trim();
  const low = u.toLowerCase();
  // 每一項都錨定在 URI 開頭的協定；拿不準的不標。
  if (/^x-sonos-vli:/.test(low)) {
    if (/^x-sonos-vli:[^,]*,airplay:/.test(low)) return 'AirPlay';
    if (/^x-sonos-vli:[^,]*,spotify:/.test(low)) return 'Spotify';
    return '';
  }
  if (/^x-rincon-stream:/.test(low)) return 'Line-In';
  if (/^x-sonos-htastream:/.test(low)) return '電視';
  if (/^(x-file-cmp:|x-smb:)/.test(low)) return '音樂庫';
  if (/^(x-sonos-http|x-sonosapi-[a-z-]+|x-sonos-spotify):/.test(low)) {
    const sid = u.match(/[?&]sid=(\d+)(?:&|$)/i);
    if (sid) return SID[Number(sid[1])] || '';
    if (/^x-sonos-spotify:/.test(low)) return 'Spotify';
    if (/^x-sonosapi-(stream|radio):/.test(low)) return '電台';
    return '';
  }
  if (/^(x-rincon-mp3radio:|aac:|hls-radio:)/.test(low)) return '電台';
  return '';
}
// 音質：只收喇叭 res 屬性與 protocolInfo 真的有的值。res@bitrate 單位在 UPnP 規格是 bytes/s、
// Sonos 實作未證實，故不顯示；取不到的欄位整段略過。
const MIME = {'audio/flac': ['FLAC', true], 'audio/x-flac': ['FLAC', true], 'audio/mpeg': ['MP3', false], 'audio/mp3': ['MP3', false],
  'audio/aac': ['AAC', false], 'audio/x-aac': ['AAC', false], 'audio/x-ogg': ['Ogg Vorbis', false], 'audio/ogg': ['Ogg Vorbis', false],
  'audio/x-wav': ['WAV', true], 'audio/wav': ['WAV', true], 'audio/x-alac': ['ALAC', true]};
function qualityFromRes(res) {
  const r = (Array.isArray(res) ? res[0] : res) || {};
  if (typeof r !== 'object') return '';
  const mime = String(r.protocolInfo || '').split(':')[2] || '';
  const codec = MIME[mime.toLowerCase()];
  const bits = /^\d{1,2}$/.test(String(r.bitsPerSample || '')) ? Number(r.bitsPerSample) : 0;
  const hzRaw = /^\d{4,6}$/.test(String(r.sampleFrequency || '')) ? Number(r.sampleFrequency) : 0;
  const khz = hzRaw ? String(Math.round(hzRaw / 100) / 10).replace(/\.0$/, '') + ' kHz' : '';
  const spec = [bits ? bits + '-bit' : '', khz].filter(Boolean).join('／');
  return [codec ? codec[0] : '', spec].filter(Boolean).join(' ');
}
// 封面放大：只在既有白名單網域內改尺寸參數。回傳候選網址清單（大圖在前，原圖最後）。
const BIG = 1536;
function artCandidates(href) {
  let u; try { u = new URL(href); } catch { return [href]; }
  const out = [];
  if (u.protocol === 'https:') {
    const h = u.hostname;
    if (h === 'mzstatic.com' || h.endsWith('.mzstatic.com')) {
      const big = u.pathname.replace(/\/\d+x\d+([a-z]{0,2})(-\d+)?\.(jpg|png|webp)$/i, (m, k, q, ext) => `/${BIG}x${BIG}${k || 'bb'}.${ext}`);
      if (big !== u.pathname) { const n = new URL(u); n.pathname = big; out.push(n.href); }
    } else if (h === 'i.scdn.co') {
      const big = u.pathname.replace(/\/image\/ab67616d0000(?:1e02|4851)/, '/image/ab67616d0000b273');
      if (big !== u.pathname) { const n = new URL(u); n.pathname = big; out.push(n.href); }
    } else if (h === 'resources.tidal.com') {
      const big = u.pathname.replace(/\/\d+x\d+\.(jpg|png|webp)$/i, '/1280x1280.$1');
      if (big !== u.pathname) { const n = new URL(u); n.pathname = big; out.push(n.href); }
    } else if (h === 'static.qobuz.com') {
      const big = u.pathname.replace(/_(\d+|small|medium|large)\.(jpg|png|webp)$/i, '_max.$2');
      if (big !== u.pathname) { const n = new URL(u); n.pathname = big; out.push(n.href); }
    }
  }
  out.push(u.href);
  return out;
}

// Apple Music 封面：Sonos 只給 400px 的 /getaa 代理，改用 Apple 公開查詢（唯一允許的外部查詢）取 mzstatic 大圖。
function appleSongId(uri) {
  if (typeof uri !== 'string' || !/[?&]sid=204(&|$)/.test(uri)) return '';
  const m = uri.match(/^x-sonos-http:song(?:%3a|:)(\d{1,20})\.[a-z0-9]+(?:\?|$)/i);
  return m ? m[1] : '';
}
const COUNTRIES = ['tw', 'us', 'jp'];
const RETRY_MS = 10 * 60 * 1000;
function appleBigArt(artworkUrl) {
  if (typeof artworkUrl !== 'string') return '';
  try {
    const u = new URL(artworkUrl);
    if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || !(u.hostname === 'mzstatic.com' || u.hostname.endsWith('.mzstatic.com'))) return '';
    const big = u.pathname.replace(/\/\d+x\d+([a-z]{0,2})(-\d+)?\.(jpg|png|webp)$/i, (m, k, q, ext) => `/${BIG}x${BIG}${k || 'bb'}.${ext}`);
    if (big === u.pathname) return '';
    u.pathname = big;
    return u.href;
  } catch { return ''; }
}
// 搜尋比對用的正規化：NFKC、小寫、去空白與標點符號。寧缺勿錯，所以只做相等比較。
const squash = v => String(v ?? '').normalize('NFKC').toLowerCase().replace(/[\p{Z}\p{P}\p{S}\p{C}]+/gu, '');
// 去尾端括號段與「 - Single」這類尾綴；回傳 {base: 正規化後的主體, removed: 被去掉的尾綴原文}。去完變空就不去。
function stripTail(v) {
  let s = String(v ?? '').normalize('NFKC').toLowerCase().trim(), prev, removed = '';
  do {
    prev = s;
    const n = s.replace(/\s*[(\[{][^()\[\]{}]*[)\]}]\s*$/u, '').replace(/\s+[-–—]\s+[^-–—]*$/u, '').trim();
    if (!n) break;
    removed += ' ' + s.slice(n.length);
    s = n;
  } while (s !== prev);
  return {base: squash(s), removed};
}
// 被去掉的尾綴若是版本標記（現場、混音、純音樂…），代表是另一個版本，不能當同一首。
const VERSION_TAIL = /live|remix|\bmix\b|instrumental|\binst\b|acoustic|karaoke|demo|\bver\b|\bver\.|version|part\s*\d|オルゴール|ライブ|インスト|カラオケ|リミックス/iu;
// 從搜尋結果挑出可信的一筆：歌手正規化後相等，且歌名全文相等（優先），或去尾綴後主體相等且兩邊尾綴都不是版本標記。
// 多筆通過時專輯名相等者優先，否則取第一筆。沒有就回 null。
function pickSearchMatch(results, artist, title, album) {
  const a = squash(artist), t = squash(title), ts = stripTail(title), al = squash(album);
  if (!a || !t || !Array.isArray(results)) return null;
  const ok = [];
  for (const r of results) {
    if (!r || typeof r.trackName !== 'string' || typeof r.artistName !== 'string') continue;
    if (squash(r.artistName) !== a) continue;
    const rt = squash(r.trackName), rs = stripTail(r.trackName);
    let rank = -1;
    if (rt === t) rank = 0;
    else if (ts.base && ts.base === rs.base && !VERSION_TAIL.test(ts.removed) && !VERSION_TAIL.test(rs.removed)) rank = 1;
    if (rank >= 0) ok.push({r, rank});
  }
  if (!ok.length) return null;
  const best = Math.min(...ok.map(x => x.rank));
  const top = ok.filter(x => x.rank === best).map(x => x.r);
  return (al && top.find(r => squash(r.collectionName) === al)) || top[0];
}
class AppleArtLookup {
  constructor(fetchImpl = (...a) => fetch(...a), now = () => Date.now()) { this.fetch = fetchImpl; this.now = now; this.cache = new Map(); }
  async query(id, country) {
    if (!/^\d{1,20}$/.test(id) || !COUNTRIES.includes(country)) throw Error('bad lookup');
    const r = await this.fetch(`https://itunes.apple.com/lookup?id=${id}&country=${country}`, {redirect: 'error', signal: AbortSignal.timeout(5000)});
    if (!r.ok) throw Error('lookup HTTP ' + r.status);
    const chunks = []; let size = 0;
    for await (const b of r.body) { size += b.length; if (size > 256 * 1024) throw Error('lookup too large'); chunks.push(Buffer.from(b)); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return data?.resultCount > 0 ? appleBigArt(data.results?.[0]?.artworkUrl100) : '';
  }
  async search(artist, title, album, country) {
    if (!COUNTRIES.includes(country)) throw Error('bad search');
    const term = Array.from(`${artist} ${title}`.toWellFormed()).slice(0, 200).join('');
    const r = await this.fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=5&country=${country}`, {redirect: 'error', signal: AbortSignal.timeout(5000)});
    if (!r.ok) throw Error('search HTTP ' + r.status);
    const chunks = []; let size = 0;
    for await (const b of r.body) { size += b.length; if (size > 256 * 1024) throw Error('search too large'); chunks.push(Buffer.from(b)); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const m = pickSearchMatch(data?.results, artist, title, album);
    return m ? appleBigArt(m.artworkUrl100) : '';
  }
  // 用歌名＋歌手搜尋取大圖（非 Apple Music 來源）。artist／title 空就不查；結果快取規則同 bigArt。
  async bigArtBySearch(artist, title, album = '') {
    if (typeof artist !== 'string' || typeof title !== 'string' || !artist.trim() || !title.trim()) return '';
    const key = 's|' + squash(artist) + '|' + squash(title) + '|' + squash(album);
    const hit = this.cache.get(key);
    if (hit && (hit.url || this.now() - hit.at < RETRY_MS)) return hit.url;
    let url = '';
    for (const c of COUNTRIES) {
      try { url = await this.search(artist, title, album, c); } catch { url = ''; }
      if (url) break;
    }
    this.cache.set(key, {url, at: this.now()});
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return url;
  }
  // 回傳大圖網址或 ''；成功永久快取，失敗 10 分鐘內不重打。
  async bigArt(id) {
    if (!/^\d{1,20}$/.test(id || '')) return '';
    const hit = this.cache.get(id);
    if (hit && (hit.url || this.now() - hit.at < RETRY_MS)) return hit.url;
    let url = '';
    for (const c of COUNTRIES) {
      try { url = await this.query(id, c); } catch { url = ''; }
      if (url) break;
    }
    this.cache.set(id, {url, at: this.now()});
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return url;
  }
}
module.exports = {platformFromUri, qualityFromRes, artCandidates, SID, appleSongId, appleBigArt, AppleArtLookup, pickSearchMatch};
