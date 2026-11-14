import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

function Chunk({start, count, estimate, render, reveal}: {start:number;count:number;estimate:number;reveal?:boolean;render:(index:number)=>ReactNode}) {
  const ref=useRef<HTMLDivElement>(null), height=useRef(count*estimate)
  const [visible,setVisible]=useState(start===0 || !!reveal)
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>{
      if(entry.isIntersecting)setVisible(true)
      else if(!ref.current?.contains(document.activeElement))setVisible(false)
    },{rootMargin:'600px'})
    observer.observe(ref.current!);return()=>observer.disconnect()
  },[])
  useLayoutEffect(()=>{ if(reveal)setVisible(true) },[reveal])
  useLayoutEffect(()=>{
    if(!visible)return
    const element=ref.current!
    if(document.activeElement===element)element.querySelector<HTMLElement>('button,input,a,select')?.focus()
    const observer=new ResizeObserver(()=>{height.current=element.getBoundingClientRect().height})
    observer.observe(element);return()=>observer.disconnect()
  },[visible])
  return <div ref={ref} style={visible?{display:'grid',gap:'inherit'}:{height:height.current}} tabIndex={visible?undefined:0} aria-label={visible?undefined:`Show entries ${start+1} to ${start+count}`} onFocus={()=>setVisible(true)}>{visible?Array.from({length:count},(_,i)=>render(start+i)):null}</div>
}
// Native intersection/resize observers keep variable-height rows and normal page
// scrolling. Focused chunks stay mounted; keyboard focus can reveal the next chunk.
export function WindowedList({count,estimate,render,revealIndex}:{count:number;estimate:number;revealIndex?:number;render:(index:number)=>ReactNode}) {
  if(count<=100)return <>{Array.from({length:count},(_,i)=>render(i))}</>
  return <>{Array.from({length:Math.ceil(count/40)},(_,i)=><Chunk key={i} reveal={revealIndex !== undefined && revealIndex >= i*40 && revealIndex < (i+1)*40} start={i*40} count={Math.min(40,count-i*40)} estimate={estimate} render={render}/>)}</>
}
