import { createClient } from '@supabase/supabase-js'

const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(URL, KEY)

// ─────────────────────────────────────────────
// ensureSession(pin)
// แลก PIN เป็น Supabase session จริง (edge function `login`)
// จำเป็นเพราะ RLS ของตาราง payroll ตัดสินสิทธิ์จาก get_my_role()
// ซึ่งอ่าน public.users ตาม auth.uid() — ถ้าไม่มี session = anon = ถูกปฏิเสธ
// PIN เดียวกับ verify_login_pin (app_config: pin_owner / pin_hr)
// ─────────────────────────────────────────────
export async function ensureSession(pin) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (session) return true

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
