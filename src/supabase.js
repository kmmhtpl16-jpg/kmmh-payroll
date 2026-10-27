import { createClient } from '@supabase/supabase-js'

const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// ─────────────────────────────────────────────
// ⚠️ storageKey แยกของแอป payroll โดยเฉพาะ
// แอป KMMH ทุกตัวอยู่โดเมนเดียวกัน (kmmhtpl16-jpg.github.io)
// → localStorage ก้อนเดียวกัน คีย์ default (sb-<ref>-auth-token) ชนกัน
// แอปจัดส่ง/จองคิว auto-login เป็น staff (role=employee)
// ถ้า payroll ใช้คีย์เดียวกัน จะหยิบ session ของ staff มาใช้
// → get_my_role()='employee' → RLS payroll_records ปฏิเสธ INSERT
// ─────────────────────────────────────────────
export const supabase = createClient(URL, KEY, {
  auth: {
    storageKey: 'sb-kmmh-payroll-auth',
    persistSession: true,
    autoRefreshToken: true,
  },
})

const ALLOWED_ROLES = ['owner', 'hr']

// ─────────────────────────────────────────────
// ensureSession(pin)
// แลก PIN เป็น Supabase session จริง (edge function `login`)
// จำเป็นเพราะ RLS ของตาราง payroll ตัดสินสิทธิ์จาก get_my_role()
// ซึ่งอ่าน public.users ตาม auth.uid() — ถ้าไม่มี session = anon = ถูกปฏิเสธ
// PIN เดียวกับ verify_login_pin (app_config: pin_owner / pin_hr)
//
// ⚠️ ถ้ามี session ค้างอยู่ ต้องเช็ค role ก่อนเสมอ
//    ห้าม return true ทันที (บั๊กเดิม: ใช้ session ของ staff → บันทึกไม่ได้)
// 🆕 27 ต.ค.69 ต้องตรงกับ role ของ PIN ที่เพิ่งกด (wantedRole) ไม่ใช่แค่ owner/hr อะไรก็ได้
//    บั๊ก: HR เข้าเครื่องนี้ก่อน → session hr ค้าง → เจ้าของกด PIN เจ้าของ จอขึ้น "เจ้าของ"
//    แต่ฐานข้อมูลยังเห็นเป็น hr → กดอนุมัติคำขอแก้ไขไม่ได้ ("เฉพาะเจ้าของเท่านั้น...")
// ─────────────────────────────────────────────
export async function ensureSession(pin, wantedRole) {
  if (!ALLOWED_ROLES.includes(wantedRole)) return false
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user?.id) {
      const { data: me } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()
      if (me && me.role === wantedRole) return true
      // session ผิดคน/ผิดสิทธิ์ → ล้างทิ้ง แล้วขอใหม่ด้วย PIN
      await signOut()
    }

    const resp = await fetch(`${URL}/functions/v1/login`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    const j = await resp.json()
    if (resp.ok && j.access_token && j.role === wantedRole) {
      const { data: set, error: setErr } = await supabase.auth.setSession({
        access_token: j.access_token,
        refresh_token: j.refresh_token,
      })
      if (setErr || !set?.session?.user?.id) return false
      // ยืนยันจากฐานข้อมูลอีกชั้นว่า session ที่ติดตั้งแล้วเป็น role เดียวกับ PIN จริง
      const { data: me } = await supabase
        .from('users')
        .select('role')
        .eq('id', set.session.user.id)
        .maybeSingle()
      if (me?.role === wantedRole) return true
      await signOut()
    }
  } catch (e) {
    console.error('ensureSession', e)
  }
  return false
}

// ออกจากระบบ — ถ้าแจ้งเซิร์ฟเวอร์ไม่สำเร็จ (เน็ตหลุด ฯลฯ) อย่างน้อยต้องล้าง session ในเครื่องทิ้ง
export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut()
    if (!error) return
    console.error('signOut', error)
  } catch (e) { console.error('signOut', e) }
  try { await supabase.auth.signOut({ scope: 'local' }) } catch (e) { console.error('signOut local', e) }
  try { localStorage.removeItem('sb-kmmh-payroll-auth') } catch { /* ไม่มี storage ก็ไม่มีอะไรค้าง */ }
}
