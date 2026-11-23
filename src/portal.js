import { createClient } from '@supabase/supabase-js';
import './portal.css';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const configured = /^https?:\/\//.test(url || '') && key && !url.includes('YOUR_PROJECT') && !key.startsWith('YOUR_');
const db = configured ? createClient(url,key) : null;
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => (Number(cents)/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const dateTime = value => new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',hour12:false}) + ' (Brasília)';
const period = value => value.slice(0,7).split('-').reverse().join('/');
const cpfMask = cpf => String(cpf).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/,'$1.$2.$3-$4');
let identity = null, employees = [], receipts = [], activeReceipt = null, challenge = null, documentUrl = null, pendingReceipt = null, pendingImport = null;
let historyMode='sent', calendarMonth=new Date().toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'}).slice(0,7), selectedDay=null;
let receiptRequest = 0, sessionVersion = 0, legacy = [], submitting = false;
function message(id,text,error=false) { const el=$(id); el.textContent=text; el.classList.toggle('hidden',!text); el.classList.toggle('error',error); }
function requireAdmin() { if(!identity?.admin) throw new Error('Acesso exclusivo da administração.'); }
async function api(path, options={}) {
    if(!db) throw new Error('O portal ainda não foi configurado.');
    const {data:{session}} = await db.auth.getSession();
    if(!session) throw new Error('Sua sessão expirou. Entre novamente.');
    const response = await fetch(`/.netlify/functions/${path}`,{...options,headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json',...options.headers}});
    if(!response.ok) {
        const result = await response.json().catch(()=>({}));
        throw Object.assign(new Error(result.error || 'Falha na comunicação com o servidor.'),{status:response.status});
    }
    return response;
}
async function apiJson(path,payload,method='POST') { return (await api(path,{method,body:JSON.stringify(payload)})).json(); }
async function setIdentity(session) {
    const version=++sessionVersion;
    identity=null;
    if(!session) return;
    const [role, employee] = await Promise.all([
        db.from('app_admins').select('user_id').eq('user_id',session.user.id).maybeSingle(),
        db.from('employees').select('*').eq('user_id',session.user.id).eq('active',true).maybeSingle()
    ]);
    if(role.error || employee.error) throw new Error('Não foi possível verificar o acesso. Confira a configuração do banco.');
    if(!role.data && !employee.data) throw new Error('Esta conta não possui um perfil ativo. Contate a administração.');
    if(version!==sessionVersion) return;
    identity={id:session.user.id,admin:Boolean(role.data),employee:employee.data};
    $('portal-account-name').textContent=employee.data?.full_name || 'Administração';
    document.querySelectorAll('[data-admin-only]').forEach(el=>el.classList.toggle('hidden',!identity.admin));
    if(identity.admin) await refreshEmployees();
}
async function init() {
    if(!configured) {
        message('portal-configuration','O acesso aos recibos ainda não foi ativado. Entre em contato com a administração para saber quando estará disponível.');
        $('login-submit').disabled=true;
        window.showView('login');
        return;
    }
    try {
        const {data:{session},error}=await db.auth.getSession();
        if(error) throw error;
        await setIdentity(session);
        const activation = new URLSearchParams(location.search).has('ativar');
        if(session && activation) window.showView('password');
        else route();
        db.auth.onAuthStateChange((event,session)=> {
            // Never await another Auth method inside this callback.
            if(event==='SIGNED_OUT') { clearSession(); window.showView('login'); }
            if(event==='PASSWORD_RECOVERY') setTimeout(async()=>{
                try { await setIdentity(session); window.showView('password'); }
                catch(e) { message('login-error',e.message,true); }
            },0);
        });
    } catch(e) { identity=null; window.showView('login'); message('login-error',e.message,true); }
}
function clearSession() {
    ++sessionVersion; ++receiptRequest; identity=null; employees=[]; receipts=[]; pendingReceipt=null; pendingImport=null;
    window.replaceEmployees([]); $('portal-list').replaceChildren();
    closeReceipt();
    if($('access-dialog').open) $('access-dialog').close();
    $('access-url').value='';
    $('login-password').value='';
    $('receipt-filter-name').value=''; $('receipt-filter-month').value=''; $('receipt-filter-status').value='';
}
function route() {
    if(!identity) return window.showView('login');
    if(!identity.admin || location.pathname.startsWith('/recibos')) return window.showView('receipts');
    window.showView(location.pathname.endsWith('/admin') || location.hash==='#admin' ? 'admin':'home');
}
async function login() {
    if(!db || submitting) return;
    submitting=true; $('login-submit').disabled=true; message('login-error','');
    try {
        const {data,error}=await db.auth.signInWithPassword({email:$('login-email').value.trim(),password:$('login-password').value});
        if(error) throw new Error('E-mail ou senha inválidos.');
        await setIdentity(data.session); $('login-password').value=''; route();
    } catch(e) { identity=null; message('login-error',e.message,true); }
    finally { submitting=false; $('login-submit').disabled=false; }
}
async function logout() {
    if(db) await db.auth.signOut({scope:'local'});
    clearSession(); history.replaceState({},'', '/recibos'); window.showView('login');
}
async function savePassword(event) {
    event.preventDefault();
    const password=$('new-password').value;
    if(password.length<6) return message('password-error','Use pelo menos 6 caracteres.',true);
    if(password!==$('confirm-password').value) return message('password-error','As senhas não coincidem.',true);
    $('password-submit').disabled=true;
    try {
        const {error}=await db.auth.updateUser({password});
        if(error) throw new Error('Não foi possível salvar a senha. Use uma senha mais forte ou solicite um novo link.');
        $('new-password').value=''; $('confirm-password').value='';
        history.replaceState({},'', '/recibos'); route();
    } catch(e) { message('password-error',e.message,true); }
    finally { $('password-submit').disabled=false; }
}
async function refreshEmployees() {
    requireAdmin();
    const {data,error}=await db.from('employees').select('*').order('full_name');
    if(error) throw new Error('Não foi possível carregar os colaboradores.');
    employees=data;
    const importSelect=$('import-employee');
    const selected=importSelect.value;
    importSelect.replaceChildren(new Option('Selecione o colaborador…',''));
    data.filter(e=>e.active).forEach(e=>importSelect.add(new Option(e.full_name,e.id)));
    importSelect.value=selected;
    const inactive=$('show-inactive')?.checked;
    window.replaceEmployees(data.filter(e=>inactive || e.active));
}
function employeeByName(name) { return employees.find(e=>e.full_name===name); }
async function saveEmployee(values,id) {
    requireAdmin();
    const result=await apiJson('employees',{...values,...(id?{id}:{})},id?'PATCH':'POST');
    await refreshEmployees();
    if(result.access_url) showAccess(result.access_url);
    if(result.warning) window.showToast(result.warning);
    return result.employee;
}
async function setActive(id,active) { requireAdmin(); await apiJson('employees',{id,active},'PATCH'); await refreshEmployees(); }
function showAccess(link) { $('access-url').value=link; message('access-feedback',''); $('access-dialog').showModal(); }
async function accessLink(id) {
    try { requireAdmin(); const result=await apiJson('employees',{action:'access-link',id}); showAccess(result.access_url); }
    catch(e) { window.showToast(e.message); }
}
async function copyAccess() {
    try { await navigator.clipboard.writeText($('access-url').value); message('access-feedback','Link copiado. Entregue-o somente ao titular deste cadastro.'); }
    catch { $('access-url').select(); message('access-feedback','Selecione e copie o link acima.'); }
}
async function issueReceipt(payload) {
    requireAdmin();
    pendingReceipt=payload;
    try {
        const result=await apiJson('receipts',payload);
        pendingReceipt=null;
        return result.receipt;
    } catch(e) {
        if(e.status && e.status<500 && e.status!==429) pendingReceipt=null;
        throw e;
    }
}
async function importReceipt(event) {
    event.preventDefault();
    if(submitting) return;
    submitting=true; $('import-submit').disabled=true; message('import-error','');
    try {
        requireAdmin();
        const file=$('import-file').files[0];
        if(!file || file.size>3145728) throw new Error('Selecione um PDF de até 3 MB.');
        const pdf=await new Promise((resolve,reject)=>{
            const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Não foi possível ler o arquivo.'));reader.readAsDataURL(file);
        });
        // Reuse the previous ID after an ambiguous network failure.
        pendingImport ||= {id:crypto.randomUUID(),employee_id:$('import-employee').value,period:$('import-period').value+'-01',received_on:$('import-date').value,
            kind:$('import-kind').value,amount_cents:Math.round(Number($('import-amount').value)*100),pdf};
        await apiJson('receipts',pendingImport); pendingImport=null;
        $('import-form').reset();window.showToast('PDF incluído no histórico e disponível para assinatura.');await loadReceipts();
    } catch(e) {
        if(e.status && e.status<500 && e.status!==429) pendingImport=null;
        message('import-error',e.message+(pendingImport?' Clique em importar novamente para reenviar o mesmo documento.':''),true);
    }
    finally { submitting=false; $('import-submit').disabled=false; }
}
async function retryReceipt() {
    if(!pendingReceipt) return;
    const record=await issueReceipt(pendingReceipt);
    window.showToast('Recibo salvo no portal. Ele está disponível no histórico.');
    return record;
}
async function loadReceipts() {
    if(!identity) return;
    const request=++receiptRequest;
    $('portal-list').innerHTML='<p class="portal-empty" role="status">Carregando recibos…</p>';
    message('portal-error','');
    $('receipts-heading').textContent=identity.admin?'Histórico de recibos':'Meus recibos';
    $('receipts-description').textContent=identity.admin?'Acompanhe os documentos emitidos e as assinaturas da equipe.':'Consulte os documentos de outros meses e assine os recibos pendentes.';
    try {
        let query=db.from('receipts').select('*, receipt_signatures(*)').order('period',{ascending:false}).order('created_at',{ascending:false});
        query=query.neq('status','deleted');
        if(!identity.admin) query=query.eq('employee_id',identity.employee.id);
        const month=$('receipt-filter-month').value, status=$('receipt-filter-status').value;
        if(month) query=query.eq('period',month+'-01');
        if(status==='pending') query=query.is('signed_at',null);
        if(status==='signed') query=query.not('signed_at','is',null);
        // Fetch in pages: history is never silently limited to Supabase's default 1000 rows.
        let rows=[], offset=0;
        while(true) {
            const {data,error}=await query.range(offset,offset+199);
            if(error) throw new Error('Não foi possível carregar o histórico. Tente novamente.');
            rows.push(...data); if(data.length<200) break; offset+=200;
        }
        if(request!==receiptRequest || !identity) return;
        const search=$('receipt-filter-name').value.trim().toLocaleLowerCase('pt-BR');
        receipts=rows.filter(r=>!search || r.employee_name.toLocaleLowerCase('pt-BR').includes(search));
        renderReceipts();
    } catch(e) { if(request!==receiptRequest) return; $('portal-list').replaceChildren(); message('portal-error',e.message,true); }
}
function renderReceipts() {
    $('receipts-total').textContent=receipts.length;
    $('receipts-pending').textContent=receipts.filter(r=>r.status!=='draft' && !r.signed_at).length;
    $('receipts-signed').textContent=receipts.filter(r=>r.signed_at).length;
    $('portal-list').replaceChildren();
    
    let target=$('portal-list');
    if(identity.admin) {
        const tabs=document.createElement('div'); tabs.className='portal-receipt-actions';
        for(const [value,label] of [['sent','Enviados · calendário'],['draft','Rascunhos']]) { const b=document.createElement('button'); b.className='portal-button'; b.textContent=label; b.onclick=()=>{historyMode=value;renderReceipts();}; tabs.append(b); } target.append(tabs);
    }
    const groups=new Map();
    if(identity.admin && historyMode==='sent'){
      const calendar=document.createElement('section');calendar.className='receipt-calendar';
      const nav=document.createElement('div');nav.className='calendar-nav';
      const month=document.createElement('input');month.type='month';month.value=calendarMonth;month.setAttribute('aria-label','Mês de envio');month.onchange=()=>{if(month.value){calendarMonth=month.value;selectedDay=null;renderReceipts();}};
      const title=document.createElement('h3');title.textContent='Calendário de envios';nav.append(title,month);calendar.append(nav);
      const grid=document.createElement('div');grid.className='calendar-grid';
      for(const label of ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']){const el=document.createElement('strong');el.textContent=label;grid.append(el);}
      const [year,m]=calendarMonth.split('-').map(Number);const first=new Date(year,m-1,1).getDay();
      for(let i=0;i<first;i++)grid.append(document.createElement('span'));
      for(let d=1;d<=new Date(year,m,0).getDate();d++){const key=calendarMonth+'-'+String(d).padStart(2,'0');const count=receipts.filter(r=>r.status==='sent' && new Date(r.sent_at||r.created_at).toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'})===key).length;const b=document.createElement('button');b.disabled=count===0;b.className='calendar-cell'+(selectedDay===key?' selected':'');b.textContent=d+(count?' · '+count:'');b.setAttribute('aria-label',key+': '+count+' recibos');b.setAttribute('aria-pressed',String(selectedDay===key));b.onclick=()=>{selectedDay=key;renderReceipts();};grid.append(b);}
      calendar.append(grid);const hint=document.createElement('p');hint.textContent=selectedDay?'Envios de '+selectedDay.split('-').reverse().join('/'):'Selecione um dia para consultar os recibos enviados.';calendar.append(hint);target.append(calendar);
    }

    for(const r of receipts.filter(r=>!identity.admin || ((r.status||'sent')===historyMode && (historyMode==='draft' || (selectedDay && new Date(r.sent_at||r.created_at).toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'})===selectedDay))))) {
        if(identity.admin){const day=historyMode==='draft'?'Rascunhos em espera':new Date(r.sent_at||r.created_at).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});if(!groups.has(day)){const group=document.createElement('details');group.className='portal-day';group.open=true;const title=document.createElement('summary');title.textContent=day;group.append(title);target.append(group);groups.set(day,group);} }

        const card=document.createElement('article'); card.className='portal-receipt';
        card.innerHTML=`<div><span class="receipt-status ${r.signed_at?'signed':''}">${r.status==='draft'?'Rascunho':r.signed_at?'Assinado':'Pendente de assinatura'}</span><h3>${r.kind==='benefits'?'Benefícios':'Participação nos lucros'} · ${period(r.period)}</h3><p>${escape(r.employee_name)}</p><p>${r.signed_at?'Assinado em '+dateTime(r.signed_at):'Emitido em '+dateTime(r.created_at)}</p></div><div class="portal-receipt-actions"><strong>${money(r.amount_cents)}</strong><button class="portal-button primary">${!r.signed_at && identity.employee?.id===r.employee_id?'Conferir e assinar':'Abrir recibo'}</button></div>`;
        card.querySelector('button').addEventListener('click',()=>openReceipt(r));
        if(identity.admin){
 const info=document.createElement('p');info.textContent=r.status==='draft'?'Rascunho · não enviado':('Enviado: '+dateTime(r.sent_at||r.created_at)+' · '+(r.opened_at?'Aberto em '+dateTime(r.opened_at):'Ainda não aberto')+(r.last_sent_at?' · Último envio: '+dateTime(r.last_sent_at):''));card.append(info);
 for(const [action,label] of (r.status==='draft'?[['send','Confirmar e enviar'],['delete','Excluir rascunho']]:!r.signed_at?[['send','Reenviar']]:[])){const b=document.createElement('button');b.className='portal-button';b.textContent=label;b.onclick=async()=>{b.disabled=true;try{const {error}=await db.rpc('receipt_action',{p_id:r.id,p_action:action});if(error)throw error;await loadReceipts();}catch(e){window.showToast(e.message);b.disabled=false;}};card.append(b);}
 const day=historyMode==='draft'?'Rascunhos em espera':new Date(r.sent_at||r.created_at).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});groups.get(day).append(card);
 }else target.append(card);
    }
}
async function openReceipt(receipt) {
    closeReceipt(); activeReceipt=receipt;
    $('receipt-dialog-title').textContent=`${period(receipt.period)} · ${money(receipt.amount_cents)}`;
    $('receipt-dialog').showModal(); message('signature-error','');
    $('signature-form').classList.add('hidden'); $('signature-result').classList.add('hidden');
    $('receipt-download').classList.add('hidden'); message('receipt-document-status','Carregando documento…');
    try {
        const response=await api(`receipt-file?id=${encodeURIComponent(receipt.id)}`);
        const blob=await response.blob();
        if(activeReceipt?.id!==receipt.id) return;
        if(identity.employee?.id===receipt.employee_id){const {error}=await db.rpc('receipt_action',{p_id:receipt.id,p_action:'opened'});if(error)throw error;}
        documentUrl=URL.createObjectURL(blob); $('receipt-preview').src=documentUrl;
        $('receipt-download').href=documentUrl; $('receipt-download').download=`recibo-${receipt.id}${receipt.signed_at?'-assinado':''}.pdf`; $('receipt-download').classList.remove('hidden');
        message('receipt-document-status','Confira o PDF abaixo. Se o navegador não exibir o documento, use “Baixar PDF”.');
        if(receipt.signed_at) {
            $('signature-result').textContent=`Assinado por ${receipt.employee_name} em ${dateTime(receipt.signed_at)}. O PDF inclui o registro de assinatura.`;
            $('signature-result').classList.remove('hidden');
        } else if(receipt.status!=='draft' && identity.employee?.id===receipt.employee_id) {
            const {data,error}=await db.rpc('prepare_receipt_signature',{p_receipt_id:receipt.id});
            if(error) throw new Error(error.message);
            if(activeReceipt?.id!==receipt.id) return;
            challenge=data;
            $('signature-cpf').value=''; $('signature-consent').checked=false;
            $('signature-time').textContent=dateTime(data.presented_at);
            $('signature-declaration').textContent=data.declaration;
            $('signature-form').classList.remove('hidden');
        }
    } catch(e) { message('signature-error',e.message,true); }
}
function closeReceipt() {
    activeReceipt=null; challenge=null;
    if($('receipt-dialog')?.open) $('receipt-dialog').close();
    if($('receipt-preview')) $('receipt-preview').removeAttribute('src');
    if(documentUrl) URL.revokeObjectURL(documentUrl); documentUrl=null;
}
async function signReceipt(event) {
    event.preventDefault();
    if(!activeReceipt || !challenge || submitting) return;
    submitting=true; $('signature-submit').disabled=true;
    const receipt=activeReceipt;
    try {
        const {data,error}=await db.rpc('sign_receipt',{p_receipt_id:receipt.id,p_token:challenge.token,p_cpf:$('signature-cpf').value,p_consent:$('signature-consent').checked});
        if(error || data?.error) throw new Error(error?.message || data.error);
        window.showToast('Recibo assinado com sucesso.');
        await loadReceipts();
        await openReceipt({...receipt,signed_at:data.signed_at});
    } catch(e) { message('signature-error',e.message,true); }
    finally { submitting=false; $('signature-submit').disabled=false; }
}
function loadLegacy() {
    requireAdmin();
    try {
        const people=JSON.parse(localStorage.getItem('rc_colaboradores')||'{}');
        const roles=JSON.parse(localStorage.getItem('rc_cargos')||'{}');
        legacy=Object.entries(people).map(([name,cpf])=>({full_name:name,cpf,job_title:roles[name]||'Colaborador'}));
        renderLegacy();
    } catch { message('legacy-message','Não foi possível ler os cadastros antigos deste navegador.',true); }
}
function renderLegacy() {
    const select=$('legacy-person'); select.replaceChildren(new Option('Selecione um cadastro para migrar…',''));
    legacy.forEach((e,index)=>select.add(new Option(e.full_name,String(index))));
    message('legacy-message',`${legacy.length} cadastros encontrados. Migre cada pessoa informando o e-mail de acesso.`);
}
async function readLegacyFile(event) {
    requireAdmin();
    try {
        const file=event.target.files[0]; if(!file) return;
        if(file.size>1048576) throw new Error('Arquivo maior que 1 MB.');
        const data=JSON.parse(await file.text());
        if(!Array.isArray(data) || data.some(e=>typeof e.full_name!=='string' || typeof e.cpf!=='string')) throw new Error('Formato inválido. Selecione o backup JSON dos colaboradores.');
        legacy=data; renderLegacy();
    } catch(e) { message('legacy-message',e.message,true); }
}
function migratePerson() {
    const value=$('legacy-person').value; if(value==='') return;
    const person=legacy[Number(value)]; if(!person) return;
    window.openAddColaboradorModal();
    $('form-colaborador-nome').value=person.full_name;
    $('form-colaborador-cpf').value=cpfMask(person.cpf.replace(/\D/g,''));
    const select=$('form-colaborador-cargo');
    if(!Array.from(select.options).some(o=>o.value===person.job_title)) select.add(new Option(person.job_title,person.job_title));
    select.value=person.job_title;
}
window.Portal={init,login,logout,route,refreshEmployees,employeeByName,saveEmployee,setActive,accessLink,copyAccess,issueReceipt,retryReceipt,loadReceipts,closeReceipt,
    get identity(){return identity;},get pendingReceipt(){return pendingReceipt;},get configured(){return configured;}};
document.addEventListener('DOMContentLoaded',()=>{
    $('password-form').addEventListener('submit',savePassword);
    $('signature-form').addEventListener('submit',signReceipt);
    $('import-form').addEventListener('submit',importReceipt);
    $('receipt-dialog').addEventListener('cancel',event=>{event.preventDefault();closeReceipt();});
    $('receipt-filters').addEventListener('submit',event=>{event.preventDefault();loadReceipts();});
    $('legacy-local').addEventListener('click',loadLegacy); $('legacy-file').addEventListener('change',readLegacyFile); $('legacy-import').addEventListener('click',migratePerson);
    $('show-inactive').addEventListener('change',()=>refreshEmployees().catch(e=>window.showToast(e.message)));
    $('copy-access').addEventListener('click',copyAccess);
    $('close-access').addEventListener('click',()=>{$('access-dialog').close();$('access-url').value='';});
    window.addEventListener('popstate',route);
});
