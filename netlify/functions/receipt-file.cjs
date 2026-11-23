const { createHash } = require('node:crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { authenticate, json, wrap, check } = require('../../server/api.cjs');
const { uuid } = require('../../server/validation.cjs');
exports.handler = wrap(async event => {
    if(event.httpMethod !== 'GET') return json(405,{error:'Método não permitido.'});
    const {db,user,isAdmin} = await authenticate(event);
    const id = uuid(event.queryStringParameters?.id);
    const receipt = check(await db.from('receipts').select('*').eq('id',id).maybeSingle());
    const deny = () => json(404,{error:'Recibo não encontrado.'});
    if(!receipt) return deny();
    if(!isAdmin) {
        const own = check(await db.from('employees').select('id').eq('id',receipt.employee_id).eq('user_id',user.id).eq('active',true).maybeSingle());
        if(!own || receipt.status==='draft' || receipt.status==='deleted') return deny();
    }
    const file = check(await db.storage.from('receipt-originals').download(receipt.file_path));
    let bytes = Buffer.from(await file.arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex') !== receipt.file_sha256) throw new Error('Hash mismatch');
    if(receipt.signed_at) {
        const signature = check(await db.from('receipt_signatures').select('*').eq('receipt_id',id).single());
        const doc = await PDFDocument.load(bytes), font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage([595.28,841.89]);
        let y = 785;
        const text = (value,size=11) => {
            // Helvetica supports Portuguese; normalize unsupported characters without altering database evidence.
            const clean = String(value).replace(/[^\x20-\x7e\xa0-\xff]/g,'?');
            let line = '';
            for(const word of clean.split(' ')) {
                if(font.widthOfTextAtSize(line + word,size) > 490 && line) { page.drawText(line,{x:48,y,size,font,color:rgb(.1,.17,.23)}); y-=18; line=''; }
                line += word+' ';
            }
            page.drawText(line,{x:48,y,size,font,color:rgb(.1,.17,.23)}); y-=25;
        };
        text('REGISTRO DE ASSINATURA',18);
        text('Rocha Cerqueira - Portal de recibos'); y-=12;
        text(`Recibo: ${id}`);
        text(`Colaborador: ${signature.signer_name}`);
        text(`CPF confirmado: ***.***.*${signature.cpf_last_four.slice(0,2)}-${signature.cpf_last_four.slice(2)}`);
        text(`Conta autenticada: ${signature.user_id}`);
        const fmt = value => new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',hour12:false}) + ' (Brasília)';
        text(`Data/hora apresentadas: ${fmt(signature.confirmed_at)}`);
        text(`Assinatura registrada: ${fmt(signature.signed_at)}`);
        text(`Registro UTC: ${signature.signed_at}`); y-=12;
        text('Declaração confirmada:'); text(signature.declaration); y-=12;
        text('SHA-256 do PDF original:',10);
        text(signature.document_sha256.slice(0,32),10); text(signature.document_sha256.slice(32),10);
        text(`Versão da declaração: ${signature.declaration_version}`,10);
        text('Assinatura por confirmação de CPF e aceite em conta autenticada.',10);
        text('O documento original foi preservado; este registro foi anexado ao PDF.',10);
        bytes = Buffer.from(await doc.save());
    }
    return {statusCode:200,headers:{'Content-Type':'application/pdf','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Disposition':`inline; filename="recibo-${id}${receipt.signed_at ? '-assinado' : ''}.pdf"`},isBase64Encoded:true,body:bytes.toString('base64')};
});
