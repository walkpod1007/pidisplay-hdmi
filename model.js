'use strict';
const crypto = require('node:crypto');
function wifiQR(ssid, password) {
  const escape = s => s.replace(/[\\;,:\"]/g, '\\$&');
  return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;`;
}
function selectRoonTrack(zones, zoneId) {
  const zone = zoneId ? zones[zoneId] : Object.values(zones).find(z => z.state === 'playing') || Object.values(zones)[0];
  const np = zone?.now_playing;
  const roon = np ? {source:'Roon', title:np.three_line?.line1 || np.one_line?.line1 || '', artist:np.three_line?.line2 || '', album:np.three_line?.line3 || '', playing:zone.state === 'playing', progress:(np.seek_position || 0)*1000, duration:(np.length || 0)*1000, art:np.image_key ? `/api/roon-art/${encodeURIComponent(np.image_key)}` : '', zone:zone.display_name, service:'', quality:''} : null;
  return roon;
}
function applyZones(zones, cmd, data) {
  if (cmd === 'Subscribed') Object.keys(zones).forEach(k => delete zones[k]);
  for (const z of [...(data?.zones || []), ...(data?.zones_added || []), ...(data?.zones_changed || [])]) zones[z.zone_id] = z;
  for (const id of data?.zones_removed || []) delete zones[id];
  for (const z of data?.zones_seek_changed || []) if (zones[z.zone_id]?.now_playing) zones[z.zone_id].now_playing.seek_position = z.seek_position;
}
function secureEqual(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa,bb);
}
module.exports = {wifiQR, selectRoonTrack, applyZones, secureEqual};
