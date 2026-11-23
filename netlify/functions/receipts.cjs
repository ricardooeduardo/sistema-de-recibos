const { createHash } = require('node:crypto');
const { PDFDocument } = require('pdf-lib');
const { authenticate, json, wrap, body, check } = require('../../server/api.cjs');
const { receiptInput, fail } = require('../../server/validation.cjs');
exports.handler = wrap(async event => {
    if(event.httpMethod !== 'POST') return json(405,{error:'Método não permitido.'});
    const {db,user} = await authenticate(event, true);
    const {pdf, ...values} = receiptInput(body(event));
    const file_sha256 = createHash('sha256').update(pdf).digest('hex');
    const existing = check(await db.from('receipts').select('*').eq('id',values.id).maybeSingle());
    if(existing) {
        if(existing.file_sha256 !== file_sha256 || existing.employee_id !== values.employee_id || existing.period !== values.period || existing.amount_cents !== values.amount_cents || existing.kind !== values.kind || existing.received_on !== values.received_on) fail('Este identificador já pertence a outro recibo.');
        return json(200,{receipt:existing});
    }
    try { const parsed = await PDFDocument.load(pdf); if (!parsed.getPageCount()) fail('PDF sem páginas.'); }
    catch { fail('Não foi possível ler o arquivo PDF.'); }
    const employee = check(await db.from('employees').select('*').eq('id',values.employee_id).eq('active',true).single());
    const file_path = `${employee.id}/${values.id}.pdf`;
    const upload = await db.storage.from('receipt-originals').upload(file_path,pdf,{contentType:'application/pdf',upsert:false});
    if(upload.error) throw upload.error;
    const result = await db.from('receipts').insert({...values,file_path,file_sha256,employee_name:employee.full_name,
        employee_cpf:employee.cpf,job_title:employee.job_title,created_by:user.id}).select().single();
    if(result.error) { await db.storage.from('receipt-originals').remove([file_path]); throw result.error; }
    return json(201,{receipt:result.data});
});
