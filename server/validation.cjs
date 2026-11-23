const fail = message => { const e = new Error(message); e.status = 400; throw e; };
const uuid = value => {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail('Identificador inválido.');
    return value;
};
function employeeInput(body) {
    const full_name = String(body.full_name || '').trim().replace(/\s+/g, ' ').toUpperCase();
    const cpf = String(body.cpf || '').replace(/\D/g, '');
    const email = String(body.email || '').trim().toLowerCase();
    const job_title = String(body.job_title || '').trim();
    if (full_name.length < 2 || full_name.length > 120) fail('Informe um nome entre 2 e 120 caracteres.');
    if (!/^\d{11}$/.test(cpf)) fail('Informe um CPF com 11 dígitos.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail('Informe um e-mail válido.');
    if (!job_title || job_title.length > 80) fail('Informe um cargo de até 80 caracteres.');
    return { full_name, cpf, email, job_title };
}
function receiptInput(body) {
    const id = uuid(body.id), employee_id = uuid(body.employee_id);
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(body.period || '')) fail('Competência inválida.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.received_on || '') || Number.isNaN(Date.parse(body.received_on)) || new Date(body.received_on).toISOString().slice(0,10) !== body.received_on) fail('Data de recebimento inválida.');
    if (!['participation','benefits'].includes(body.kind)) fail('Tipo de recibo inválido.');
    if (!Number.isSafeInteger(body.amount_cents) || body.amount_cents <= 0 || body.amount_cents > 99999999999) fail('Informe um valor positivo para o recibo.');
    if (typeof body.pdf !== 'string' || body.pdf.length > 4194304 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.pdf)) fail('PDF inválido ou maior que 3 MB.');
    const pdf = Buffer.from(body.pdf, 'base64');
    if (pdf.length > 3145728 || pdf.subarray(0,5).toString() !== '%PDF-') fail('Envie um arquivo PDF de até 3 MB.');
    return { id, employee_id, period:body.period, received_on:body.received_on, kind:body.kind, amount_cents:body.amount_cents, pdf };
}
module.exports = { fail, uuid, employeeInput, receiptInput };
