const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createNetworkMonitor}=require('./network-monitor');
test('saved Wi-Fi gets a grace period; a later outage restores the AP',async()=>{
 let time=0,state={available:true,connected:false,hotspot:false},starts=0;
 const m=createNetworkMonitor(async action=>{if(action==='hotspot'){starts++;state={available:true,connected:false,hotspot:true};}return state;},()=> 'password',{now:()=>time});
 await m.poll();time=59000;await m.poll();assert.equal(starts,0);
 state={available:true,connected:true};time=60000;await m.poll();assert.equal(starts,0);
 state={available:true,connected:false};time=70000;await m.poll();time=130000;
 assert.equal((await m.poll()).hotspot,true);assert.equal(starts,1);
 time=200000;await m.poll();assert.equal(starts,1);
});
test('manual switching postpones recovery and failed AP retries are bounded',async()=>{
 let time=0,starts=0;const m=createNetworkMonitor(async action=>{if(action==='hotspot'){starts++;throw Error('failed');}return {available:true,connected:false};},()=> 'password',{now:()=>time});
 await m.poll();time=60000;await m.poll(true);assert.equal(starts,0);
 time=70000;await m.poll();time=130000;assert.match((await m.poll()).message,/重試/);assert.equal(starts,1);
 time=145000;await m.poll();assert.equal(starts,1);time=190000;await m.poll();assert.equal(starts,2);
});
test('overlapping status polls share one network request',async()=>{
 let finish,calls=0;const m=createNetworkMonitor(()=>{calls++;return new Promise(r=>finish=r);},()=> 'password');
 const a=m.poll(),b=m.poll();finish({available:true,connected:true});
 await Promise.all([a,b]);assert.equal(calls,1);
});
