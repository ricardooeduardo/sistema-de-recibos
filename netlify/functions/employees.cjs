const { authenticate, json, wrap, body, check } = require('../../server/api.cjs');
const { employeeInput, uuid, fail } = require('../../server/validation.cjs');
exports.handler = wrap(async event => {
    const {db} = await authenticate(event, true);
    const input = body(event);
    const redirectTo = process.env.APP_URL && new URL('/recibos?ativar=1', process.env.APP_URL).href;
    if (!redirectTo) throw Object.assign(new Error('Configure APP_URL no servidor.'), {status:503});
    if (event.httpMethod === 'POST' && input.action === 'access-link') {
        const employee = check(await db.from('employees').select('*').eq('id', uuid(input.id)).single());
        if (!employee.active) fail('Reative o colaborador antes de gerar o acesso.');
        const link = check(await db.auth.admin.generateLink({type:'recovery',email:employee.email,options:{redirectTo}}));
        return json(200,{access_url:link.properties.action_link});
    }
    if (event.httpMethod === 'PATCH') {
        const id = uuid(input.id);
        const current = check(await db.from('employees').select('*').eq('id',id).single());
        if (typeof input.active === 'boolean') {
            return json(200,{employee:check(await db.from('employees').update({active:input.active}).eq('id',id).select().single())});
        }
        const values = employeeInput(input);
        if (values.email !== current.email) fail('O e-mail de acesso não pode ser alterado neste formulário.');
        return json(200,{employee:check(await db.from('employees').update(values).eq('id',id).select().single())});
    }
    if (event.httpMethod !== 'POST') return json(405,{error:'Método não permitido.'});
    const values = employeeInput(input);
    // Check duplicates before provisioning. Database constraints cover concurrent requests.
    for (const field of ['cpf','email','full_name']) {
        const found = check(await db.from('employees').select('id').eq(field, values[field]).maybeSingle());
        if (found) throw Object.assign(new Error('Já existe um cadastro com esse nome, CPF ou e-mail.'),{status:409});
    }
    const authResult = await db.auth.admin.createUser({email:values.email, password:require('node:crypto').randomBytes(48).toString('base64url'),email_confirm:true});
    if (authResult.error) throw Object.assign(new Error('Não foi possível criar o acesso. Verifique se o e-mail já está cadastrado no Supabase.'),{status:409});
    const userId = authResult.data.user.id;
    const insert = await db.from('employees').insert({...values,user_id:userId}).select().single();
    if (insert.error) { await db.auth.admin.deleteUser(userId); throw insert.error; }
    // A link is returned for manual delivery, never emailed by this function.
    const link = await db.auth.admin.generateLink({type:'recovery',email:values.email,options:{redirectTo}});
    return json(201,{employee:insert.data,access_url:link.data?.properties?.action_link || null,
        warning:link.error ? 'Cadastro criado. Use “Gerar acesso” para obter o link de definição de senha.' : null});
});
