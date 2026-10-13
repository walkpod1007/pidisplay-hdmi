"use strict";
// Allow NetworkManager to reconnect saved Wi-Fi before offering the setup AP.
function createNetworkMonitor(network, password, {now=Date.now, graceMs=60000, retryMs=60000}={}) {
  let offlineSince=null, lastAttempt=-Infinity, pending=null;
  async function check(connecting) {
    let state;
    try { state=await network('status'); }
    catch { return {available:false,message:'網路工具尚未就緒'}; }
    if((typeof connecting==='function'?connecting():connecting) || state.connected || state.hotspot || !state.available) {
      offlineSince=null;
      return state;
    }
    const time=now();
    if(offlineSince===null)offlineSince=time;
    if(time-offlineSince<graceMs || time-lastAttempt<retryMs)return state;
    lastAttempt=time;
    try {
      await network('hotspot',{hotspotPassword:password()});
      state=await network('status');
      if(state.connected || state.hotspot)offlineSince=null;
    } catch { state={...state,message:'設定熱點未能啟動，將自動重試'}; }
    return state;
  }
  return {poll(connecting=false) {
    if(!pending)pending=check(connecting).finally(()=>{pending=null;});
    return pending;
  }};
}
module.exports={createNetworkMonitor};
