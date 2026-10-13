'use strict';
function chooseSource(source,sonos,roon){if(source==='sonos')return sonos;if(source==='roon')return roon;return [sonos,roon].find(t=>t?.playing)||sonos||roon||null;}
function setupPhase(net,configured,demo=false){if(!demo&&!net.connected)return 'wifi';return configured?'ready':'source';}
module.exports={chooseSource,setupPhase};
