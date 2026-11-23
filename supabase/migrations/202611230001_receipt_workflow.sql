begin;
alter table public.receipts add column status text not null default 'sent' check(status in ('draft','sent','deleted'));
alter table public.receipts add column sent_at timestamptz;
alter table public.receipts add column last_sent_at timestamptz;
alter table public.receipts add column opened_at timestamptz;
alter table public.receipts add column send_count integer not null default 1;
update public.receipts set sent_at=created_at,last_sent_at=created_at;
drop policy receipts_read on public.receipts;
create policy receipts_read on public.receipts for select to authenticated using (public.is_receipts_admin() or (status='sent' and exists(select 1 from public.employees e where e.id=employee_id and e.user_id=auth.uid() and e.active)));
alter function public.prepare_receipt_signature(uuid) rename to prepare_receipt_signature_internal;
alter function public.sign_receipt(uuid,uuid,text,boolean) rename to sign_receipt_internal;
revoke all on function public.prepare_receipt_signature_internal(uuid) from public,anon,authenticated;
revoke all on function public.sign_receipt_internal(uuid,uuid,text,boolean) from public,anon,authenticated;
create function public.prepare_receipt_signature(p_receipt_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$ begin
perform 1 from public.receipts where id=p_receipt_id and status='sent' for update;
if not found then raise exception 'Recibo indisponível.'; end if;
return public.prepare_receipt_signature_internal(p_receipt_id); end; $$;
create function public.sign_receipt(p_receipt_id uuid,p_token uuid,p_cpf text,p_consent boolean) returns jsonb language plpgsql security definer set search_path='' as $$ begin
perform 1 from public.receipts where id=p_receipt_id and status='sent' for update;
if not found then raise exception 'Recibo indisponível.'; end if;
return public.sign_receipt_internal(p_receipt_id,p_token,p_cpf,p_consent); end; $$;
create function public.receipt_action(p_id uuid,p_action text) returns void language plpgsql security definer set search_path='' as $$
declare r public.receipts;
begin
select * into r from public.receipts where id=p_id for update;
if not found then raise exception 'Recibo indisponível.'; end if;
if p_action='opened' then
if r.status<>'sent' or not exists(select 1 from public.employees where id=r.employee_id and user_id=auth.uid() and active) then raise exception 'Acesso negado.'; end if;
update public.receipts set opened_at=coalesce(opened_at,clock_timestamp()) where id=p_id;
else
if not public.is_receipts_admin() then raise exception 'Acesso negado.'; end if;
if p_action='delete' and r.status='draft' then update public.receipts set status='deleted' where id=p_id;
elsif p_action='send' and r.status in ('draft','sent') and r.signed_at is null then
update public.receipts set status='sent',sent_at=coalesce(sent_at,clock_timestamp()),last_sent_at=clock_timestamp(),send_count=case when r.status='draft' then 1 else send_count+1 end where id=p_id;
else raise exception 'Ação indisponível.'; end if;
end if;
end; $$;
revoke all on function public.prepare_receipt_signature(uuid),public.sign_receipt(uuid,uuid,text,boolean),public.receipt_action(uuid,text) from public,anon;
grant execute on function public.prepare_receipt_signature(uuid),public.sign_receipt(uuid,uuid,text,boolean),public.receipt_action(uuid,text) to authenticated;
commit;
