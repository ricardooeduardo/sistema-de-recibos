const { createClient } = require('@supabase/supabase-js');
function client() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const e = new Error('O portal ainda não foi configurado no servidor.'); e.status = 503; throw e;
    }
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession:false, autoRefreshToken:false } });
}
async function authenticate(event, adminOnly = false) {
    const db = client();
    const token = (event.headers.authorization || '').match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw Object.assign(new Error('Entre na sua conta.'), {status:401});
    const {data, error} = await db.auth.getUser(token);
    if (error || !data.user) throw Object.assign(new Error('Sessão expirada. Entre novamente.'), {status:401});
    const {data:admin, error:roleError} = await db.from('app_admins').select('user_id').eq('user_id', data.user.id).maybeSingle();
    if (roleError) throw roleError;
    if (adminOnly && !admin) throw Object.assign(new Error('Acesso exclusivo da administração.'), {status:403});
    return {db, user:data.user, isAdmin:Boolean(admin)};
}
const json = (statusCode, body) => ({statusCode, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}, body:JSON.stringify(body)});
const wrap = handler => async event => {
    try { return await handler(event); }
    catch(e) {
        if (e.code === '23505') return json(409,{error:'Já existe um cadastro com esse nome, CPF ou e-mail.'});
        return json(e.status || 500,{error:e.status ? e.message : 'Não foi possível concluir a operação. Tente novamente.'});
    }
};
function body(event) {
    try {
        const value=JSON.parse(event.body || '{}');
        if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error();
        return value;
    } catch { throw Object.assign(new Error('Dados inválidos.'),{status:400}); }
}
function check(result) { if(result.error) throw result.error; return result.data; }
module.exports = { authenticate, json, wrap, body, check };
