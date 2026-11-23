const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const script=[...fs.readFileSync('index.html','utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
function setup() {
 const elements=new Map(), storage=new Map(), rows=[];
 const el=id=>{if(!elements.has(id)){const classes=new Set();elements.set(id,{value:'',innerText:'',textContent:'',innerHTML:'',options:[],classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v),toggle:(v,a)=>a?classes.add(v):classes.delete(v)},add(o){this.options.push(o);},replaceChildren(){this.options=[];},focus(){},checkValidity(){return Boolean(this.value);},reportValidity(){}});}return elements.get(id);};
 let downloads=0;const issued=[];
 const portal={identity:{admin:true},loadReceipts(){},employeeByName:n=>rows.find(e=>e.full_name===n),async issueReceipt(p){issued.push(p);},async saveEmployee(values,id){
  if(rows.some(r=>r.full_name===values.full_name&&r.id!==id))throw new Error('Nome duplicado no servidor.');
  const record={...values,id:id||String(rows.length+1),active:true},index=rows.findIndex(r=>r.id===id);
  if(index>=0)rows[index]=record;else rows.push(record);context.newRows=rows;vm.runInContext('replaceEmployees(newRows)',context);return record;
 }};
 const context=vm.createContext({document:{body:el('body'),getElementById:el,querySelector:()=>el('submit'),querySelectorAll:()=>[],addEventListener(){}},
 window:{Portal:portal,location:{pathname:'/'},history:{pushState(){}},scrollTo(){},addEventListener(){},jspdf:{jsPDF:class{addImage(){}save(){downloads++;}output(){return 'data:application/pdf;base64,JVBERi0=';}}}},
 crypto:{randomUUID:()=>require('node:crypto').randomUUID()},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},Option:function(text,value){this.text=text;this.value=value;},html2canvas:async()=>({height:800,width:600,toDataURL:()=>''}),console,alert:()=>{},setTimeout});
 vm.runInContext(script,context);vm.runInContext('showToast=()=>{};renderAdminTable=()=>{};',context);
 return{portal,rows,el,storage,run:code=>vm.runInContext(code,context),downloads:()=>downloads,issued};
}
function fill(a,name,role='CLT'){a.el('form-colaborador-nome').value=name;a.el('form-colaborador-cpf').value='123.456.789-00';a.el('form-colaborador-email').value='test@example.com';a.el('form-colaborador-cargo').value=role;}
test('custom role and email are persisted through the server, not legacy local storage',async()=>{
 const a=setup();fill(a,'TESTE','__novo__');a.el('novo-cargo').value='Consultor jurídico';await a.run('saveColaboradorSubmit()');a.run('openEditColaboradorModal("TESTE")');
 assert.equal(a.el('form-colaborador-cargo').value,'Consultor jurídico');assert.equal(a.rows[0].email,'test@example.com');assert.equal(a.storage.get('rc_colaboradores'),undefined);
});
test('rename keeps identity and server rejection preserves existing people',async()=>{
 const a=setup();fill(a,'ANTIGO');await a.run('saveColaboradorSubmit()');a.run('openAddColaboradorModal()');fill(a,'OUTRO');await a.run('saveColaboradorSubmit()');
 a.run('openEditColaboradorModal("ANTIGO")');a.el('nome').value='ANTIGO';a.el('form-colaborador-nome').value='NOVO';await a.run('saveColaboradorSubmit()');assert.equal(a.el('nome').value,'NOVO');assert.equal(a.rows[0].id,'1');
 a.run('openEditColaboradorModal("NOVO")');a.el('form-colaborador-nome').value='OUTRO';await a.run('saveColaboradorSubmit()');assert.equal(a.rows[0].full_name,'NOVO');assert.match(a.el('colaborador-error').textContent,/duplicado/);
});
test('PDF download is independent from drafts and sending',async()=>{
 const a=setup();fill(a,'TESTE');await a.run('saveColaboradorSubmit()');a.el('nome').value='TESTE';a.el('data-recebimento').value='2024-02-29';a.el('competencia-recibo').value='2024-01';
 a.run(`document.querySelectorAll = s => ['.valor-adiantamento','.valor-beneficio'].includes(s) ? [{value:'10',closest:()=>({cells:[{}, {innerText:'Teste',querySelector:()=>({value:'Teste'})}, {querySelector:()=>({value:''})}]})}] : []`);
 for(const module of ['participation','benefits']){await a.run(`currentModule='${module}';generatePDF()`);assert.equal(a.el('pdf-receipt-date').innerText,'29 de fevereiro de 2024');assert.equal(a.el('pdf-periodo').innerText,'01/2024');}
 assert.equal(a.downloads(),2);assert.equal(a.issued.length,0);
 await a.run("generatePDF('draft')");await a.run("generatePDF('send')");assert.equal(a.downloads(),2);assert.equal(a.issued.length,2);assert.equal(a.issued[0].status,'draft');assert.equal(a.issued[1].status,'sent');assert.equal(a.issued[0].amount_cents,1000);assert.equal(a.issued[0].period,'2024-01-01');
 a.portal.issueReceipt=async()=>{throw new Error('offline');};a.run('console.error=()=>{}');await a.run("generatePDF('send')");assert.equal(a.downloads(),2);assert.equal(a.el('btn-generate').disabled,false);
 a.el('data-recebimento').value='';await a.run('generatePDF()');assert.equal(a.downloads(),2);
});
test('employee routes hide administration and legacy session flags no longer authenticate',()=>{
 const a=setup();a.portal.identity={admin:false};
 for(const view of ['home','admin','participation','benefits']){a.run(`showView('${view}')`);assert.equal(a.el('view-receipts').classList.contains('hidden'),false);assert.equal(a.el('view-admin').classList.contains('hidden'),true);assert.equal(a.el('module-container').classList.contains('hidden'),true);}
 a.portal.identity=null;a.storage.set('rc_session','active');a.storage.set('rc_role','admin');a.run("showView('admin')");assert.equal(a.el('view-login').classList.contains('hidden'),false);assert.equal(a.el('navbar').classList.contains('hidden'),true);
});
