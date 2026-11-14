// Opt-in development measurements only. No saved user data is changed.
import { Profiler, type ReactNode } from 'react'
export const profiling = import.meta.env.DEV && new URLSearchParams(location.search).has('profile')
const commits: {id:string; ms:number}[] = [], frames:number[] = [], events: {name:string;ms:number}[] = []
let last = 0
if (profiling) {
 const frame=(at:number)=>{if(last && document.visibilityState==='visible')frames.push(at-last);last=at;if(frames.length>10000)frames.shift();requestAnimationFrame(frame)};requestAnimationFrame(frame)
 try {new PerformanceObserver(list=>{for(const e of list.getEntries())events.push({name:e.name,ms:e.duration})}).observe({type:'event',durationThreshold:16} as PerformanceObserverInit)} catch { /* Older browsers do not expose Event Timing. */ }
 window.addEventListener('load',()=>{
  const panel=document.createElement('details');panel.style.cssText='position:fixed;bottom:0;right:0;z-index:99999;background:white;color:black;max-height:40vh;overflow:auto;max-width:600px';panel.innerHTML='<summary>Performance measurements</summary><button id="profile-capture">Capture measurements</button><button id="profile-reset">Reset measurements</button><pre id="profile-results"></pre>';document.body.append(panel)
  document.getElementById('profile-reset')!.onclick=()=>{commits.length=0;frames.length=0;events.length=0;last=0}
  document.getElementById('profile-capture')!.onclick=()=>{document.getElementById('profile-results')!.textContent=JSON.stringify({commits,frames,events,navigation:performance.getEntriesByType('navigation').map(e=>e.toJSON()),memory:(()=>{const m=(performance as Performance & {memory?:{usedJSHeapSize:number;totalJSHeapSize:number;jsHeapSizeLimit:number}}).memory;return m?{used:m.usedJSHeapSize,total:m.totalJSHeapSize,limit:m.jsHeapSizeLimit}:undefined})()},null,2)}
 })
}
export function Profile({id,children}:{id:string;children:ReactNode}) {return profiling?<Profiler id={id} onRender={(id,_phase,ms)=>{commits.push({id,ms});if(commits.length>10000)commits.shift()}}>{children}</Profiler>:children}
