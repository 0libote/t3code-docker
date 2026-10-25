import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import fixtureModule from '../scripts/lib/console-download-fixture.cjs';
const {createDownloadFixture,ZIP_BYTES}=fixtureModule;

test('download audit serves complete native ZIP bytes and never forwards API writes or credentials', async t=>{
  const calls=[];
  const upstream=http.createServer((req,res)=>{
    calls.push({method:req.method,url:req.url});
    if(req.headers['x-t3-setup-key']!=='fixture-private-key'){
      res.writeHead(401);res.end('Do not forward this private failure');return;
    }
    res.writeHead(200,{'content-type':'text/html','content-security-policy':"script-src 'nonce-test'",'set-cookie':'private=upstream'});
    res.end('<html><body>Actual console document</body></html>');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();}));
  const base='http://127.0.0.1:'+upstream.address().port+'/__setup/';
  const fixture=await createDownloadFixture({base,key:'fixture-private-key',chunkDelay:20});
  t.after(()=>fixture.close());
  const page=await fetch(fixture.base+'?embed=t3&theme=dark');
  assert.equal(page.status,200);
  assert.match(await page.text(),/Actual console document/);
  assert.equal(page.headers.get('content-security-policy'),"script-src 'nonce-test'");
  assert.equal(page.headers.get('set-cookie'),null);
  assert.deepEqual(calls,[{method:'GET',url:'/__setup/?embed=t3&theme=dark'}]);
  const download=await fetch(new URL('files/zip?token=fixture',fixture.base));
  assert.match(download.headers.get('content-disposition'),/^attachment;/);
  assert.equal(download.headers.get('content-type'),'application/zip');
  assert.equal(download.headers.get('content-length'),null,'exercise a streamed response');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),ZIP_BYTES);
  assert.deepEqual(fixture.stats(),{started:1,completed:1,aborted:0});
  assert.equal((await fetch(new URL('files/clean',fixture.base),{method:'POST',body:'{}'})).status,405);
  assert.equal((await fetch(new URL('files/zip',fixture.base),{method:'POST'})).status,405);
  assert.equal((await fetch(new URL('files/list',fixture.base))).status,404);
  assert.equal(calls.length,1,'only the HTML document reaches the supplied server');
  const refused=await createDownloadFixture({base,key:'wrong'});
  t.after(()=>refused.close());
  const response=await fetch(refused.base);
  assert.equal(response.status,502);
  const message=await response.text();
  assert.doesNotMatch(message,/private failure|fixture-private-key|wrong/);
});
