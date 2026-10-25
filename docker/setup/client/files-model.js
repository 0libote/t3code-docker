// Files' pure presentation model. No DOM or I/O, shared with fixtures/tests.
const T3FilesModel = (() => {
  'use strict';
  const icons = { folder:'folder',code:'file-code',text:'file-text',image:'file-image',video:'file-video',audio:'file-text',archive:'file-archive',pdf:'file-text',secret:'file-key',exec:'terminal',db:'database',link:'link',special:'file-text',file:'file-text' };
  const basename = value => String(value || '').split('/').filter(Boolean).pop() || '/';
  const normalize = value => {
    if(typeof value!=='string'||!value.startsWith('/')||value.includes('\0')||!value.isWellFormed())return null;
    const segments=[];for(const part of value.split('/')){if(!part||part==='.')continue;if(part==='..')segments.pop();else segments.push(part);}return '/'+segments.join('/');
  };
  const parent = value => {const parts=value.split('/');parts.pop();return parts.join('/')||'/';};
  const within = (root,value) => value===root||value.startsWith(root==='/'?'/':root+'/');
  const display = (value,home) => home&&within(home,value)?'~'+value.slice(home.length):value;
  const encode = value => value.split('/').map(encodeURIComponent).join('/');
  const route = (value,{home='/home/t3',workspace='/workspace'}={}) => {
    value=normalize(value);if(!value)return 'files';
    if(within(workspace,value))return 'files/projects'+(value===workspace?'':'/'+encode(value.slice(workspace.length+1)));
    if(within(home,value))return 'files/home'+(value===home?'':'/'+encode(value.slice(home.length+1)));
    return 'files/path/'+encode(value);
  };
  const address = (hash,roots={}) => {
    const parts=String(hash||'').replace(/^#\/?/,'').split('?')[0].split('/');
    const place=parts[1]||'projects';if(place==='trash')return {place:'trash',path:null};
    let tail;try{tail=parts.slice(2).map(decodeURIComponent).join('/');}catch{return {place:'path',path:null,error:'This folder address is not valid.'};}
    if(!['projects','home','path'].includes(place))return {place:'path',path:null,error:'This folder address is not valid.'};
    const base=place==='projects'?roots.workspace||'/workspace':place==='home'?roots.home||'/home/t3':'/';
    const value=normalize(place==='path'?(tail.startsWith('/')?tail:'/'+tail):base+'/'+tail);
    return {place,path:value,error:value?null:'This folder address is not valid.'};
  };
  const partsOf = composition => Array.isArray(composition)?composition:composition?[
    {label:'Source and data',part:'kept',bytes:composition.keptBytes},{label:'Git history',part:'git',bytes:composition.gitBytes},{label:'Rebuildable',part:'rebuild',bytes:composition.rebuildableBytes}]:null;
  const proportion = (bytes,total) => Number.isFinite(bytes)&&total>0?Math.max(0,Math.min(100,bytes/total*100)):0;
  const totalOf = rows => rows.every(row=>Number.isFinite(row.bytes))?rows.reduce((sum,row)=>sum+row.bytes,0):null;
  const gitLine = git => !git?'Not a Git repository':git.loading?'Reading Git status…':!git.available&&git.available!==undefined?'Git status unavailable':git.noRemote?'No remote':git.changed?git.changed+' changed':git.ahead?null:'Clean';
  const mask = line => {const match=/^([\s]*(?:export\s+)?[\w.-]+\s*[:=]\s*)(.*)$/.exec(line);return match?match[1]+(match[2]?'••••••••':''):line.trim()?'••••••••':'';};
  // Small, escaped lexical accents, never HTML or a language interpreter.
  // Long lines and token counts are bounded independently of the byte limit.
  const tokens = line => {
    const text=line.slice(0,4000), out=[], expression=/(\/\/.*$|^\s*#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|import|from|export|default|function|return|async|await|class|new|if|else|true|false|null|def|fn|pub|use|struct|type|interface)\b)/g;
    let at=0,match;
    while(out.length<256&&(match=expression.exec(text))){if(match.index>at)out.push({text:text.slice(at,match.index)});const token=match[0];out.push({text:token,tone:/^(?:\s*#|\/\/)/.test(token)?'m':/^["'`]/.test(token)?'s':'k'});at=expression.lastIndex;}
    if(at<text.length)out.push({text:text.slice(at)});if(line.length>4000)out.push({text:' …',tone:'m'});return out;
  };
  const state = code => ({
    missing:{icon:'folder-open',title:'This folder is no longer here',copy:'It may have been moved or removed. Open its parent to keep browsing.'},
    'no-access':{icon:'lock',title:'You can’t open this folder',copy:'This console runs as t3, like agents’ terminals. The owner has not given t3 permission to open it.'},
    'read-only':{icon:'eye',title:'You can look and download here',copy:'This filesystem is read-only for t3.'},
    empty:{icon:'folder-open',title:'This folder is empty',copy:'Files and folders placed here will appear in this list.'},
    projects:{icon:'folder',title:'Your projects live here',copy:'Every folder in your workspace appears here, with its disk usage and Git activity.'},
    search:{icon:'search',title:'No matching files',copy:'Try a shorter name, another file type or fewer filters.'},
    trash:{icon:'trash-2',title:'Trash is empty',copy:'Items moved to Trash will appear here before they are removed permanently.'},
    failed:{icon:'circle-alert',title:'This folder could not be read',copy:'Check the connection and try again.'},
  })[code]||{icon:'circle-alert',title:'This folder could not be read',copy:'Check the connection and try again.'};
  const consequences = row => row.keys?'This download includes private keys. Anyone with them may be able to access your other services.':row.signIns?.length?'This download includes '+row.signIns.join(' and ')+' sign-in credentials. Anyone with them may be able to use those accounts.':row.secret?'This file may contain secrets. Keep the download somewhere private.':null;
  return {icons,basename,normalize,parent,within,display,route,address,encode,partsOf,proportion,totalOf,gitLine,mask,tokens,state,consequences};
})();
