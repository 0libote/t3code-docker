// Keep native attachment downloads on HTTP. Chromium can cancel attachment
// responses supplied by route.fulfill: microsoft/playwright#28253.
// Only the console document is read upstream; API writes never go upstream.
const http=require('node:http');
const ZIP_BYTES=Buffer.from('504b0506000000000000000000000000000000000000','hex');

const createDownloadFixture=async({base,key,chunkDelay=50})=>{
  const source=new URL(base),mount=source.pathname.replace(/\/+$/,''),timers=new Set();
  const counts={started:0,completed:0,aborted:0};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(url.pathname===mount+'/files/zip'){
      counts.started++;
      res.on('finish',()=>{counts.completed++;});
      res.on('close',()=>{if(!res.writableFinished)counts.aborted++;});
      res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="files.zip"',
        'content-security-policy':"sandbox; default-src 'none'",'x-content-type-options':'nosniff'});
      res.write(ZIP_BYTES.subarray(0,11));
      const timer=setTimeout(()=>{timers.delete(timer);res.end(ZIP_BYTES.subarray(11));},chunkDelay);
      timers.add(timer);res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});return;
    }
    if(url.pathname!==source.pathname){res.writeHead(404);res.end();return;}
    try{
      const upstream=new URL(source);upstream.search=url.search;
      const page=await fetch(upstream,{headers:{'x-t3-setup-key':key},redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!page.ok)throw new Error('The console document was unavailable');
      const body=await page.text(),csp=page.headers.get('content-security-policy');
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',...(csp?{'content-security-policy':csp}:{})});
      res.end(body);
    }catch{res.writeHead(502,{'content-type':'text/plain'});res.end('The fixture console document could not be loaded.');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {base:'http://127.0.0.1:'+server.address().port+source.pathname,
    stats:()=>({...counts}),
    close:()=>new Promise(resolve=>{for(const timer of timers)clearTimeout(timer);timers.clear();server.close(resolve);server.closeAllConnections();})};
};
module.exports={createDownloadFixture,ZIP_BYTES};
