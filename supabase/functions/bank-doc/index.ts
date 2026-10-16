import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

/* รูปแนบของใบยืนยันเลขบัญชี (16 ต.ค. 69)
   - หน้าสมุดบัญชี (passbook) + ใบที่พนักงานเซ็นแล้ว (signed)
   - เก็บใน bucket hr-docs (ส่วนตัว) โฟลเดอร์ bank/<employee_id>/
   - แบบเดียวกับ hr-doc: อัปผ่านลิงก์อัปชั่วคราว · ดูผ่านลิงก์ 120 วินาที
   - ต่างจาก hr-doc: ไม่ใช้ PIN แต่ใช้ session ของแอป payroll (Authorization: Bearer)
     แล้วตรวจ role จาก public.users เหมือน get_my_role() — ผ่านเฉพาะ owner / hr */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const BUCKET = 'hr-docs';
const MAX_BYTES = 15 * 1024 * 1024;
const OK_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const KINDS = ['passbook', 'signed'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* นามสกุลไฟล์อย่างเดียว ไม่ใช้ชื่อไฟล์จากเครื่องผู้ใช้ */
function safeExt(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  return ext ? '.' + ext : '';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  /* ── ตรวจว่าเป็นเจ้าของ/HR ── */
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'ต้องเข้าสู่ระบบก่อน' }, 401);
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u?.user?.id) return json({ error: 'ต้องเข้าสู่ระบบก่อน' }, 401);
  const { data: me } = await admin.from('users').select('role,is_active').eq('id', u.user.id).maybeSingle();
  if (!me || me.is_active === false || !['owner', 'hr'].includes(me.role)) {
    return json({ error: 'ไม่มีสิทธิ์' }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const action = String(body?.action ?? '');

  /* ── ขอที่สำหรับอัปไฟล์ใหม่ ── */
  if (action === 'upload') {
    const emp = String(body?.employee_id ?? '');
    const kind = String(body?.kind ?? '');
    const mime = String(body?.contentType ?? '');
    const size = Number(body?.size ?? 0);
    if (!UUID_RE.test(emp)) return json({ error: 'employee_id ไม่ถูกต้อง' }, 400);
    if (!KINDS.includes(kind)) return json({ error: 'ชนิดรูปไม่ถูกต้อง' }, 400);
    if (!OK_MIME.includes(mime)) return json({ error: 'รับเฉพาะรูปภาพ (jpg png webp heic) หรือ PDF' }, 400);
    if (!(size > 0) || size > MAX_BYTES) return json({ error: 'ไฟล์ใหญ่เกิน 15 MB — ถ่ายใหม่หรือลดความละเอียดลง' }, 400);

    const { data: e } = await admin.from('employees').select('id').eq('id', emp).maybeSingle();
    if (!e) return json({ error: 'ไม่พบพนักงาน' }, 404);

    /* เวลามาจากเซิร์ฟเวอร์ ไม่เชื่อเครื่องผู้ใช้ */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = crypto.randomUUID().slice(0, 8);
    const path = `bank/${emp}/${kind}-${stamp}-${rand}${safeExt(String(body?.filename ?? ''))}`;

    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: 'upload_url_failed' }, 500);
    return json({ ok: true, path, token: data.token });
  }

  /* ── ขอลิงก์เปิดดูไฟล์ (เฉพาะไฟล์ที่ผูกกับ emp_bank_docs แล้ว) ── */
  if (action === 'view') {
    const path = String(body?.path ?? '');
    if (!path.startsWith('bank/')) return json({ error: 'ไม่พบไฟล์นี้' }, 404);
    const { data: d } = await admin.from('emp_bank_docs').select('id').eq('doc_path', path).maybeSingle();
    if (!d) return json({ error: 'ไม่พบไฟล์นี้' }, 404);

    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, 120);
    if (error) return json({ error: 'sign_failed' }, 500);
    return json({ ok: true, url: data.signedUrl, expires_in: 120 });
  }

  return json({ error: 'unknown_action' }, 400);
});
