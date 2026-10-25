// One owned, keyed subtree: background refresh never replaces drafts, focused
// rows or open menus. Files uses Kit, the console API and the shipped tokens.
const T3FilesUI = (() => {
  'use strict';
  const {html,raw,icon}=Kit, F=T3FilesModel, M=T3Model;
  const disabled=value=>value?raw(' disabled'):'';
  const count=(n,word)=>M.plural(n,word).replace(String(n),Number.isFinite(n)?n.toLocaleString():String(n));
  const bytes=value=>Number.isFinite(value)?M.formatBytes(value):'Not measured';
  const smallIcon=kind=>icon(F.icons[kind]||'file-text','tc-fl-icon');
  const create=({api,base,getStatus,getRoute,render,go})=>{
    const PHONE=window.matchMedia('(max-width: 639.98px)'),TABLET=window.matchMedia('(max-width: 1023.98px)');
    const folders=new Map();let roots={home:'/home/t3',workspace:'/workspace'},where=null,current=null,key=null;
    const measuring=new Set();
    let places=null,data=null,error=null,loading=false,started=false,epoch=0,request=null,timer=null,jobsTimer=null,jobs=[],active=true;
    let query='',searchData=null,searchError=null,searching=false,searchTimer=null,searchEpoch=0,searchController=null,filters={kind:'',size:'',modified:'',rebuildable:false};
    let details=null,detailError=null,detailPending=null,detailEpoch=0,preview=null,previewURL=null,previewController=null,reveal=false,sheet=null;
    let bulkSelection=false,treeFocus=null;
    let tree=new Map(),treeLoading=new Set(),largest=null,largestLoading=false,markup=null,rangeAnchor=null,focusPath=null,selectMode=false,goLayer=null;
    const alive=()=>getRoute()==='files'&&!document.hidden&&active;
    const onRoot=()=>where?.place==='projects'&&where.path===roots.workspace;
    const atPlaceRoot=()=>where?.path===(where.place==='home'?roots.home:roots.workspace);
    const hidden=()=>current?.hidden??(where?.place==='home');
    const rows=()=>searchData?.results||data?.projects||data?.entries||data?.items||[];
    const rowPath=row=>row.path||row.from;
    const visible=()=>(onRoot()||where?.place==='trash')&&query?rows().filter(row=>row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())):rows();
    const sizeTotal=()=>onRoot()?places?.projects?.bytes:data?.counts?.bytes;
    const selectedRows=()=>rows().filter(row=>current?.selection.has(rowPath(row)));
    const button=(label,command,{glyph,cls='',path:target,attrs=''}={})=>html`<button type="button" class="tc-btn tc-btn--sm ${cls}" data-cmd="files.${command}"${target?html` data-path="${target}"`:''}${raw(attrs)}>${glyph?icon(glyph):''}${label}</button>`;
    const iconButton=(label,command,glyph,target,attrs='')=>html`<button type="button" class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" data-cmd="files.${command}" aria-label="${label}" title="${label}"${target?html` data-path="${target}"`:''}${raw(attrs)}>${icon(glyph)}</button>`;
    const paint=()=>{
      markup=body();render();const mount=document.getElementById('files-browser');if(mount){Kit.patch(mount,markup);for(const field of mount.querySelectorAll('[data-files-check]'))field.checked=!!current?.selection.has(field.dataset.path);const all=mount.querySelector('[data-files-select-all]');if(all&&current){all.checked=visible().length>0&&current.selection.size===visible().length;all.indeterminate=current.selection.size>0&&!all.checked;all.setAttribute('aria-label',all.checked?'Clear selection':'Select all items');}const rebuildField=mount.querySelector('[data-files-rebuildable]');if(rebuildField)rebuildField.checked=filters.rebuildable;const searchField=mount.querySelector('#files-search');if(searchField&&searchField.value!==query)searchField.value=query;}
      if(sheet&&details)sheet.render();
    };
    const saveRecent=value=>{
      if([roots.home,roots.workspace,'/'].includes(value))return;
      try{const old=JSON.parse(localStorage.getItem('t3-console-files-recent')||'[]');localStorage.setItem('t3-console-files-recent',JSON.stringify([value,...(Array.isArray(old)?old:[]).filter(item=>typeof item==='string'&&item!==value)].slice(0,8)));}catch{}
    };
    const remember=()=>{if(current){current.scroll=window.scrollY;current.query=query;}};
    const stateFor=value=>{
      if(!folders.has(value)){
        if(folders.size>=64)folders.delete(folders.keys().next().value);
        let stored;try{stored=JSON.parse(localStorage.getItem('t3-console-files-hidden')||'{}');}catch{}
        folders.set(value,{selection:new Set(),view:'list',panelOpen:!TABLET.matches,panelPath:null,sort:{key:'size',dir:'desc'},hidden:stored?.[value],scroll:0,query:''});
      }
      return folders.get(value);
    };
    const navigate=value=>go(F.route(value,roots));
    const clearPreview=()=>{previewController?.abort();previewController=null;if(previewURL)URL.revokeObjectURL(previewURL);previewURL=null;preview=null;reveal=false;};
    const stop=()=>{clearTimeout(timer);timer=null;clearTimeout(jobsTimer);jobsTimer=null;request?.abort();request=null;searchController?.abort();clearTimeout(searchTimer);epoch++;};
    const refreshPlaces=async signal=>{
      const response=await api('/files/places',{signal});if(!response.ok||!response.data)return;
      if(typeof response.data?.home?.path!=='string'||typeof response.data?.projects?.path!=='string'||!response.data?.disk)return;
      places=response.data;roots={home:places.home.path,workspace:places.projects.path};
    };
    const schedule=()=>{clearTimeout(timer);if(alive())timer=setTimeout(()=>void load(false),5000);};
    const load=async(force=false)=>{
      if(!alive()||!where?.path&&where?.place!=='trash')return;
      if(request)return;
      const version=epoch,controller=new AbortController();request=controller;
      if(!data){loading=true;paint();}
      try{
        if(!places||force||Date.now()-(places._received||0)>=30_000){await refreshPlaces(controller.signal);if(places)places._received=Date.now();}
        if(version!==epoch||!alive()){return;}
        const endpoint=where.place==='trash'?'/files/trash':onRoot()?'/files/projects':'/files/list?'+new URLSearchParams({path:where.path,hidden:hidden()?'1':'0',sort:current.sort.key,dir:current.sort.dir,...(current.all?{all:'1'}:{})});
        const response=await api(endpoint,{signal:controller.signal,headers:!force&&data?.etag?{'If-None-Match':data.etag}:{}});
        if(version!==epoch||!alive()){return;}
        if(!response.ok){error={code:response.data?.code||'failed',message:response.error};return;}
        if(response.status!==304&&!Array.isArray(where.place==='trash'?response.data?.items:onRoot()?response.data?.projects:response.data?.entries)){error={code:'failed',message:'The service returned an incomplete folder listing. Try again.'};return;}
        if(response.status!==304&&response.data?.path&&response.data.path!==where.path&&where.place!=='trash'){navigate(response.data.path);return;}
        error=null;if(response.status!==304){data=response.data;if(data?.projects){const order=current.sort.dir==='asc'?1:-1;data.projects.sort((a,b)=>current.sort.key==='size'?((a.bytes??-1)-(b.bytes??-1))*order:String(a[current.sort.key]||'').localeCompare(String(b[current.sort.key]||''),undefined,{numeric:true})*order);}const valid=new Set(rows().map(rowPath));for(const name of current.selection)if(!valid.has(name))current.selection.delete(name);
          if(current.view!=='sizes'&&current.panelPath&&!valid.has(current.panelPath)&&current.panelPath!==where.path){current.panelPath=null;details=null;clearPreview();}
          if(!current.panelPath&&onRoot()&&!TABLET.matches&&rows().length){current.panelPath=rows()[0].path;current.selection.add(current.panelPath);}

          if(current.view==='sizes')void openSizes(true);
        }
        if(current.panelPath&&current.panelOpen)void showDetails(current.panelPath,{refresh:true});
        if(data?.measurement&&!jobsTimer)void pollJobs();
      }finally{if(version===epoch){loading=false;request=null;paint();schedule();}}
    };
    const activate=()=>{
      active=true;
      const next=F.address(location.hash,roots),nextKey=next.place+':'+next.path;
      if(key!==nextKey){
        remember();stop();clearPreview();sheet?.close('folder');sheet=null;detailEpoch++;details=null;detailError=null;detailPending=null;data=null;error=null;tree=new Map();treeLoading=new Set();largest=null;searchData=null;searchError=null;query='';
        where=next;key=nextKey;current=stateFor(key);query=current.query||'';current.treeOpened=false;bulkSelection=false;rangeAnchor=null;focusPath=null;selectMode=false;
        if(next.error)error={code:'invalid',message:next.error};
        if(next.path)saveRecent(next.path);
        paint();void load(true);if(query&&!onRoot())search();started=true;
        requestAnimationFrame(()=>window.scrollTo(0,current.scroll||0));
      }else if(!started||!timer&&!request){started=true;void load(false);}
    };
    const bar=(row,total,{composition=false}={})=>{
      if(!Number.isFinite(row.bytes))return html`<span class="tc-files-skeleton" aria-label="Size not measured"></span>`;
      const width=F.proportion(row.bytes,total),parts=composition?F.partsOf(row.composition):null;
      return html`<span class="tc-bar" role="img" aria-label="${bytes(row.bytes)}${row.rebuildable?', rebuildable':''}" style="background:none">${parts?parts.filter(part=>part.bytes>0).map(part=>html`<span data-part="${part.part}" style="width:${F.proportion(part.bytes,total)}%"></span>`):html`<span data-part="${row.rebuildable?'rebuild':row.name==='.git'?'git':'kept'}" style="width:${width}%"></span>`}</span>`;
    };
    const compositionBar=composition=>{
      const parts=F.partsOf(composition),total=parts?.reduce((sum,row)=>sum+row.bytes,0);
      if(!parts)return html`<div class="tc-comp tc-files-skeleton" role="img" aria-label="Composition has not been measured"></div>`;
      return html`<div class="tc-comp" role="img" aria-label="${parts.map(part=>part.label+': '+bytes(part.bytes)).join('; ')}">${parts.filter(part=>part.bytes>0).map(part=>html`<span data-part="${part.part}" style="width:${F.proportion(part.bytes,total)}%"></span>`)}</div>`;
    };
    const tags=row=>html`${row.running?.length?html`<span class="tc-ftag" data-tone="live"><span class="tc-dot"></span>Running</span>`:''}${(row.tags||[]).filter(tag=>tag!=='link'&&tag!=='secret').map(tag=>html`<span class="tc-ftag"${tag==='rebuildable'?raw(' data-tone="rebuild"'):['sign-in','keys'].includes(tag)?raw(' data-tone="warn"'):''}>${icon(({managed:'lock','sign-in':'key-round',keys:'key-round',rebuildable:'refresh-cw'})[tag]||'info')}${tag==='managed'?row.managedTag||row.what||'Managed':({'sign-in':'Sign-in inside',keys:'Keys',rebuildable:'Rebuildable'})[tag]||tag}</span>`)}`;
    const gitSub=row=>row.git&&typeof row.git==='object'?html`${icon('git-branch')}${row.git.branch?html`<code>${row.git.branch}</code><span class="tc-sep">·</span>`:''}${F.gitLine(row.git)||''}${row.git.ahead?html`<span class="tc-sep">·</span><span class="w">${row.git.ahead} to push</span>`:''}`:html`${icon('folder')}${row.what||F.gitLine(row.git)}`;
    const tabs=()=>PHONE.matches?html`<div class="tc-segfull" role="group" aria-label="Places">${['projects','home','trash'].map(place=>html`<button type="button" data-cmd="files.place" data-place="${place}" aria-pressed="${where?.place===place}">${{projects:'Projects',home:'Home',trash:'Trash'}[place]}${place==='projects'&&places?html`<small>${places.projects.count}</small>`:place==='trash'&&places?.trash.bytes?html`<small>${bytes(places.trash.bytes)}</small>`:''}</button>`)}</div>`:html`<div class="tc-tabs" role="tablist" aria-label="Places">${['projects','home','trash'].map(place=>html`<button class="tc-tab-button" type="button" role="tab" data-cmd="files.place" data-place="${place}" aria-selected="${where?.place===place}" tabindex="${where?.place===place?0:-1}">${{projects:'Projects',home:'Home',trash:'Trash'}[place]}${place==='projects'&&places?html`<span class="tc-tab-count">${places.projects.count}</span>`:place==='trash'&&places?.trash.bytes?html`<span class="tc-tab-count">${bytes(places.trash.bytes)}</span>`:''}</button>`)}</div>`;
    const crumbs=()=>{
      if(where?.place==='trash')return html`${icon('trash-2')}<span class="tc-crumb" aria-current="location">Trash</span>`;
      if(!where?.path)return '';
      const root=where.place==='projects'?roots.workspace:where.place==='home'?roots.home:'/',parts=where.path.slice(root==='/'?1:root.length).split('/').filter(Boolean);
      let absolute=root;
      return html`${icon(where.place==='home'?'house':where.place==='path'?'server':'folder')}<button class="tc-crumb" type="button" data-cmd="files.open" data-path="${root}"${!parts.length?raw(' aria-current="location"'):''}>${where.place==='projects'?'Projects':where.place==='home'?'Home':'/'}</button>${parts.map((name,index)=>{absolute=(absolute==='/'?'':absolute)+'/'+name;return html`${icon('chevron-right','tc-crumb-sep')}<button class="tc-crumb" type="button" data-cmd="files.open" data-path="${absolute}"${index===parts.length-1?raw(' aria-current="location"'):''}>${name}</button>`;})}`;
    };
    const searchField=()=>html`<label class="tc-fsearch"><span class="tc-sr">Search ${onRoot()?'projects':'files'}</span>${icon('search')}<input class="tc-input" type="search" id="files-search" data-key="files-search" value="${query}" placeholder="Search ${onRoot()?'projects':where?.place==='trash'?'Trash':F.basename(where?.path)}" autocomplete="off"><span class="tc-kbd" aria-hidden="true">/</span></label>`;
    const toolbar=()=>PHONE.matches?html`<div class="tc-fp-head">${tabs()}${!atPlaceRoot()&&where?.place!=='trash'?html`<nav class="tc-pcrumbs" aria-label="Location">${crumbs()}</nav>`:''}<div class="tc-psearch">${searchField()}${iconButton('View options','view-menu','sliders-horizontal')}</div></div>`:html`${tabs()}<div class="tc-fpage-body"><div class="tc-ftb"><nav class="tc-path" aria-label="Location" title="Go to folder: Ctrl or Command L"><div class="tc-files-crumbs">${crumbs()}</div><span class="tc-path-end">${atPlaceRoot()?html`<span class="tc-path-real">${where?.path}</span>`:''}${data?.managed?html`<span class="tc-badge">${icon('lock')}Managed</span>`:data&&!data.writable&&!onRoot()&&where?.place!=='trash'?html`<span class="tc-badge">${icon('eye')}Read-only for t3</span>`:''}${iconButton('Go to folder','goto','corner-left-up')}${iconButton('Copy path','copy-path','copy',where?.path)}</span></nav>${searchField()}${where?.place!=='trash'?html`<div class="tc-segicons" role="group" aria-label="Show as">${['list','sizes'].map(view=>html`<button type="button" data-cmd="files.view" data-view="${view}" aria-pressed="${current?.view===view}">${icon(view==='list'?'list':'chart-bar')}${view==='list'?'List':'Sizes'}</button>`)}</div>`:''}${button('View','view-menu',{glyph:'chevron-down'})}${iconButton('Toggle details panel','panel','panel-right',null,` aria-pressed="${!!current?.panelOpen}"`)}</div></div>`;
    const summary=()=>{
      if(!places||!atPlaceRoot()||where.place==='trash'||query)return '';
      const info=where.place==='home'?places.home:places.projects,parts=F.partsOf(info.composition);
      return html`<section class="tc-group ${PHONE.matches?'tc-psum':'tc-fsum'}" aria-label="${where.place==='home'?'Home':'Projects'} disk usage"><div class="tc-fsum-lead"><strong>${Number.isFinite(info.bytes)?bytes(info.bytes):html`<span class="tc-files-size-unknown tc-files-skeleton" aria-label="Size not measured yet"></span>`}</strong><span>${where.place==='projects'?'in '+count(info.count,'project'):'in your home folder'}${PHONE.matches?' · '+bytes(places.disk.availableBytes)+' free':''}</span></div>${PHONE.matches?'':html`<div class="tc-fsum-free">${where.place==='home'&&info.volume?html`Kept on the <strong>${info.volume}</strong> volume`:html`<strong>${bytes(places.disk.availableBytes)} free</strong> of ${bytes(places.disk.totalBytes)} on this disk`}</div>`}${compositionBar(info.composition)}<div class="tc-fsum-legend">${parts?(PHONE.matches&&where.place==='projects'?parts.filter(part=>part.part==='rebuild'):parts).map(part=>html`<span class="tc-key"><i data-part="${part.part}" aria-hidden="true"></i>${part.label} <strong>${bytes(part.bytes)}</strong></span>`):html`<span class="tc-muted">Sizes appear as folders are measured.</span>`}${where.place==='home'?html`<span class="tc-spacer"></span><a class="tc-btn tc-btn--sm" href="#storage">Manage in Storage${icon('arrow-right')}</a>`:''}</div></section>`;
    };
    const stateView=(code,message,retry='refresh')=>{const state=F.state(code);return html`<div class="tc-files-state" role="status">${icon(state.icon)}<h2>${state.title}</h2><p>${message||state.copy}</p>${['missing','no-access'].includes(code)?button('Open parent folder','open',{glyph:'arrow-up',path:F.parent(where?.path||roots.workspace)}):code==='failed'?button('Try again',retry,{glyph:'refresh-cw'}):code==='search'?html`${button('Clear search','clear-search')}${!filters.rebuildable?button('Search rebuildable folders too','search-rebuild',{glyph:'refresh-cw'}):''}${button(where?.place==='home'?'Search all Home':'Search all projects','search-widen',{glyph:'folder'})}`:code==='projects'?button('Go to folder…','goto',{glyph:'folder-open'}):''}</div>`;};
    const footer=()=>{const measured=onRoot()?data?.measuredAt||places?.measuredAt:data?.measuredAt;return html`<div class="tc-fl-foot"><span>${count(data?.total??visible().length,onRoot()?'project':'item')}</span>${Number.isFinite(sizeTotal())?html`<span class="tc-sep">·</span><span>${bytes(sizeTotal())}</span>`:''}${data?.counts?.hidden?html`<span class="tc-sep">·</span><span>${data.counts.hidden} hidden</span>${button(hidden()?'Hide':'Show','hidden',{cls:'tc-btn--link'})}`:''}<span class="tc-spacer"></span>${measuring.has(where?.path)?html`<span role="status"><span class="tc-spinner"></span>Starting measurement…</span>`:jobs.some(row=>row.state==='running'&&row.path===where?.path)?html`<span role="status"><span class="tc-spinner"></span>Measuring ${F.basename(where.path)} ${Number.isFinite(jobs.find(row=>row.state==='running'&&row.path===where.path).done)?' · '+count(jobs.find(row=>row.state==='running'&&row.path===where.path).done,'file'):''}</span>`:html`<span title="${measured||''}">${measured?'Measured '+M.relTime(measured,Date.now()):'Not measured yet'}</span>${button('Measure again','measure',{glyph:'refresh-cw',cls:'tc-btn--ghost tc-btn--xs',attrs:loading?' disabled':''})}`}</div>`;};
    const selectionBar=()=>html`<div class="tc-fl-selbar" role="region" aria-label="Selection actions"><input class="tc-checkbox" type="checkbox" checked data-files-select-all aria-label="Clear selection"><div><strong>${count(current.selection.size,'selected item')}</strong><span>${bytes(F.totalOf(selectedRows()))}</span></div><div>${selectedRows().length===1?button('Details','details',{glyph:'panel-right',path:rowPath(selectedRows()[0])}):''}${button('Copy paths','copy-selected',{glyph:'copy',cls:'tc-btn--ghost'})}${iconButton('Clear selection','clear-selection','x')}</div></div>`;
    const sortButton=(label,sort)=>html`<button class="tc-sort" type="button" data-cmd="files.sort" data-sort="${sort}">${label}${current.sort.key===sort?icon(current.sort.dir==='desc'?'chevron-down':'chevron-up'):''}</button>`;
    const marked=name=>{const index=query?name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()):-1;return index<0?name:html`${name.slice(0,index)}<mark>${name.slice(index,index+query.length)}</mark>${name.slice(index+query.length)}`;};
    const rowMarkup=(row,index,max)=>{
      const value=rowPath(row),selected=current.selection.has(value),name=row.name||F.basename(value),kind=row.kind||'folder';
      if(PHONE.matches)return html`<div class="tc-prow-file" role="row" aria-rowindex="${index+1}" aria-selected="${selected}" tabindex="${focusPath===value||!focusPath&&index===0?0:-1}" data-key="f:${value}" data-files-row data-path="${value}" title="${value}">${selectMode?html`<input class="tc-checkbox" type="checkbox" data-files-check data-path="${value}" tabindex="-1" aria-label="Select ${name}"${selected?raw(' checked'):''}>`:smallIcon(kind)}<div><span><b class="${kind==='folder'?'':'tc-mono-name'}">${marked(name)}</b>${tags(row)}</span><small>${onRoot()?gitSub(row):row.relativeFolder||row.what||row.type||kind}</small>${bar(row,max,{composition:onRoot()})}</div><b>${Number.isFinite(row.bytes)?bytes(row.bytes):html`<span class="tc-files-skeleton" aria-label="Size not measured"></span>`}</b></div>`;
      const cells=onRoot()?html`${row.threads?html`<span class="tc-fmeta" role="gridcell">${row.threads.count?count(row.threads.count,'thread'):'—'}</span>`:data?.threadsAvailable?html`<span class="tc-fmeta" role="gridcell">—</span>`:''}`:'';
      return html`<div class="tc-fl-row" role="row" aria-rowindex="${index+2}" aria-selected="${selected}" tabindex="${focusPath===value||!focusPath&&index===0?0:-1}" data-key="f:${value}" data-files-row data-path="${value}"${row.rebuildable?raw(' data-dim'):''} title="${value}"><span role="gridcell"><input class="tc-checkbox" type="checkbox" data-files-check data-path="${value}" tabindex="-1" aria-label="Select ${name}"${selected?raw(' checked'):''}></span><div class="tc-fcell" role="gridcell">${onRoot()?html`<span class="tc-ftile">${icon('folder')}</span>`:smallIcon(kind)}<div class="tc-fname"><span><b class="${kind==='folder'?'':'tc-mono-name'}">${marked(name)}</b>${tags(row)}${typeof row.git==='string'?html`<span class="tc-git" data-s="${row.git}">${row.git}</span>`:''}</span>${onRoot()?html`<small>${gitSub(row)}</small>`:row.relativeFolder?html`<small>${row.relativeFolder}</small>`:row.what?html`<small>${row.what}</small>`:kind==='link'?html`<small>${icon('corner-left-up')}${row.target?.missing?'Destination is missing':F.display(row.target?.path||'',roots.home)}</small>`:''}</div></div><span class="tc-fsize" role="gridcell">${bar(row,max,{composition:onRoot()})}<b>${Number.isFinite(row.bytes)?bytes(row.bytes):html`<span class="tc-files-skeleton" aria-label="Size not measured"></span>`}${row.partial?html`<span title="Some files could not be measured"> ≥</span>`:''}</b></span>${cells}<span class="tc-fmeta" role="gridcell" title="${row.modified||''}">${row.modified?M.relTime(row.modified,Date.now()):'—'}</span><span class="tc-fmenu" role="gridcell">${iconButton('Actions for '+name,'menu','ellipsis',value,' aria-haspopup="menu" tabindex="-1"')}</span></div>`;
    };
    const list=()=>{
      const filtered=visible(),max=Math.max(1,...filtered.map(row=>row.bytes||0));
      if(!filtered.length)return html`<div class="tc-group">${stateView(query?'search':onRoot()?'projects':where?.place==='trash'?'trash':'empty')}${data?footer():''}</div>`;
      return html`<div class="tc-group tc-fcard">${!PHONE.matches&&current.selection.size&&(bulkSelection||current.selection.size>1)?selectionBar():''}<div class="${PHONE.matches?'tc-plist':'tc-fl'+(onRoot()?' tc-fl--projects':'')}" role="grid" aria-label="${onRoot()?'Projects':'Files'}" aria-multiselectable="true" aria-rowcount="${filtered.length+(PHONE.matches?0:1)}" ${bulkSelection||current.selection.size>1?raw(' data-selecting'):''}${onRoot()&&!data?.threadsAvailable?raw(' data-no-threads'):''}>
        ${PHONE.matches?'':current.selection.size&&(bulkSelection||current.selection.size>1)?html`<div class="tc-fl-head tc-sr" role="row"><span role="columnheader">Select</span><span role="columnheader">Name</span><span role="columnheader">Size</span>${onRoot()&&data?.threadsAvailable?html`<span role="columnheader">In T3 Code</span>`:''}<span role="columnheader">Modified</span><span role="columnheader">Actions</span></div>`:html`<div class="tc-fl-head" role="row"><span role="columnheader"><input class="tc-checkbox" type="checkbox" data-files-select-all aria-label="Select all items"></span><span role="columnheader" aria-sort="${current.sort.key==='name'?current.sort.dir==='asc'?'ascending':'descending':'none'}">${sortButton('Name','name')}</span><span role="columnheader" aria-sort="${current.sort.key==='size'?current.sort.dir==='asc'?'ascending':'descending':'none'}">${sortButton('Size','size')}</span>${onRoot()&&data?.threadsAvailable?html`<span role="columnheader">In T3 Code</span>`:''}<span role="columnheader">${sortButton('Modified','modified')}</span><span role="columnheader"><span class="tc-sr">Actions</span></span></div>`}
        ${filtered.slice(0,current.visibleLimit||500).map((row,index)=>rowMarkup(row,index,max))}</div>
        ${filtered.length>(current.visibleLimit||500)?html`<div class="tc-files-more">${button('Show '+Math.min(500,filtered.length-(current.visibleLimit||500))+' more items','more-visible')}<span class="tc-muted">${filtered.length} loaded · search to narrow this list</span></div>`:data?.more?html`<div class="tc-files-more">${button('Show all '+data.total+' items','all')}</div>`:''}
        ${data?.truncated||data?.invalidNames?html`<p class="tc-files-notice" role="status">${data.truncated?'This folder has more than 20,000 items. Search by name to find the rest. ':''}${data.invalidNames?count(data.invalidNames,'name')+' could not be displayed because it is not valid UTF-8.':''}</p>`:''}${footer()}</div>`;
    };
    const loadTree=async(value,refresh=false)=>{
      if(treeLoading.has(value)||!alive()||tree.has(value)&&!refresh)return;
      treeLoading.add(value);if(!tree.has(value))paint();const version=epoch,response=await api('/files/tree?'+new URLSearchParams({path:value,limit:String(tree.get(value)?.shown||6)}));
      treeLoading.delete(value);if(version!==epoch)return;
      if(response.ok&&Array.isArray(response.data?.children)&&typeof response.data.path==='string')tree.set(value,{...response.data,expanded:tree.get(value)?.expanded??value===where.path,shown:tree.get(value)?.shown||6});
      else tree.set(value,{path:value,error:response.error||'The service returned incomplete folder sizes. Try again.',expanded:true});paint();
    };
    const openSizes=async(refresh=false)=>{
      const version=epoch;await loadTree(where.path,refresh);
      if(version!==epoch||current.treeOpened)return;
      current.treeOpened=true;
      await Promise.all((tree.get(where.path)?.children||[]).filter(row=>row.kind==='folder').slice(0,6).map(async row=>{await loadTree(row.path);if(version===epoch&&tree.has(row.path))tree.get(row.path).expanded=true;}));
      if(version===epoch)paint();
    };
    const treeRows=(value,level=1)=>{
      const node=tree.get(value);if(!node)return html`<div role="row"><span class="tc-files-tree-status" role="gridcell" aria-colspan="5"><span class="tc-spinner"></span>Reading folders…</span></div>`;
      if(node.error)return html`<div role="row"><span class="tc-files-tree-status" role="gridcell" aria-colspan="5">${node.error}${button('Try again','tree-retry',{path:value})}</span></div>`;
      const children=node.children||[],limit=node.shown||6,shown=children.slice(0,limit);
      return html`${shown.map((row,index)=>{
        const target=row.path||value.replace(/\/$/,'')+'/'+row.name,child=tree.get(target),expanded=!!child?.expanded;
        return html`<div role="row" class="tc-fl-row" tabindex="${treeFocus===target||!treeFocus&&level===1&&index===0?0:-1}" aria-selected="${current.treeSelection===target}" data-key="tree:${target}" data-files-tree-row data-path="${target}" aria-level="${level}"${row.kind==='folder'?html` aria-expanded="${expanded}"`:''} data-depth="${level-1}"><div role="gridcell" class="tc-tnode" style="--depth:${level-1}">${row.kind==='folder'?treeLoading.has(target)?html`<button type="button" aria-label="Loading ${row.name}" aria-busy="true" disabled><span class="tc-spinner"></span></button>`:iconButton(expanded?'Collapse '+row.name:'Expand '+row.name,'tree-toggle',expanded?'chevron-down':'chevron-right',target):html`<span class="tc-tspacer"></span>`}${smallIcon(row.kind)}<b title="${target}">${row.name}</b>${row.rebuildable?html`<span class="tc-ftag" data-tone="rebuild">${icon('refresh-cw')}Rebuildable</span>`:''}</div><span role="gridcell">${bar(row,node.bytes)}</span><span class="tc-right" role="gridcell">${bytes(row.bytes)}</span><span class="tc-fmeta tc-right" role="gridcell">${Number.isFinite(row.share)?row.share<1?'<1%':Math.round(row.share)+'%':'—'}</span><span role="gridcell">${iconButton('Details for '+row.name,'details','ellipsis',target)}</span></div>${expanded?treeRows(target,level+1):''}`;
      })}${children.length>limit||node.more?.count?html`<div class="tc-fl-row tc-files-tree-more" role="row"><span role="gridcell">${button(count(Math.max(0,children.length-limit)+(node.more?.count||0),'more item'),'tree-all',{glyph:'ellipsis',path:value,cls:'tc-btn--ghost'})}</span><span role="gridcell">${bar({bytes:node.more?.count?node.more.bytes:F.totalOf(children.slice(limit))},node.bytes)}</span><span role="gridcell" class="tc-right">${bytes(node.more?.count?node.more.bytes:F.totalOf(children.slice(limit)))}</span><span role="gridcell"></span><span role="gridcell"></span></div>`:''}`;
    };
    const sizesView=()=>html`<div class="tc-group tc-fcard"><div class="tc-fl tc-tree" role="treegrid" aria-label="Folder sizes"><div class="tc-fl-head" role="row"><span role="columnheader">Name</span><span role="columnheader">Share of its folder</span><span class="tc-right" role="columnheader">Size</span><span class="tc-right" role="columnheader">%</span><span role="columnheader"><span class="tc-sr">Details</span></span></div>${treeRows(where.path)}</div>${footer()}</div>`;
    const previewMarkup=()=>{
      if(!details?.preview)return html`<p class="tc-muted tc-files-preview-fallback">${details?.kind==='link'?'This is a link. Open its destination to browse it.':'No preview for this file type. Download it to open it.'}</p>`;
      if(preview?.error)return html`<p class="tc-files-preview-fallback" role="status">${preview.error}${button('Try again','preview-retry')}</p>`;
      if(!preview)return html`<div class="tc-files-preview-loading" role="status"><span class="tc-spinner"></span>Loading preview…</div>`;
      if(preview.kind==='image')return html`<div class="tc-files-image"><img src="${previewURL}" alt="${details.name}" data-files-image></div>${preview.width?html`<p class="tc-hint">${preview.width} × ${preview.height} · ${details.name.split('.').pop().toUpperCase()} · ${bytes(details.bytes)}</p>`:''}`;
      if(preview.kind==='pdf')return html`<iframe class="tc-files-pdf" title="${details.name}" src="${previewURL}" sandbox></iframe>`;
      if(preview.kind==='binary')return html`<p class="tc-muted">This file is binary or is not valid UTF-8. Download it to open it.</p>`;
      return html`${details.secret?html`<div class="tc-files-secret"><span>${icon('eye-off')}Values hidden</span>${button(reveal?'Hide values':'Show values','reveal',{glyph:reveal?'eye-off':'eye',cls:'tc-btn--ghost tc-btn--xs'})}</div>`:''}<pre class="tc-fprev" aria-label="${details.secret&&!reveal?'Preview with values hidden':'File preview'}">${preview.text.split('\n').slice(0,200).map(line=>html`<span>${F.tokens(details.secret&&!reveal?F.mask(line):line||' ').map(token=>token.tone?html`<span class="${token.tone}">${token.text}</span>`:token.text)}</span>`)}</pre>${preview.truncated||preview.text.split('\n').length>200?html`<p class="tc-hint">Showing the first ${Math.min(200,preview.text.split('\n').length)} lines. Download for the complete file.</p>`:''}`;
    };
    const detailFacts=()=>html`<dl class="tc-fd-facts"><dt>Path</dt><dd><code class="tc-files-path-wrap">${details.path}</code></dd><dt>Modified</dt><dd>${M.absTime(details.modified)}</dd><dt>Access</dt><dd><code>${details.mode}</code> · ${details.owner}</dd>${details.target?html`<dt>Link target</dt><dd><code class="tc-files-path-wrap">${details.target.path}</code></dd>`:''}</dl>`;
    const loadLargest=async value=>{
      const minimum=current.largestMin||10e6,requestKey=value+':'+minimum;if(largestLoading===requestKey||largest?.path===value&&largest.min===minimum)return;
      largestLoading=requestKey;const version=detailEpoch;
      const response=await api('/files/largest?'+new URLSearchParams({path:value,min:String(minimum)}));
      if(largestLoading===requestKey)largestLoading=false;if(version!==detailEpoch||minimum!==(current.largestMin||10e6))return;
      largest=response.ok?{...response.data,min:minimum}:{path:value,min:minimum,error:response.error};paint();
    };
    const largestPanel=()=>html`<div class="tc-fd-sec"><span class="tc-fd-label">Largest files <span class="tc-spacer"></span>${button('Over '+bytes(current.largestMin||10e6),'largest-filter',{glyph:'chevron-down',cls:'tc-btn--ghost tc-btn--xs'})}</span>${!largest?html`<p class="tc-hint" role="status"><span class="tc-spinner"></span>Finding the largest files…</p>`:largest.error?html`<p class="tc-hint" role="status">${largest.error}</p>${button('Try again','largest-retry')}`:html`<div class="tc-fd-list">${largest.files.filter(row=>row.bytes>=(current.largestMin||10e6)).map(row=>html`<button type="button" class="tc-fd-item tc-files-largest" data-cmd="files.reveal-file" data-path="${largest.path+'/'+row.path}">${icon('file-text')}<span><span class="tc-mono-name">${F.basename(row.path)}</span><small>${F.parent(row.path)}</small></span><b>${bytes(row.bytes)}</b></button>`)}</div>${!largest.files.some(row=>row.bytes>=(current.largestMin||10e6))?html`<p class="tc-hint">No files over ${bytes(current.largestMin||10e6)} were found.</p>`:''}${largest.truncated?html`<p class="tc-hint">The search reached its limit. These are the largest files found so far.</p>`:''}`}</div>`;
    const detailsBody=()=>{
      if(detailError)return stateView('failed',detailError);
      if(!details)return html`<div class="tc-files-detail-empty">${icon('panel-right')}<p>${detailPending?'Reading details…':'Select a file or folder to see its details.'}</p></div>`;
      const parts=F.partsOf(details.composition),git=details.git;
      return html`<header class="tc-fd-head"><span class="tc-ftile">${icon(F.icons[details.kind]||'file-text')}</span><div class="tc-fd-title"><h2 id="files-details-title" class="${details.kind==='folder'?'':'tc-mono-name'}">${details.name}</h2><code title="${details.path}">${F.display(details.path,roots.home)}</code></div>${iconButton('Actions for '+details.name,'menu','ellipsis',details.path)}${iconButton('Close details','close-panel','x')}</header>
      ${details.kind==='folder'?html`<div class="tc-fd-sec"><div class="tc-fd-big"><strong>${Number.isFinite(details.bytes)?(details.partial?'≥ ':'')+bytes(details.bytes):html`<span class="tc-files-size-unknown tc-files-skeleton" aria-label="Size not measured yet"></span>`}</strong>${Number.isFinite(details.files)?html`<span>${count(details.files,'file')}</span>`:''}</div>${compositionBar(details.composition)}${parts?html`<div class="tc-fd-keys">${parts.map(part=>html`<span class="tc-key"><i data-part="${part.part}"></i>${part.label}</span><span></span><b>${bytes(part.bytes)}</b>`)}</div>`:html`<p class="tc-hint">${details.partial?'Some files could not be measured.':'Composition appears when measurement finishes.'}</p>`}</div>
      ${current.view==='sizes'?largestPanel():''}${current.view!=='sizes'&&details.largestFolders?.length?html`<div class="tc-fd-sec"><div class="tc-fd-label">Largest folders<span class="tc-spacer"></span>${button('Sizes view','sizes-for',{path:details.path,cls:'tc-btn--link'})}</div><div class="tc-fd-list">${details.largestFolders.map(row=>html`<button type="button" class="tc-fd-item" data-cmd="files.open" data-path="${details.path+'/'+row.path}">${icon('folder')}<span><span>${row.path}</span></span>${bar(row,details.bytes)}<b>${bytes(row.bytes)}</b></button>`)}</div></div>`:''}
      ${git||details.threads||details.running?.length?html`<div class="tc-fd-sec"><span class="tc-fd-label">Git and activity</span><dl class="tc-fd-facts">${git?html`<dt>Branch</dt><dd>${git.loading?'Reading…':!git.available&&git.available!==undefined?'Git status unavailable':html`<code>${git.branch}</code>${git.upstream?html`<span class="tc-muted">→ ${git.upstream}</span>`:''}`}</dd>${git.available||git.available===undefined?html`<dt>Changes</dt><dd>${git.changed||0} not committed${git.ahead?' · '+git.ahead+' to push':''}</dd>${git.lastCommit?html`<dt>Last commit</dt><dd>${git.lastCommit.subject}</dd>`:''}`:''}`:''}${details.threads?html`<dt>T3 Code</dt><dd>${count(details.threads.count,'thread')}${details.threads.lastActiveAt?' · active '+M.relTime(details.threads.lastActiveAt,Date.now()):''}</dd>`:''}${details.running?.some(row=>row.port)?html`<dt>Running</dt><dd>${details.running.filter(row=>row.port).map(row=>html`<a href="#ports">${row.label} on port ${row.port}</a>`)}</dd>`:''}</dl></div>`:''}`:html`<div class="tc-fd-sec"><div class="tc-fd-label">${bytes(details.bytes)} · ${details.type}${Number.isFinite(details.lines)?' · '+count(details.lines,'line'):''}</div>${previewMarkup()}</div>`}
      ${details.kind!=='folder'?html`<div class="tc-fd-sec">${detailFacts()}</div>`:''}<div class="tc-fd-foot">${details.trashed?'':details.kind==='folder'||details.target?.kind==='folder'?button('Open','open',{glyph:'folder-open',path:details.target?.path||details.path,cls:'tc-btn--primary'}):details.kind!=='special'?button('Download','download',{glyph:'download',path:details.path,cls:'tc-btn--primary'}):''}${iconButton('Copy path','copy-path','copy',details.path)}</div>`;
    };
    const detailPanel=()=>!current?.panelOpen||TABLET.matches?'':html`<aside class="tc-group tc-fd" aria-label="Details" data-key="files-details">${detailsBody()}</aside>`;
    const searchFilters=()=>html`<div class="tc-files-filters" role="group" aria-label="Search filters">${button('In '+F.basename(where.path),'search-widen',{glyph:'x',cls:'tc-btn--xs'})}${button(filters.kind?filters.kind[0].toUpperCase()+filters.kind.slice(1):'Any type','filter-kind',{glyph:'chevron-down',cls:'tc-btn--xs'})}${button(filters.size?'Over '+bytes(Number(filters.size)):'Any size','filter-size',{glyph:'chevron-down',cls:'tc-btn--xs'})}${button(filters.modified?'Modified recently':'Any time','filter-date',{glyph:'chevron-down',cls:'tc-btn--xs'})}<label class="tc-files-filter-check"><input class="tc-checkbox" type="checkbox" data-files-rebuildable${filters.rebuildable?raw(' checked'):''}>Include rebuildable folders and Git history</label></div>`;
    const body=()=>{
      if(!where)return html`<div class="tc-fpage-body"><div class="tc-group">${Array.from({length:5},()=>html`<div class="tc-skel-row"><span class="tc-files-skeleton"></span><span class="tc-files-skeleton"></span></div>`)}</div></div>`;
      return html`${toolbar()}<div class="tc-fpage-body${PHONE.matches?' tc-files-phone-body':''}">${summary()}${data?.managed?html`<div class="tc-fbanner" data-tone="managed">${icon('lock')}<div><strong>${data.managed.title}</strong><span>${data.managed.body}</span></div><a class="tc-btn tc-btn--sm" href="#${data.managed.pages[0]}">Open ${data.managed.pages[0]==='toolchains'?'Toolchains':data.managed.pages[0]==='agents'?'Agents':'Storage'}</a></div>`:data&&!data.writable&&!onRoot()&&where.place!=='trash'?html`<div class="tc-fbanner" data-tone="info">${icon('eye')}<div><strong>You can look and download here</strong><span>This folder is read-only for t3.</span></div></div>`:''}
      ${query&&!onRoot()&&where.place!=='trash'?searchFilters():''}${searching?html`<div class="tc-files-search-status" role="status"><span class="tc-spinner"></span>Searching names in this folder…</div>`:searchData?html`<div class="tc-files-search-status" role="status">${count(searchData.results.length,'match')}${Number.isFinite(searchData.searched)?' · '+count(searchData.searched,'entry')+' searched':''}${searchData.skippedRebuildable?' · '+count(searchData.skippedRebuildable,'rebuildable folder')+' skipped':''}${searchData.truncated?' · Search reached its limit; narrow the name or open a smaller folder.':''}${searchData.partial?' · Some folders could not be read.':''}${button('Clear','clear-search',{cls:'tc-btn--link'})}</div>`:''}
      ${searchError?html`<div class="tc-group">${stateView('failed',searchError,'search-retry')}</div>`:error?html`<div class="tc-group">${stateView(error.code,error.message)}</div>`:loading&&!data?html`<div class="tc-group" role="status" aria-label="Loading files">${Array.from({length:7},()=>html`<div class="tc-skel-row"><span class="tc-files-skeleton"></span><span class="tc-files-skeleton"></span><span class="tc-files-skeleton"></span><span class="tc-files-skeleton"></span></div>`)}</div>`:html`<div class="tc-fx" data-panel="${current?.panelOpen&&!TABLET.matches?'open':'closed'}">${current?.view==='sizes'&&where.place!=='trash'&&!query?sizesView():list()}${detailPanel()}</div>`}
      ${PHONE.matches&&selectMode?html`<div class="tc-files-phone-selection" role="region" aria-label="Selection actions"><strong>${current.selection.size} selected</strong>${button('Copy paths','copy-selected',{glyph:'copy',attrs:current.selection.size?'':' disabled'})}${button('Done','select-mode')}</div>`:''}</div>`;
    };
    const loadPreview=async()=>{
      clearPreview();if(!details?.preview)return;
      const row=details,version=detailEpoch,controller=new AbortController();previewController=controller;
      try{
        if(row.preview==='text'){
          const response=await api('/files/read?'+new URLSearchParams({path:row.path}),{signal:controller.signal});
          if(!response.ok)throw new Error(response.error);if(response.data?.kind!=='binary'&&(response.data?.kind!=='text'||typeof response.data.text!=='string'))throw new Error('The service returned an incomplete preview. Try again.');if(version===detailEpoch)preview=response.data;
        }else{
          const response=await fetch(base+'/files/raw?'+new URLSearchParams({path:row.path}),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
          if(!response.ok)throw new Error('The preview could not be read. Download the file to open it.');
          const limit=(row.preview==='pdf'?50:25)*1024*1024;
          if(Number(response.headers.get('content-length'))>limit)throw new Error('This file is too large to preview. Download it to open it.');
          const reader=response.body.getReader(),chunks=[];let total=0;
          try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();throw new Error('This file grew beyond the preview limit. Download it to open it.');}chunks.push(value);}}finally{reader.releaseLock();}
          const ext=row.name.split('.').pop().toLowerCase(),mime=row.preview==='pdf'?'application/pdf':({svg:'image/svg+xml',jpg:'image/jpeg',jpeg:'image/jpeg',ico:'image/x-icon'})[ext]||'image/'+ext;
          if(version===detailEpoch){previewURL=URL.createObjectURL(new Blob(chunks,{type:mime}));preview={kind:row.preview};}
        }
      }catch(error){if(version===detailEpoch&&!controller.signal.aborted)preview={error:error.message||'The preview could not be read.'};}
      if(version===detailEpoch)paint();
    };
    const ensureSheet=()=>{
      if(!TABLET.matches||sheet||!current?.panelOpen)return;
      sheet=Kit.open({kind:'bottom',panel:{tag:'aside',class:'tc-sheet tc-sheet--bottom tc-files-detail-sheet',role:'dialog','aria-label':'File details'},render:()=>detailsBody(),onClose:reason=>{sheet=null;if(!['resize','route','folder'].includes(reason)){current.panelOpen=false;clearPreview();}}});
    };
    const showDetails=async(value,{refresh=false}={})=>{
      if(!value)return;
      if(!refresh){current.panelOpen=true;ensureSheet();}
      if(detailPending===value)return;
      current.panelPath=value;
      if(where.place==='trash'){const item=rows().find(row=>rowPath(row)===value);if(item){details={...item,path:item.from,name:item.name,type:item.kind,owner:'t3',mode:'—',modified:item.deletedAt,trashed:true};current.panelOpen=true;paint();}return;}
      const same=details?.path===value;
      if(!same){detailEpoch++;clearPreview();details=null;detailError=null;largest=null;}
      if(!refresh)current.panelOpen=true;
      detailPending=value;const version=detailEpoch,routeVersion=epoch;
      if(!refresh)paint();
      const response=await api('/files/details?'+new URLSearchParams({path:value}));
      if(routeVersion!==epoch||version!==detailEpoch)return;
      detailPending=null;
      if(response.ok&&typeof response.data?.path==='string'&&typeof response.data.kind==='string'){const changed=details?.etag!==response.data.etag;details=response.data;detailError=null;if(!same||changed||!preview&&details.preview)void loadPreview();}
      else detailError=response.error||'The service returned incomplete file details. Try again.';
      if(response.ok&&details?.kind==='folder'&&current.view==='sizes')void loadLargest(value);
      if(response.ok&&details&&current.panelOpen)ensureSheet();
      paint();
    };
    const select=(value,{toggle=false,range=false}={})=>{
      if(!value)return;focusPath=value;bulkSelection=toggle||range;
      if(range&&rangeAnchor){const values=visible().map(rowPath),from=values.indexOf(rangeAnchor),to=values.indexOf(value);if(from>=0&&to>=0){if(!toggle)current.selection.clear();for(const item of values.slice(Math.min(from,to),Math.max(from,to)+1))current.selection.add(item);}}
      else if(toggle){if(current.selection.has(value))current.selection.delete(value);else current.selection.add(value);rangeAnchor=value;}
      else{current.selection.clear();current.selection.add(value);rangeAnchor=value;}
      if(current.selection.size===1){const target=[...current.selection][0];if(!TABLET.matches&&current.panelOpen)void showDetails(target);else current.panelPath=target;}
      paint();
    };
    const selectAll=()=>{bulkSelection=true;if(current.selection.size===visible().length)current.selection.clear();else current.selection=new Set(visible().map(rowPath));paint();};
    const findRow=value=>{const listed=rows().find(row=>rowPath(row)===value);if(listed)return listed;for(const node of tree.values()){const row=node.children?.find(row=>(row.path||node.path.replace(/\/$/,'')+'/'+row.name)===value);if(row)return {...row,path:value};}return details?.path===value?details:null;};
    const open=async value=>{
      if(!value)return;
      if(where.place==='trash'){await showDetails(value);return;}
      const row=findRow(value);
      if(value===roots.workspace&&onRoot()){go('files/path/'+F.encode(value));return;}
      if(row?.kind==='folder'||row?.target?.kind==='folder'||!row)navigate(row?.target?.path||value);
      else if(searchData)await command('reveal-file',{path:value});else {select(value);await showDetails(value);}
    };
    const download=async value=>{
      const response=details?.path===value?{ok:true,data:details}:await api('/files/details?'+new URLSearchParams({path:value}));
      if(!response.ok){Kit.toast('Couldn’t download this file',{tone:'danger',detail:response.error});return;}
      const consequence=F.consequences(response.data);
      if(consequence&&!await Kit.confirm({title:'Download '+F.basename(value)+'?',body:consequence,confirm:'Download',tone:'primary'}))return;
      const link=document.createElement('a');link.href=base+'/files/raw?'+new URLSearchParams({path:value});link.download=F.basename(value);link.hidden=true;document.body.appendChild(link);link.click();link.remove();
    };
    const menu=(value,trigger,at)=>{
      const row=rows().find(row=>rowPath(row)===value)||(details?.path===value?details:null);if(!row)return;
      if(where.place==='trash'){void showDetails(value);return;}
      const folder=row.kind==='folder'||row.target?.kind==='folder';
      Kit.menu(trigger||document.querySelector('[data-files-row][data-path="'+CSS.escape(value)+'"]'),{label:F.basename(value)+' actions',className:'tc-ctx',at,
        head:{title:F.basename(value),sub:bytes(row.bytes)},items:[
          {label:folder?'Open folder':'Preview',icon:folder?'folder-open':'eye',run:()=>open(value)},
          {label:'Details',icon:'panel-right',run:()=>showDetails(value)},
          ...(!folder&&row.kind!=='special'?[{label:'Download',icon:'download',run:()=>download(value)}]:[]),
          {sep:true},{label:'Copy path',icon:'copy',run:()=>Kit.copy(value,'Path copied')},
          ...(PHONE.matches?[{label:'Select',icon:'check',run:()=>{selectMode=true;select(value);}}]:[]),
        ],footer:row.tags?.includes('managed')?'Managed here. Use Agents, Updates or Storage to make changes.':null});
    };
    const viewMenu=trigger=>Kit.menu(trigger||document.querySelector('[data-cmd="files.view-menu"]'),{label:'View files',items:[
      {label:'Show hidden files',checkbox:true,checked:hidden(),run:()=>command('hidden')},
      {sep:true},...['size','name','modified'].map(sort=>({label:'Sort by '+sort,radio:true,checked:current.sort.key===sort,run:()=>command('sort',{sort})})),
      {sep:true},{label:'List',radio:true,checked:current.view==='list',run:()=>command('view',{view:'list'})},{label:'Sizes',radio:true,checked:current.view==='sizes',run:()=>command('view',{view:'sizes'})},
      ...(PHONE.matches?[{label:selectMode?'Finish selecting':'Select items',icon:'check',run:()=>command('select-mode')}]:[{label:'Details panel',checkbox:true,checked:current.panelOpen,run:()=>command('panel')}]),
      ...(onRoot()?[{label:'Browse workspace files',description:'Folders and loose files in '+roots.workspace,icon:'folder-open',run:()=>go('files/path/'+F.encode(roots.workspace))}]:[]),
      {sep:true},{label:'Go to folder…',icon:'folder-open',run:()=>goToFolder()},{label:'Keyboard shortcuts',run:()=>keyboardHelp()},
    ]});
    const keyboardHelp=()=>{
      const mod=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘':'Ctrl';
      const shortcuts=[['Move focus','↑ ↓ / Home / End'],['Preview','Space'],['Open','Enter'],['Extend selection','Shift + ↑ ↓'],['Toggle selection',mod+' + Space'],['Select all',mod+' + A'],['Go to folder',mod+' + L'],['Parent folder',mod+' + ↑'],['Copy paths',mod+' + C'],['Search','/'],['Item actions','Shift + F10'],['Clear selection / close details','Esc']];
      let layer;layer=Kit.open({kind:'center',panel:{class:'tc-fdlg',role:'dialog','aria-modal':'true','aria-labelledby':'files-keys-title'},render:()=>html`<div class="tc-fdlg-head"><h2 id="files-keys-title">Keyboard shortcuts</h2><p>Browse and select without leaving the keyboard.</p></div><div class="tc-keys-grid">${shortcuts.map(([label,keys])=>html`<span>${label}</span><span><kbd class="tc-kbd">${keys}</kbd></span>`)}</div><div class="tc-fdlg-foot"><span class="tc-spacer"></span><button class="tc-btn" type="button" data-keys-close data-initial-focus>Done</button></div>`});layer.panel.querySelector('[data-keys-close]').addEventListener('click',()=>layer.close('done'));
    };
    const goToFolder=()=>{
      if(getRoute()!=='files'){go('files');setTimeout(goToFolder,0);return;}if(goLayer)return;
      let value=where?.path||roots.workspace,matches=[],pending=false,opening=false,message='',sequence=0,debounce,selected=-1;
      const anchor=!PHONE.matches&&document.querySelector('#files-browser .tc-path')?.getBoundingClientRect();
      let recents=[];try{const saved=JSON.parse(localStorage.getItem('t3-console-files-recent')||'[]');if(Array.isArray(saved))recents=saved.filter(item=>typeof item==='string'&&F.normalize(item)).slice(0,8);}catch{}
      const suggest=async()=>{const version=++sequence;pending=true;goLayer?.render();const response=await api('/files/suggest?'+new URLSearchParams({q:value}));if(version!==sequence||!goLayer)return;pending=false;const usable=response.ok&&Array.isArray(response.data?.matches);matches=usable?response.data.matches:[];message=usable?'':response.error||'Folder suggestions are unavailable. You can still enter a complete path.';goLayer.render();};
      const chosen=async()=>{
        if(opening)return;
        clearTimeout(debounce);const version=++sequence;pending=false;
        const target=selected>=0?matches[selected]?.path:value==='~'?roots.home:value.startsWith('~/')?roots.home+'/'+value.slice(2):F.normalize(value);
        if(!target){message='Enter an absolute path, or start with ~/.';goLayer.render();return;}
        opening=true;message='';goLayer.render();
        const response=await api('/files/list?'+new URLSearchParams({path:target}));
        if(!goLayer||version!==sequence)return;
        opening=false;
        if(!response.ok&&response.data?.code==='invalid'){const file=await api('/files/details?'+new URLSearchParams({path:target}));if(!goLayer||version!==sequence)return;if(file.ok&&typeof file.data?.kind==='string'&&!['folder','special'].includes(file.data.kind)){goLayer.close('open');void command('reveal-file',{path:target});return;}}
        if(!response.ok||typeof response.data?.path!=='string'||!Array.isArray(response.data.entries)){message=response.error||'The service returned an incomplete folder. Try again.';goLayer.render();return;}
        goLayer.close('open');navigate(response.data.path);
      };
      goLayer=Kit.open({kind:anchor?'menu':'center',modal:!anchor,panel:{class:'tc-fdlg tc-files-goto'+(anchor?' tc-files-goto--anchored':''),role:'dialog','aria-modal':String(!anchor),'aria-labelledby':'files-goto-title'},render:()=>html`<div class="${anchor?'tc-sr':'tc-fdlg-head'}"><h2 id="files-goto-title">Go to folder</h2><p>Open any folder t3 can access.</p></div><div class="tc-fdlg-body"><label class="tc-sr" for="files-goto-input">Folder path</label><input id="files-goto-input" class="tc-input tc-mono" data-initial-focus data-key="files-goto-input" value="${value}" placeholder="/workspace or ~/" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="files-suggestions" aria-expanded="${matches.length>0}"${selected>=0?html` aria-activedescendant="files-suggestion-${selected}"`:''}><div id="files-suggestions" role="listbox" aria-label="Folders">${matches.map((row,index)=>html`<button class="tc-files-suggestion" type="button" role="option" id="files-suggestion-${index}" aria-selected="${selected===index}" data-suggest-path="${row.path}">${icon('folder')}<code>${row.display}</code><span>${Number.isFinite(row.bytes)?bytes(row.bytes):''}</span></button>`)}</div>${message?html`<p class="tc-field-error" role="alert">${message}</p>`:pending?html`<p class="tc-hint" role="status">Finding folders…</p>`:!matches.length&&recents.length?html`<span class="tc-files-recent-label">Recent folders</span>${recents.map(item=>html`<button class="tc-files-suggestion" type="button" data-suggest-path="${item}">${icon('history')}<code>${F.display(item,roots.home)}</code></button>`)}`:''}</div><div class="tc-fdlg-foot"><span class="tc-hint">${icon('lock')}Same permissions as t3’s terminal</span><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost" type="button" data-goto-cancel>Cancel</button><button class="tc-btn tc-btn--primary" type="button" data-goto-open${disabled(opening)} aria-busy="${opening}">${opening?html`<span class="tc-spinner"></span>Opening…`:'Open folder'}</button></div>`,onClose:()=>{clearTimeout(debounce);sequence++;goLayer=null;}});
      if(anchor){const width=Math.min(Math.max(anchor.width,420),innerWidth-32);Object.assign(goLayer.panel.style,{width:width+'px',left:Math.max(16,Math.min(innerWidth-width-16,anchor.left))+'px',top:Math.max(8,anchor.top-1)+'px',maxHeight:Math.max(160,innerHeight-anchor.top-16)+'px'});}
      goLayer.panel.addEventListener('input',event=>{if(event.target.id!=='files-goto-input')return;value=event.target.value;selected=-1;matches=[];message='';pending=true;opening=false;sequence++;clearTimeout(debounce);goLayer.render();debounce=setTimeout(suggest,150);});
      goLayer.panel.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void chosen();}else if(event.key==='Tab'&&selected>=0&&matches[selected]){event.preventDefault();value=matches[selected].path+'/';selected=-1;goLayer.render();void suggest();}else if(['ArrowDown','ArrowUp'].includes(event.key)&&matches.length){event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length;goLayer.render();}});
      goLayer.panel.addEventListener('click',event=>{if(event.target.closest('[data-goto-cancel]'))goLayer.close('cancel');if(event.target.closest('[data-goto-open]'))void chosen();const target=event.target.closest('[data-suggest-path]');if(target){value=target.dataset.suggestPath;selected=-1;void chosen();}});
      requestAnimationFrame(()=>{const field=document.getElementById('files-goto-input');field?.focus();field?.select();});
    };
    const pollJobs=async()=>{
      clearTimeout(jobsTimer);if(!alive())return;
      const response=await api('/files/jobs');if(!alive())return;if(response.ok&&Array.isArray(response.data?.jobs))jobs=response.data.jobs;
      paint();if(jobs.some(row=>['running','queued'].includes(row.state)))jobsTimer=setTimeout(()=>void pollJobs(),1000);else void load(true);
    };
    const search=()=>{
      clearTimeout(searchTimer);searchController?.abort();searchEpoch++;searchData=null;searchError=null;
      if(!query||onRoot()||where?.place==='trash'){searching=false;paint();return;}
      const version=searchEpoch,routeVersion=epoch,controller=new AbortController();searchController=controller;searching=true;paint();
      searchTimer=setTimeout(async()=>{
        const response=await api('/files/search?'+new URLSearchParams({path:where.path,q:query,...filters,rebuildable:filters.rebuildable?'1':'0'}),{signal:controller.signal});
        if(version!==searchEpoch||routeVersion!==epoch)return;searching=false;
        if(response.ok&&Array.isArray(response.data?.results))searchData=response.data;else searchError=response.error||'The service returned incomplete search results. Try again.';paint();
      },250);
    };
    const command=async(name,args={},trigger)=>{
      if(name==='go'||name==='goto')return goToFolder();
      if(name==='place'){go(args.place==='projects'?'files':args.place==='home'?'files/home':'files/trash');return;}
      if(!where){go('files');return;}
      if(name==='up'){navigate(F.parent(where.path));return;}
      if(name==='select-all'){selectAll();return;}
      if(name==='clear'){current.selection.clear();paint();return;}
      if(name==='keys')return keyboardHelp();
      if(name==='open')return open(args.path||current.panelPath);
      if(name==='details')return showDetails(args.path||current.panelPath||where.path);
      if(name==='menu')return menu(args.path,trigger);
      if(name==='search-rebuild'){filters.rebuildable=true;search();return;}
      if(name==='search-widen'){const target=where.place==='home'?roots.home:roots.workspace,route='files/path/'+F.encode(target),next=F.address('#'+route,roots);stateFor(next.place+':'+next.path).query=query;if(where.path===target)search();else go(route);return;}
      if(name==='filter-kind')return Kit.menu(trigger,{label:'File type',items:[['','Any type'],['folder','Folders'],['code','Code'],['text','Text'],['image','Images'],['video','Video'],['audio','Audio'],['archive','Archives']].map(([value,label])=>({label,radio:true,checked:filters.kind===value,run:()=>{filters.kind=value;search();}}))});
      if(name==='filter-size')return Kit.menu(trigger,{label:'File size',items:[['','Any size'],['1000000','Over 1 MB'],['10000000','Over 10 MB'],['100000000','Over 100 MB'],['1000000000','Over 1 GB']].map(([value,label])=>({label,radio:true,checked:filters.size===value,run:()=>{filters.size=value;search();}}))});
      if(name==='filter-date')return Kit.menu(trigger,{label:'Modified',items:[['','Any time'],[1,'Past day'],[7,'Past week'],[30,'Past month']].map(([days,label])=>({label,radio:true,checked:days?!filters.modified?false:Math.abs(Date.parse(filters.modified)-(Date.now()-days*86400_000))<60_000:!filters.modified,run:()=>{filters.modified=days?new Date(Date.now()-days*86400_000).toISOString():'';search();}}))});
      if(name==='view-menu')return viewMenu(trigger);
      if(name==='copy-path')return Kit.copy(args.path||where.path,'Path copied');
      if(name==='copy-selected')return Kit.copy(selectedRows().map(rowPath).join('\n'),'Paths copied');
      if(name==='download')return download(args.path||current.panelPath);
      if(name==='close-panel'){current.panelOpen=false;sheet?.close('close');sheet=null;clearPreview();paint();return;}
      if(name==='panel'){current.panelOpen=!current.panelOpen;if(current.panelOpen)void showDetails(current.panelPath||where.path);paint();return;}
      if(name==='view'){current.view=args.view==='sizes'?'sizes':'list';if(current.view==='sizes'){void openSizes();if(current.panelOpen)void showDetails(where.path);}paint();return;}
      if(name==='sizes-for'){const next=F.address('#'+F.route(args.path,roots),roots);stateFor(next.place+':'+next.path).view='sizes';navigate(args.path);return;}
      if(name==='sort'){current.sort={key:args.sort,dir:current.sort.key===args.sort&&current.sort.dir==='desc'?'asc':'desc'};if(onRoot()&&data?.projects){const direction=current.sort.dir==='desc'?-1:1;data.projects.sort((a,b)=>current.sort.key==='size'?((a.bytes??-1)-(b.bytes??-1))*direction:String(a[current.sort.key]||'').localeCompare(String(b[current.sort.key]||''),undefined,{numeric:true})*direction);paint();}else void load(true);return;}
      if(name==='hidden'){current.hidden=!hidden();try{const saved=JSON.parse(localStorage.getItem('t3-console-files-hidden')||'{}');saved[key]=current.hidden;localStorage.setItem('t3-console-files-hidden',JSON.stringify(saved));}catch{}void load(true);return;}
      if(name==='clear-selection'){current.selection.clear();paint();return;}
      if(name==='select-mode'){selectMode=!selectMode;if(!selectMode)current.selection.clear();paint();return;}
      if(name==='all'){current.all=true;void load(true);return;}
      if(name==='more-visible'){current.visibleLimit=(current.visibleLimit||500)+500;paint();return;}
      if(name==='search-retry'){search();return;}
      if(name==='clear-search'){query='';filters={kind:'',size:'',modified:'',rebuildable:false};search();return;}
      if(name==='tree-toggle'){const node=tree.get(args.path);if(node){node.expanded=!node.expanded;paint();}else {await loadTree(args.path);if(tree.has(args.path))tree.get(args.path).expanded=true;paint();}return;}
      if(name==='tree-retry'){await loadTree(args.path,true);return;}
      if(name==='tree-all'){const row=tree.get(args.path);row.shown=Math.min(row.total||row.children.length,(row.shown||6)+500);if(row.more?.count)await loadTree(args.path,true);else paint();return;}
      if(name==='refresh'){void load(true);return;}
      if(name==='measure'){if(measuring.has(where.path)||jobs.some(row=>row.path===where.path&&row.state==='running'))return;const target=where.path;measuring.add(target);paint();try{const response=await api('/files/measure',{body:{path:target}});if(!response.ok)Kit.toast('Couldn’t measure '+F.basename(target),{tone:'danger',detail:response.error});else if(response.data.busy)Kit.toast('Two folders are already being measured',{tone:'info',detail:'Try again when a measurement finishes.'});else {if(!jobs.some(row=>row.id===response.data.job))jobs.push({id:response.data.job,path:target,state:'running',done:0});void pollJobs();}}finally{measuring.delete(target);paint();}return;}
      if(name==='largest-filter')return Kit.menu(trigger,{label:'Largest files',items:[10e6,100e6,1e9].map(value=>({label:'Over '+bytes(value),radio:true,checked:value===(current.largestMin||10e6),run:()=>{current.largestMin=value;largest=null;void loadLargest(details.path);paint();}}))});
      if(name==='reveal-file'){const parent=F.parent(args.path),route=parent===roots.workspace?'files/path/'+F.encode(parent):F.route(parent,roots),next=F.address('#'+route,roots),state=stateFor(next.place+':'+next.path);state.query='';state.selection=new Set([args.path]);state.panelPath=args.path;state.panelOpen=true;if(F.basename(args.path).startsWith('.'))state.hidden=true;go(route);return;}
      if(name==='largest-retry'){largest=null;void loadLargest(details.path);paint();return;}
      if(name==='preview-retry'){void loadPreview();return;}
      if(name==='reveal'){reveal=!reveal;paint();return;}
    };
    document.addEventListener('change',event=>{if(event.target.matches('[data-files-rebuildable]')){filters.rebuildable=event.target.checked;search();}});
    document.addEventListener('input',event=>{if(event.target.id==='files-search'){query=event.target.value;current.selection.clear();current.visibleLimit=500;search();}});
    document.addEventListener('click',event=>{
      if(held||getRoute()!=='files'||Kit.top()||!event.target.closest('#files-browser'))return;
      if(event.target.closest('[data-files-select-all]')){event.stopImmediatePropagation();selectAll();return;}
      if(event.target.closest('.tc-path')&&!event.target.closest('button')){event.preventDefault();goToFolder();return;}
      const treeRow=event.target.closest('[data-files-tree-row]');if(treeRow&&!event.target.closest('button')){event.preventDefault();event.stopImmediatePropagation();treeFocus=treeRow.dataset.path;current.treeSelection=treeFocus;if(current.panelOpen||TABLET.matches)void showDetails(treeFocus);paint();return;}
      const row=event.target.closest('[data-files-row]');if(!row||event.target.closest('[data-cmd]'))return;
      const checking=!!event.target.closest('[data-files-check]');if(!checking)event.preventDefault();event.stopImmediatePropagation();const value=row.dataset.path;
      if(TABLET.matches&&!selectMode&&!event.target.closest('[data-files-check]'))void open(value);
      else {select(value,{toggle:event.metaKey||event.ctrlKey||checking||selectMode,range:event.shiftKey});if(!checking&&!Kit.top())row.focus({preventScroll:true});}
    },true);
    let hold=null,held=false,point=null;
    document.addEventListener('pointerdown',event=>{const row=event.target.closest('#files-browser [data-files-row]');if(!PHONE.matches||!row||event.target.closest('button,input'))return;held=false;point={x:event.clientX,y:event.clientY};clearTimeout(hold);hold=setTimeout(()=>{held=true;menu(row.dataset.path,row);},500);});
    document.addEventListener('pointermove',event=>{if(point&&Math.hypot(event.clientX-point.x,event.clientY-point.y)>8){clearTimeout(hold);point=null;}});
    for(const name of ['pointerup','pointercancel'])document.addEventListener(name,()=>{clearTimeout(hold);point=null;});
    document.addEventListener('click',event=>{if(held&&event.target.closest('#files-browser [data-files-row]')){held=false;event.preventDefault();event.stopImmediatePropagation();}},true);
    document.addEventListener('dblclick',event=>{const row=event.target.closest('#files-browser [data-files-row]');if(row&&!event.target.closest('button,input'))void open(row.dataset.path);});
    document.addEventListener('contextmenu',event=>{const row=event.target.closest('#files-browser [data-files-row]');if(!row||Kit.top())return;event.preventDefault();select(row.dataset.path);menu(row.dataset.path,row,{x:event.clientX,y:event.clientY});});
    document.addEventListener('keydown',event=>{
      if(getRoute()!=='files'||Kit.top()||Kit.isTyping(event.target))return;
      const mod=event.metaKey||event.ctrlKey;
      if(event.key==='?'){event.preventDefault();keyboardHelp();return;}
      if((event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)&&event.target.closest('[data-files-row]')){event.preventDefault();const row=event.target.closest('[data-files-row]');menu(row.dataset.path,row);return;}
      if(mod&&event.key.toLowerCase()==='c'&&current.selection.size&&!window.getSelection()?.toString()){event.preventDefault();void Kit.copy(selectedRows().map(rowPath).join('\n'),'Paths copied');return;}
      if(mod&&event.key.toLowerCase()==='l'){event.preventDefault();goToFolder();return;}
      if(mod&&event.key.toLowerCase()==='a'){event.preventDefault();current.selection=new Set(visible().map(rowPath));bulkSelection=true;paint();return;}
      if(mod&&event.key==='ArrowUp'){event.preventDefault();navigate(F.parent(where.path));return;}
      if(mod&&event.shiftKey&&event.key.toLowerCase()==='c'){event.preventDefault();void Kit.copy(selectedRows().map(rowPath).join('\n')||where.path,'Path copied');return;}
      const tab=event.target.closest('[role="tab"][data-place]');
      if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const values=['projects','home','trash'],index=values.indexOf(tab.dataset.place),next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:-1)+3)%3;void command('place',{place:values[next]});requestAnimationFrame(()=>document.querySelector('[role="tab"][data-place="'+values[next]+'"]')?.focus());return;}
      const treeRow=event.target.closest('[data-files-tree-row]');
      if(treeRow&&['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End','Enter',' '].includes(event.key)){
        event.preventDefault();const value=treeRow.dataset.path,expanded=treeRow.getAttribute('aria-expanded');
        if(event.key==='Enter'){void open(value);return;}if(event.key===' '){void showDetails(value);return;}
        let next;
        if(event.key==='ArrowRight'){if(expanded==='false')void command('tree-toggle',{path:value});else next=document.querySelector('[data-files-tree-row][data-path="'+CSS.escape(tree.get(value)?.children?.[0]?.path||value+'/'+(tree.get(value)?.children?.[0]?.name||''))+'"]');}
        else if(event.key==='ArrowLeft'){if(expanded==='true')void command('tree-toggle',{path:value});else next=document.querySelector('[data-files-tree-row][data-path="'+CSS.escape(F.parent(value))+'"]');}
        else {const rows=[...document.querySelectorAll('[data-files-tree-row]')],index=rows.indexOf(treeRow);next=rows[event.key==='Home'?0:event.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowDown'?1:-1)))];}
        if(next){treeFocus=next.dataset.path;for(const row of document.querySelectorAll('[data-files-tree-row]'))row.tabIndex=row===next?0:-1;next.focus();}return;
      }
      const row=event.target.closest('[data-files-row]');
      if(row&&['ArrowDown','ArrowUp','Home','End',' ','Enter'].includes(event.key)){
        event.preventDefault();const values=visible().slice(0,current.visibleLimit||500).map(rowPath),index=values.indexOf(row.dataset.path);
        if(event.key==='Enter'){if(event.altKey)void command('reveal-file',{path:row.dataset.path});else void open(row.dataset.path);return;}if(event.key===' '){if(mod||event.shiftKey)select(row.dataset.path,{toggle:true});else void showDetails(row.dataset.path);return;}
        const next=event.key==='Home'?0:event.key==='End'?values.length-1:Math.max(0,Math.min(values.length-1,index+(event.key==='ArrowDown'?1:-1)));
        focusPath=values[next];if(event.shiftKey&&!rangeAnchor)rangeAnchor=row.dataset.path;if(event.shiftKey)select(focusPath,{range:true});else paint();document.querySelector('[data-files-row][data-path="'+CSS.escape(focusPath)+'"]')?.focus();
      }else if(event.key==='Escape'){event.preventDefault();if(current.selection.size){current.selection.clear();paint();}else if(current.panelOpen)void command('close-panel');}
      else if(event.key===' '&&current.panelPath){event.preventDefault();void showDetails(current.panelPath);}
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(getRoute()==='files'){active=true;void load(true);if(jobs.some(row=>row.state==='running'))void pollJobs();}});
    const resize=()=>{if(getRoute()==='files'){if(!TABLET.matches){sheet?.close('resize');sheet=null;}else if(details&&current?.panelOpen)ensureSheet();paint();}};PHONE.addEventListener('change',resize);TABLET.addEventListener('change',resize);
    document.addEventListener('load',event=>{if(event.target.matches?.('[data-files-image]')&&preview?.kind==='image'&&preview.width!==event.target.naturalWidth){preview.width=event.target.naturalWidth;preview.height=event.target.naturalHeight;paint();}},true);
    document.addEventListener('error',event=>{if(event.target.matches?.('[data-files-image]')){preview={error:'This image format could not be previewed. Download it to open it.'};paint();}},true);
    return {content:()=>html`<div id="files-browser" data-key="files-browser" data-keep>${markup||body()}</div>`,
      phoneHead:()=>html`<header class="tc-instructions-phone-head"><a class="tc-btn tc-btn--ghost" href="#more">${icon('chevron-right','tc-back-icon')}Setup</a><h1>Files</h1>${document.documentElement.hasAttribute('data-embed')?html`<button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-cmd="embed.close" aria-label="Close setup">${icon('x')}</button>`:html`<a class="tc-btn tc-btn--ghost tc-btn--icon" href="#more" aria-label="Close Files">${icon('x')}</a>`}</header>`,
      activate,command,focusSearch:()=>document.getElementById('files-search')?.focus(),isBusy:()=>!!request,
      actions:()=>'',beforeNavigate:async()=>{remember();active=false;stop();sheet?.close('route');sheet=null;clearPreview();paint();return true;},
      paletteItems:()=>[{id:'files-goto',group:'Files',label:'Go to folder…',icon:'folder-open',keywords:'browse filesystem path home workspace',cmd:{cmd:'files.goto'}},{id:'files-trash',group:'Files',label:'Open Trash',icon:'trash-2',keywords:'restore removed files',cmd:{cmd:'files.place',place:'trash'}}],
    };
  };
  return {create};
})();
