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
// ─────────────────────────────────────────────
export async function ensureSession(pin) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user?.id) {
      const { data: me } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()
      if (me && ALLOWED_ROLES.includes(me.role)) return true
      // session ผิดคน/ผิดสิทธิ์ → ล้างทิ้ง แล้วขอใหม่ด้วย PIN
      await supabase.auth.signOut()
    }

    const resp = await fetch(`${URL}/functions/v1/login`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    const j = await resp.json()
    if (resp.ok && j.access_token) {
      await supabase.auth.setSession({
        access_token: j.access_token,
        refresh_token: j.refresh_token,
      })
      return true
    }
  } catch (e) {
    console.error('ensureSession', e)
  }
  return false
}

export async function signOut() {
  try { await supabase.auth.signOut() } catch (e) { console.error('signOut', e) }
}
