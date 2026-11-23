const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {employeeInput,receiptInput}=require('../server/validation.cjs');
test('server validates receipt input and normalizes employee identity',()=>{
 assert.equal(employeeInput({full_name:' teste pessoa ',email:'TESTE@EXAMPLE.COM',cpf:'123.456.789-00',job_title:'CLT'}).email,'teste@example.com');
 const valid={id:'11111111-1111-4111-8111-111111111111',employee_id:'22222222-2222-4222-8222-222222222222',period:'2026-11-01',received_on:'2026-11-18',kind:'benefits',amount_cents:100,pdf:Buffer.from('%PDF-1.7\n').toString('base64')};
 assert.equal(receiptInput(valid).amount_cents,100);
 for(const change of [{period:'2026-13-01'},{received_on:'2026-02-30'},{amount_cents:-1},{amount_cents:1.5},{kind:'admin'},{pdf:'<script>'},{employee_id:'other-user'}])assert.throws(()=>receiptInput({...valid,...change}));
});
test('PostgreSQL: isolation and immutable signatures',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
   create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(fs.readFileSync('supabase/migrations/202611180001_portal.sql','utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/202611230001_receipt_workflow.sql','utf8'));
  const alice='10000000-0000-0000-0000-000000000001',bob='10000000-0000-0000-0000-000000000002',admin='10000000-0000-0000-0000-000000000003',ea='20000000-0000-0000-0000-000000000001',eb='20000000-0000-0000-0000-000000000002',ra='30000000-0000-0000-0000-000000000001',rb='30000000-0000-0000-0000-000000000002';
  await db.exec(`insert into auth.users values('${alice}'),('${bob}'),('${admin}');insert into public.app_admins values('${admin}');
   insert into public.employees(id,user_id,full_name,cpf,email,job_title) values('${ea}','${alice}','ALICE','12345678900','alice@example.test','CLT'),('${eb}','${bob}','BOB','98765432100','bob@example.test','CLT');
   insert into public.receipts(id,employee_id,employee_name,employee_cpf,job_title,period,received_on,kind,amount_cents,file_path,file_sha256,created_by) values
   ('${ra}','${ea}','ALICE','12345678900','CLT','2026-10-01','2026-11-01','benefits',10000,'alice.pdf',repeat('a',64),'${admin}'),
   ('${rb}','${eb}','BOB','98765432100','CLT','2026-10-01','2026-11-01','benefits',20000,'bob.pdf',repeat('b',64),'${admin}');`);
  const asUser=async id=>db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false);`);
  const rpc=async(sql,args=[]) => (await db.query(sql,args)).rows[0].result;
  await t.test('anonymous users cannot read receipts',async()=>{await db.exec('set role anon');await assert.rejects(db.query('select * from public.receipts'),/permission denied/);await db.exec('reset role');});
  await t.test('Alice sees only her records and cannot prepare Bob signature',async()=>{
   await asUser(alice);assert.deepEqual((await db.query('select id from public.receipts')).rows.map(r=>r.id),[ra]);assert.deepEqual((await db.query('select id from public.employees')).rows.map(r=>r.id),[ea]);await assert.rejects(db.query('select public.prepare_receipt_signature($1)',[rb]),/indisponível/);
  });
  await t.test('clients cannot promote themselves or directly edit records',async()=>{
   await assert.rejects(db.query('insert into public.app_admins values($1)',[alice]),/permission denied/);await assert.rejects(db.query('update public.receipts set signed_at=now() where id=$1',[ra]),/permission denied/);await assert.rejects(db.query('update public.employees set user_id=$1 where id=$2',[alice,eb]),/permission denied/);
  });
  await t.test('drafts cannot be read or signed; sending and opening are protected',async()=>{
   await db.exec('reset role');await db.query("update public.receipts set status='draft',sent_at=null where id=$1",[ra]);await asUser(alice);
   assert.equal((await db.query('select * from public.receipts')).rows.length,0);
   await assert.rejects(db.query('select public.prepare_receipt_signature($1)',[ra]),/indisponível/);
   await assert.rejects(db.query("select public.receipt_action($1,'send')",[ra]),/negado/);
   await assert.rejects(db.query('select public.prepare_receipt_signature_internal($1)',[ra]),/permission denied/);
   await asUser(admin);await db.query("select public.receipt_action($1,'send')",[ra]);
   await asUser(bob);await assert.rejects(db.query("select public.receipt_action($1,'opened')",[ra]),/negado/);
   await asUser(alice);await db.query("select public.receipt_action($1,'opened')",[ra]);assert.ok((await db.query('select opened_at from public.receipts where id=$1',[ra])).rows[0].opened_at);
  });
  let challenge;
  await t.test('wrong CPF or missing consent cannot sign',async()=>{
   challenge=await rpc('select public.prepare_receipt_signature($1) as result',[ra]);await assert.rejects(db.query('select public.sign_receipt($1,$2,$3,$4)',[ra,challenge.token,'12345678900',false]),/declaração/);
   assert.ok((await rpc('select public.sign_receipt($1,$2,$3,$4) as result',[ra,challenge.token,'00000000000',true])).error);assert.equal((await db.query('select * from public.receipt_signatures')).rows.length,0);
  });
  await t.test('signature preserves hash and uses the server timestamp',async()=>{
   const result=await rpc('select public.sign_receipt($1,$2,$3,$4) as result',[ra,challenge.token,'123.456.789-00',true]);assert.ok(result.signed_at);
   const signature=(await db.query('select * from public.receipt_signatures')).rows[0];assert.equal(signature.document_sha256,'a'.repeat(64));assert.equal(signature.user_id,alice);assert.ok(new Date(signature.signed_at)>=new Date(challenge.presented_at));assert.equal(signature.cpf_last_four,'8900');
   await assert.rejects(db.query('update public.receipt_signatures set signer_name=$1',['BOB']),/permission denied/);await assert.rejects(db.query('delete from public.receipt_signatures'),/permission denied/);
  });
  await t.test('repeat signing is rejected; Bob cannot see Alice evidence',async()=>{
   await assert.rejects(db.query('select public.sign_receipt($1,$2,$3,$4)',[ra,challenge.token,'12345678900',true]),/já foi assinado/);await asUser(bob);assert.equal((await db.query('select * from public.receipt_signatures')).rows.length,0);
  });
  await t.test('expired challenges and repeated wrong CPF attempts are blocked',async()=>{
   let c=await rpc('select public.prepare_receipt_signature($1) as result',[rb]);await db.exec('reset role');await db.query("update public.receipt_signature_challenges set expires_at=now()-interval '1 minute' where receipt_id=$1",[rb]);await asUser(bob);
   await assert.rejects(db.query('select public.sign_receipt($1,$2,$3,$4)',[rb,c.token,'98765432100',true]),/expirada/);c=await rpc('select public.prepare_receipt_signature($1) as result',[rb]);
   for(let i=0;i<5;i++)assert.ok((await rpc('select public.sign_receipt($1,$2,$3,$4) as result',[rb,c.token,'00000000000',true])).error);
   await assert.rejects(db.query('select public.prepare_receipt_signature($1)',[rb]),/15 minutos/);
  });
  await t.test('deactivation removes access; administrator retains all history',async()=>{
   await db.exec('reset role');await db.query('update public.employees set active=false where id=$1',[ea]);await asUser(alice);assert.equal((await db.query('select * from public.receipts')).rows.length,0);
   await asUser(admin);assert.equal((await db.query('select * from public.receipts')).rows.length,2);assert.equal((await db.query('select * from public.receipt_signatures')).rows.length,1);
  });
 }finally{await db.close();}
});
