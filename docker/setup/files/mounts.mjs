import { readText } from './text.mjs';
import { normalizePath, inside } from './paths.mjs';
const decode=value=>value.replace(/\\(040|011|012|134)/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
export function parseMounts(text){
  const mounts=[];
  for(const line of text.split('\n').filter(Boolean)){
    const fields=line.split(' '),separator=fields.indexOf('-');
    if(separator<6||fields.length<separator+4)return {available:false,mounts:[]};
    try{mounts.push({id:fields[0],device:fields[2],path:normalizePath(decode(fields[4])),readOnly:fields[5].split(',').includes('ro')});}catch{return {available:false,mounts:[]};}
  }
  return {available:mounts.some(row=>row.path==='/'),mounts:mounts.sort((a,b)=>b.path.length-a.path.length)};
}
export function createMountService({read=()=>readText('/proc/self/mountinfo'),now=Date.now}={}){
  let value={available:false,mounts:[]},at=0,pending;
  const snapshot=async(fresh=false)=>{
    if(pending)await pending;
    if(!fresh&&at&&now()-at<5000)return value;
    pending=(async()=>{try{const text=await read();value=text.kind==='text'&&!text.truncated?parseMounts(text.text):{available:false,mounts:[]};}catch{value={available:false,mounts:[]};}at=now();})().finally(()=>{pending=null;});
    await pending;return value;
  };
  const forPath=async(path,{fresh=false}={})=>{const facts=await snapshot(fresh),row=facts.mounts.find(row=>inside(row.path,path));return {...facts,mount:row||null,isMountPoint:facts.mounts.some(row=>row.path===path)};};
  return {snapshot,forPath};
}
