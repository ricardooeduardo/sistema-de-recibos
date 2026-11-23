-- Run once in the Supabase SQL editor, or through `supabase db push`.
create table public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.app_admins enable row level security;
create policy admin_self_read on public.app_admins for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.app_admins from anon, authenticated;
grant select on public.app_admins to authenticated;

create function public.is_receipts_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.app_admins where user_id = auth.uid());
$$;
revoke all on function public.is_receipts_admin() from public, anon;
grant execute on function public.is_receipts_admin() to authenticated;

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id),
  full_name text not null check (char_length(full_name) between 2 and 120),
  cpf text not null unique check (cpf ~ '^[0-9]{11}$'),
  email text not null unique check (email = lower(email)),
  job_title text not null check (char_length(job_title) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index employees_name_unique on public.employees(lower(full_name));
alter table public.employees enable row level security;
create policy employees_read on public.employees for select to authenticated
using (public.is_receipts_admin() or (user_id = (select auth.uid()) and active));
revoke all on public.employees from anon, authenticated;
grant select on public.employees to authenticated;

create table public.receipts (
  id uuid primary key,
  employee_id uuid not null references public.employees(id),
  employee_name text not null,
  employee_cpf text not null,
  job_title text not null,
  period date not null check (extract(day from period) = 1),
  received_on date not null,
  kind text not null check (kind in ('participation', 'benefits')),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 99999999999),
  file_path text not null unique,
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  signed_at timestamptz,
  signed_by uuid references auth.users(id)
);
create index receipts_employee_period on public.receipts(employee_id, period desc, created_at desc);
alter table public.receipts enable row level security;
create policy receipts_read on public.receipts for select to authenticated
using (public.is_receipts_admin() or exists (
  select 1 from public.employees e where e.id = employee_id and e.user_id = (select auth.uid()) and e.active
));
revoke all on public.receipts from anon, authenticated;
grant select on public.receipts to authenticated;

create table public.receipt_signatures (
  receipt_id uuid primary key references public.receipts(id),
  user_id uuid not null references auth.users(id),
  signer_name text not null,
  cpf_last_four text not null,
  document_sha256 text not null,
  confirmed_at timestamptz not null,
  signed_at timestamptz not null,
  declaration text not null,
  declaration_version text not null default '1'
);
alter table public.receipt_signatures enable row level security;
create policy signatures_read on public.receipt_signatures for select to authenticated
using (exists(select 1 from public.receipts r where r.id = receipt_id));
revoke all on public.receipt_signatures from anon, authenticated;
grant select on public.receipt_signatures to authenticated;

-- No direct access to challenges. Only the two authenticated RPCs can use them.
create table public.receipt_signature_challenges (
  receipt_id uuid primary key references public.receipts(id),
  user_id uuid not null references auth.users(id),
  token uuid not null default gen_random_uuid(),
  presented_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '5 minutes',
  failures integer not null default 0,
  blocked_until timestamptz
);
alter table public.receipt_signature_challenges enable row level security;
revoke all on public.receipt_signature_challenges from anon, authenticated;

create function public.prepare_receipt_signature(p_receipt_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.receipts; c public.receipt_signature_challenges;
begin
  select * into r from public.receipts where id = p_receipt_id for update;
  if not found or not exists(select 1 from public.employees where id = r.employee_id and user_id = auth.uid() and active) then
    raise exception 'Recibo indisponível para esta conta.';
  end if;
  if r.signed_at is not null then raise exception 'Este recibo já foi assinado.'; end if;
  select * into c from public.receipt_signature_challenges where receipt_id = r.id;
  if c.blocked_until > clock_timestamp() then raise exception 'Aguarde 15 minutos antes de tentar novamente.'; end if;
  insert into public.receipt_signature_challenges(receipt_id, user_id) values(r.id, auth.uid())
  on conflict(receipt_id) do update set token = gen_random_uuid(), presented_at = clock_timestamp(),
    expires_at = clock_timestamp() + interval '5 minutes',
    failures = case when public.receipt_signature_challenges.blocked_until <= clock_timestamp() then 0 else public.receipt_signature_challenges.failures end,
    blocked_until = null
  returning * into c;
  return jsonb_build_object('token', c.token, 'presented_at', c.presented_at, 'expires_at', c.expires_at,
    'declaration', 'Declaro que conferi este recibo e confirmo o recebimento do valor nele informado. Confirmo meu CPF e a data e hora apresentadas para registrar minha assinatura.');
end;
$$;

create function public.sign_receipt(p_receipt_id uuid, p_token uuid, p_cpf text, p_consent boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.receipts; c public.receipt_signature_challenges; signed_time timestamptz;
begin
  select * into r from public.receipts where id = p_receipt_id for update;
  if not found or not exists(select 1 from public.employees where id = r.employee_id and user_id = auth.uid() and active) then
    raise exception 'Recibo indisponível para esta conta.';
  end if;
  if r.signed_at is not null then raise exception 'Este recibo já foi assinado.'; end if;
  select * into c from public.receipt_signature_challenges where receipt_id = r.id for update;
  if not found or c.user_id <> auth.uid() or c.token <> p_token or p_token is null or c.expires_at <= clock_timestamp() or c.blocked_until > clock_timestamp() then
    raise exception 'Confirmação expirada. Abra o recibo novamente.';
  end if;
  if p_consent is distinct from true then raise exception 'Confirme a declaração para assinar.'; end if;
  if regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g') <> r.employee_cpf then
    update public.receipt_signature_challenges set failures = failures + 1,
      blocked_until = case when failures >= 4 then clock_timestamp() + interval '15 minutes' else null end where receipt_id = r.id;
    return jsonb_build_object('error', 'O CPF não corresponde ao destinatário deste recibo.');
  end if;
  signed_time := clock_timestamp();
  insert into public.receipt_signatures(receipt_id,user_id,signer_name,cpf_last_four,document_sha256,confirmed_at,signed_at,declaration)
  values(r.id,auth.uid(),r.employee_name,right(r.employee_cpf,4),r.file_sha256,c.presented_at,signed_time,
    'Declaro que conferi este recibo e confirmo o recebimento do valor nele informado. Confirmo meu CPF e a data e hora apresentadas para registrar minha assinatura.');
  update public.receipts set signed_at = signed_time, signed_by = auth.uid() where id = r.id;
  delete from public.receipt_signature_challenges where receipt_id = r.id;
  return jsonb_build_object('signed_at', signed_time, 'receipt_id', r.id);
end;
$$;
revoke all on function public.prepare_receipt_signature(uuid) from public, anon;
revoke all on function public.sign_receipt(uuid,uuid,text,boolean) from public, anon;
grant execute on function public.prepare_receipt_signature(uuid) to authenticated;
grant execute on function public.sign_receipt(uuid,uuid,text,boolean) to authenticated;

-- Only server functions with the secret key can upload/download originals.
-- No client Storage policy; documents are never public or exposed by permanent URL.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('receipt-originals','receipt-originals',false,3145728,array['application/pdf']);

grant all on public.app_admins, public.employees, public.receipts, public.receipt_signatures, public.receipt_signature_challenges to service_role;
