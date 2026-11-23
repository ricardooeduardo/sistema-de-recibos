const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PDFDocument}=require('pdf-lib');
const {createHash}=require('node:crypto');
const vm=require('node:vm');
const fs=require('node:fs');
const api=require('../server/api.cjs');
const id='11111111-1111-4111-8111-111111111111';
async function fixture({owner=true,signed=true,corrupt=false,admin=false}={}) {
 const doc=await PDFDocument.create();doc.addPage();const bytes=Buffer.from(await doc.save());
 const receipt={id,employee_id:id,file_path:'original.pdf',file_sha256:createHash('sha256').update(bytes).digest('hex'),signed_at:signed?'2026-11-18T15:00:00Z':null};
 const signature={signer_name:'PESSOA DE TESTE',cpf_last_four:'8900',user_id:id,confirmed_at:'2026-11-18T14:59:30Z',signed_at:'2026-11-18T15:00:00Z',declaration:'Declaro que conferi o recibo.',document_sha256:receipt.file_sha256,declaration_version:'1'};
 let downloads=0;const errors=[];
 const db={from(table){const q={select(){return q;},eq(){return q;},async maybeSingle(){return {data:table==='receipts'?receipt:owner?{id}:null};},async single(){return {data:signature};}};return q;},storage:{from(){return {async download(){downloads++;return {data:new Blob([corrupt?Buffer.from('corrupted'):bytes])};}};}}};
 const injectedRequire=name=>name==='../../server/api.cjs'?{...api,wrap:handler=>api.wrap(async event=>{try{return await handler(event);}catch(e){errors.push(e.stack);throw e;}}),authenticate:async()=>({db,user:{id},isAdmin:admin})}:name==='../../server/validation.cjs'?require('../server/validation.cjs'):require(name);
 const exported={};
 const load=vm.runInThisContext('(function(require,exports,Buffer){'+fs.readFileSync('netlify/functions/receipt-file.cjs','utf8')+'\n})');
 load(injectedRequire,exported,Buffer);
 return {call:()=>exported.handler({httpMethod:'GET',queryStringParameters:{id}}),downloads:()=>downloads,bytes,errors};
}
test('receipt-file appends the authoritative signature record to a valid original PDF',async()=>{
 const f=await fixture();const result=await f.call();assert.equal(result.statusCode,200,f.errors.join('\n'));assert.equal(result.headers['Cache-Control'],'no-store');
 const signed=await PDFDocument.load(Buffer.from(result.body,'base64'));assert.equal(signed.getPageCount(),2);
});
test('pending receipt download preserves the original bytes',async()=>{
 const f=await fixture({signed:false});const result=await f.call();assert.equal(result.statusCode,200);assert.deepEqual(Buffer.from(result.body,'base64'),f.bytes);
});
test('another employee cannot download a receipt even with its UUID',async()=>{
 const f=await fixture({owner:false});const result=await f.call();assert.equal(result.statusCode,404);assert.equal(f.downloads(),0);
});
test('a changed original PDF cannot be served with valid signature evidence',async()=>{
 const f=await fixture({corrupt:true});const result=await f.call();assert.equal(result.statusCode,500);assert.equal(result.isBase64Encoded,undefined);
});
