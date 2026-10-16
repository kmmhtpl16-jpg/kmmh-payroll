-- ใบยืนยันเลขบัญชี (16 ต.ค. 69)
-- เก็บเฉพาะ: วิธีรับเงิน ธนาคาร เลขบัญชี ชื่อบัญชี พร้อมเพย์ + รูปแนบ
-- ห้ามเก็บเลขบัตรประชาชน/ที่อยู่ (กรอกในหน้าปริ้นเท่านั้น)
-- ทุกตารางปิดจาก anon/authenticated · เข้าทาง RPC ที่ตรวจ get_my_role() in (owner, hr)

create table public.emp_bank_accounts (
  employee_id   uuid primary key references public.employees(id) on delete cascade,
  pay_method    text not null check (pay_method in ('promptpay','transfer','cash')),
  cash_reason   text,
  bank_name     text,
  account_no    text check (account_no is null or account_no ~ '^[0-9]{10,15}$'),
  account_name  text,
  promptpay_id  text check (promptpay_id is null or promptpay_id ~ '^[0-9]{10}$|^[0-9]{13}$'),
  updated_at    timestamptz not null default now(),
  updated_by_role text,
  updated_by_uid  uuid
);

-- ประวัติ: เพิ่มอย่างเดียว ไม่มีทางแก้/ลบผ่าน RPC
create table public.emp_bank_account_log (
  id            bigint generated always as identity primary key,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  old_data      jsonb,
  new_data      jsonb not null,
  changed_at    timestamptz not null default now(),
  changed_by_role text,
  changed_by_uid  uuid
);
create index on public.emp_bank_account_log (employee_id, changed_at desc);

-- รูปแนบ: เก็บทุกครั้งที่อัป (รูปเก่ายังเปิดดูได้)
create table public.emp_bank_docs (
  id            bigint generated always as identity primary key,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  kind          text not null check (kind in ('passbook','signed')),
  doc_path      text not null unique,
  uploaded_at   timestamptz not null default now(),
  uploaded_by_role text,
  uploaded_by_uid  uuid
);
create index on public.emp_bank_docs (employee_id, uploaded_at desc);

alter table public.emp_bank_accounts    enable row level security;
alter table public.emp_bank_account_log enable row level security;
alter table public.emp_bank_docs        enable row level security;
revoke all on public.emp_bank_accounts, public.emp_bank_account_log, public.emp_bank_docs from public, anon, authenticated;
revoke all on sequence public.emp_bank_account_log_id_seq, public.emp_bank_docs_id_seq from public, anon, authenticated;

-- ── ตัวช่วย ──
create or replace function public.bank_acc_mask(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when coalesce(p,'') = '' then '-' else '•••' || right(p, 4) end
$$;

create or replace function public.bank_acc_esc(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select replace(replace(replace(coalesce(p,''), '&','&amp;'), '<','&lt;'), '>','&gt;')
$$;

create or replace function public.bank_acc_method_label(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case p when 'promptpay' then 'พร้อมเพย์' when 'transfer' then 'โอนเข้าบัญชี'
                when 'cash' then 'เงินสด' else 'ยังไม่มี' end
$$;

-- ส่งเข้าห้องเจ้าของเท่านั้น — key ห้องเขียนตายตัว ไม่รับจากผู้เรียก
create or replace function public.bank_acc_notify_owner(p_msg text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.tg_send_to(p_msg, 'telegram_chat_id_owner');
end $$;

-- ── รายการสถานะ (ปุ่มข้างชื่อ) — ไม่ส่งเลขเต็ม ──
create or replace function public.bank_acc_list()
returns table (employee_id uuid, pay_method text, bank_name text, account_last4 text,
               has_passbook boolean, has_signed boolean, updated_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if coalesce(public.get_my_role(), '') not in ('owner','hr') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select e.id, a.pay_method, a.bank_name,
           case when a.pay_method = 'promptpay' then right(a.promptpay_id, 4) else right(a.account_no, 4) end,
           exists (select 1 from emp_bank_docs d where d.employee_id = e.id and d.kind = 'passbook'),
           exists (select 1 from emp_bank_docs d where d.employee_id = e.id and d.kind = 'signed'),
           a.updated_at
      from employees e left join emp_bank_accounts a on a.employee_id = e.id;
end $$;

-- ── ดูของคนเดียว (เลขเต็ม + ประวัติ + รายการรูป) ──
create or replace function public.bank_acc_get(p_emp uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if coalesce(public.get_my_role(), '') not in ('owner','hr') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'current', (select to_jsonb(a) - 'updated_by_uid' from emp_bank_accounts a where a.employee_id = p_emp),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
                  'changed_at', l.changed_at, 'by', l.changed_by_role,
                  'old', l.old_data, 'new', l.new_data) order by l.changed_at desc)
                from emp_bank_account_log l where l.employee_id = p_emp), '[]'::jsonb),
    'docs', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', d.id, 'kind', d.kind, 'path', d.doc_path,
                  'uploaded_at', d.uploaded_at, 'by', d.uploaded_by_role) order by d.uploaded_at desc)
                from emp_bank_docs d where d.employee_id = p_emp), '[]'::jsonb)
  ) into r;
  return r;
end $$;

-- ── บันทึก (บันทึกทันที · เก็บค่าเก่า · แจ้งเจ้าของ) ──
create or replace function public.bank_acc_save(
  p_emp uuid, p_pay_method text, p_cash_reason text, p_bank_name text,
  p_account_no text, p_account_name text, p_promptpay_id text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role text := public.get_my_role();
  v_emp  employees;
  v_old  emp_bank_accounts;
  v_old_j jsonb;
  v_new_j jsonb;
  v_acc  text := nullif(regexp_replace(coalesce(p_account_no,''), '[^0-9]', '', 'g'), '');
  v_pp   text := nullif(regexp_replace(coalesce(p_promptpay_id,''), '[^0-9]', '', 'g'), '');
  v_bank text := nullif(btrim(coalesce(p_bank_name,'')), '');
  v_name text := nullif(btrim(coalesce(p_account_name,'')), '');
  v_why  text := nullif(btrim(coalesce(p_cash_reason,'')), '');
  v_msg  text;
begin
  if coalesce(v_role, '') not in ('owner','hr') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_emp from employees where id = p_emp;
  if not found then return jsonb_build_object('ok', false, 'error', 'ไม่พบพนักงาน'); end if;

  if p_pay_method not in ('promptpay','transfer','cash') then
    return jsonb_build_object('ok', false, 'error', 'เลือกวิธีรับเงินก่อน');
  end if;
  if p_pay_method = 'transfer' then
    if v_bank is null then return jsonb_build_object('ok', false, 'error', 'เลือกธนาคาร'); end if;
    if v_acc is null or length(v_acc) not between 10 and 15 then
      return jsonb_build_object('ok', false, 'error', 'เลขบัญชีต้องเป็นตัวเลข 10–15 หลัก'); end if;
    v_pp := null; v_why := null;
  elsif p_pay_method = 'promptpay' then
    if v_pp is null or length(v_pp) not in (10, 13) then
      return jsonb_build_object('ok', false, 'error', 'พร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลข 13 หลัก'); end if;
    v_why := null;
    if v_acc is not null and length(v_acc) not between 10 and 15 then
      return jsonb_build_object('ok', false, 'error', 'เลขบัญชีต้องเป็นตัวเลข 10–15 หลัก'); end if;
  else -- cash
    if v_why is null then return jsonb_build_object('ok', false, 'error', 'รับเงินสดต้องใส่เหตุผล'); end if;
    v_acc := null; v_pp := null; v_bank := null; v_name := null;
  end if;

  -- ล็อกต่อพนักงาน กันบันทึกครั้งแรกพร้อมกันสองเครื่องแล้วประวัติขาดช่วง
  perform pg_advisory_xact_lock(hashtext('bank_acc:' || p_emp::text));
  select * into v_old from emp_bank_accounts where employee_id = p_emp for update;
  if found then
    v_old_j := jsonb_build_object('pay_method', v_old.pay_method, 'cash_reason', v_old.cash_reason,
      'bank_name', v_old.bank_name, 'account_no', v_old.account_no,
      'account_name', v_old.account_name, 'promptpay_id', v_old.promptpay_id);
  end if;
  v_new_j := jsonb_build_object('pay_method', p_pay_method, 'cash_reason', v_why,
    'bank_name', v_bank, 'account_no', v_acc, 'account_name', v_name, 'promptpay_id', v_pp);

  if v_old_j is not distinct from v_new_j then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  insert into emp_bank_account_log (employee_id, old_data, new_data, changed_by_role, changed_by_uid)
  values (p_emp, v_old_j, v_new_j, v_role, auth.uid());

  insert into emp_bank_accounts as a (employee_id, pay_method, cash_reason, bank_name, account_no,
    account_name, promptpay_id, updated_at, updated_by_role, updated_by_uid)
  values (p_emp, p_pay_method, v_why, v_bank, v_acc, v_name, v_pp, now(), v_role, auth.uid())
  on conflict (employee_id) do update set
    pay_method = excluded.pay_method, cash_reason = excluded.cash_reason,
    bank_name = excluded.bank_name, account_no = excluded.account_no,
    account_name = excluded.account_name, promptpay_id = excluded.promptpay_id,
    updated_at = now(), updated_by_role = excluded.updated_by_role,
    updated_by_uid = excluded.updated_by_uid;

  -- ข้อความถึงเจ้าของ: เลขบัญชี/พร้อมเพย์เฉพาะ 4 ตัวท้าย
  v_msg := '🏦 <b>' || case when v_old_j is null then 'ลงข้อมูลรับเงินครั้งแรก' else 'เปลี่ยนข้อมูลรับเงิน' end || '</b>' || chr(10)
    || 'พนักงาน: ' || bank_acc_esc(v_emp.nickname) || ' (' || bank_acc_esc(coalesce(v_emp.emp_code, 'ไม่มีรหัส')) || ')' || chr(10)
    || 'แก้โดย: ' || case v_role when 'owner' then 'เจ้าของ' else 'HR' end || chr(10)
    || 'วิธีรับเงิน: ' || bank_acc_method_label(v_old_j->>'pay_method') || ' → ' || bank_acc_method_label(p_pay_method) || chr(10)
    || 'ธนาคาร: ' || bank_acc_esc(coalesce(v_old_j->>'bank_name', '-')) || ' → ' || bank_acc_esc(coalesce(v_bank, '-')) || chr(10)
    || 'เลขบัญชี: ' || bank_acc_mask(v_old_j->>'account_no') || ' → ' || bank_acc_mask(v_acc)
    || case when coalesce(v_old_j->>'promptpay_id', v_pp) is not null
         then chr(10) || 'พร้อมเพย์: ' || bank_acc_mask(v_old_j->>'promptpay_id') || ' → ' || bank_acc_mask(v_pp) else '' end
    || case when p_pay_method = 'cash' then chr(10) || 'เหตุผลรับเงินสด: ' || bank_acc_esc(v_why) else '' end || chr(10)
    || 'เวลา: ' || to_char(now() at time zone 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI');
  perform bank_acc_notify_owner(v_msg);

  return jsonb_build_object('ok', true, 'changed', true);
end $$;

-- ── ผูกรูปที่อัปแล้วกับพนักงาน (เรียกหลังอัปผ่าน edge function bank-doc) ──
create or replace function public.bank_acc_add_doc(p_emp uuid, p_kind text, p_path text)
returns jsonb
language plpgsql security definer set search_path = public, storage, pg_temp as $$
declare v_role text := public.get_my_role();
begin
  if coalesce(v_role, '') not in ('owner','hr') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kind not in ('passbook','signed') then
    return jsonb_build_object('ok', false, 'error', 'ชนิดรูปไม่ถูกต้อง'); end if;
  -- path ต้องเป็นโฟลเดอร์ของพนักงานคนนี้ + ชนิดนี้ (edge function เป็นคนตั้งชื่อ)
  if p_path is null or p_path not like 'bank/' || p_emp::text || '/' || p_kind || '-%'
     or p_path ~ '\.\.' then
    return jsonb_build_object('ok', false, 'error', 'ที่อยู่ไฟล์ไม่ถูกต้อง'); end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'hr-docs' and o.name = p_path) then
    return jsonb_build_object('ok', false, 'error', 'ยังไม่พบไฟล์ที่อัป'); end if;
  insert into emp_bank_docs (employee_id, kind, doc_path, uploaded_by_role, uploaded_by_uid)
  values (p_emp, p_kind, p_path, v_role, auth.uid())
  on conflict (doc_path) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- ปิดฟังก์ชันจากทุกคน แล้วเปิดเฉพาะที่หน้าเว็บต้องเรียก (ข้างในตรวจ role อีกชั้น)
revoke all on function public.bank_acc_mask(text), public.bank_acc_esc(text), public.bank_acc_method_label(text),
  public.bank_acc_notify_owner(text), public.bank_acc_list(), public.bank_acc_get(uuid),
  public.bank_acc_save(uuid,text,text,text,text,text,text), public.bank_acc_add_doc(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.bank_acc_list(), public.bank_acc_get(uuid),
  public.bank_acc_save(uuid,text,text,text,text,text,text), public.bank_acc_add_doc(uuid,text,text)
  to authenticated;
