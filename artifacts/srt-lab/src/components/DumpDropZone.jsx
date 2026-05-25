import React, {useState, useCallback, useRef} from "react";
import {C} from '../lib/constants.js';

/**
 * Shared drag-and-drop primitives for module .bin dumps.
 *
 * - `useDumpDrop({onFile})` — hook returning `{hover, handlers}`. Spread
 *   `handlers` onto any element to make it accept a dropped file. Filters
 *   on the `Files` dataTransfer type so text/selection drags are ignored.
 *   Uses an enter/leave depth counter to avoid the child-element
 *   dragleave flicker that breaks naive implementations.
 * - `DumpDropZone` — the picker label-button (click to browse). Built on
 *   the same hook so the button itself is also a valid drop target.
 * - `DumpDropArea` — wraps arbitrary children (typically the inspector
 *   `<Card>` body) so the *entire card* is droppable, not just the
 *   button. Renders a soft highlight overlay while the user is dragging
 *   a file over it.
 */

function hasFiles(ev){
  const t=ev.dataTransfer&&ev.dataTransfer.types;
  if(!t)return false;
  for(let i=0;i<t.length;i++)if(t[i]==='Files')return true;
  return false;
}

export function useDumpDrop({onFile}){
  const[hover,setHover]=useState(false);
  const depth=useRef(0);
  // All four handlers stopPropagation. This matters when an inner
  // DumpDropZone (the picker button) sits inside an outer DumpDropArea
  // (the whole inspector card): without stopPropagation, the outer
  // area would (a) double-fire onFile on drop and (b) accumulate
  // depth-counter increments from inner enter/leave events without a
  // matching outer leave when the drop is consumed by the inner — which
  // would leave the overlay hint stuck on after the drop. Each layer
  // is fully self-contained.
  const onDragEnter=useCallback(ev=>{
    if(!hasFiles(ev))return;
    ev.preventDefault();
    ev.stopPropagation();
    depth.current++;
    setHover(true);
  },[]);
  const onDragOver=useCallback(ev=>{
    if(!hasFiles(ev))return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect='copy';
  },[]);
  const onDragLeave=useCallback(ev=>{
    if(!hasFiles(ev))return;
    ev.preventDefault();
    ev.stopPropagation();
    depth.current=Math.max(0,depth.current-1);
    if(depth.current===0)setHover(false);
  },[]);
  const onDrop=useCallback(ev=>{
    if(!hasFiles(ev))return;
    ev.preventDefault();
    ev.stopPropagation();
    depth.current=0;
    setHover(false);
    const f=ev.dataTransfer.files&&ev.dataTransfer.files[0];
    if(f)onFile(f);
  },[onFile]);
  return {hover, handlers:{onDragEnter,onDragOver,onDragLeave,onDrop}};
}

export default function DumpDropZone({onFile, accent=C.wn, label='📂 Load .bin', accept='.bin,.BIN'}){
  const {hover, handlers}=useDumpDrop({onFile});
  return <label
    {...handlers}
    style={{
      padding:'10px 16px',
      borderRadius:10,
      border:'2px dashed '+accent+(hover?'':'40'),
      background:hover?accent+'18':C.c2,
      cursor:'pointer',
      fontSize:12,
      fontWeight:800,
      color:accent,
      transition:'background 0.15s, border-color 0.15s',
      outline:hover?'2px solid '+accent+'80':'none',
      outlineOffset:hover?2:0,
    }}>
    {hover?'⬇ Drop .bin to load':label}
    <input type="file" accept={accept} hidden onChange={e=>e.target.files[0]&&onFile(e.target.files[0])}/>
  </label>;
}

/**
 * Wrap an inspector card (or any container) to make the whole region a
 * drop target. The wrapper is a positioned div; while a file is being
 * dragged over it, a soft accent-tinted overlay fades in with a "drop"
 * hint so it's obvious the entire card will accept the file. The
 * children (button, status text, IdentityCard) keep working normally;
 * the overlay sits above them with `pointerEvents:'none'` so it doesn't
 * swallow drag events from nested elements.
 */
export function DumpDropArea({onFile, accent=C.wn, children, hint='⬇ Drop .bin anywhere on this card', style}){
  const {hover, handlers}=useDumpDrop({onFile});
  return <div
    {...handlers}
    data-dumpdrop-hover={hover?'1':'0'}
    style={{position:'relative',borderRadius:10,...(style||{})}}>
    {children}
    {hover&&<div style={{
      position:'absolute',
      inset:0,
      borderRadius:10,
      border:'3px dashed '+accent,
      background:accent+'18',
      pointerEvents:'none',
      display:'flex',
      alignItems:'center',
      justifyContent:'center',
      fontFamily:"'Righteous'",
      fontSize:18,
      letterSpacing:2,
      color:accent,
      textShadow:'0 1px 0 rgba(255,255,255,0.7)',
      zIndex:5,
    }}>{hint}</div>}
  </div>;
}
