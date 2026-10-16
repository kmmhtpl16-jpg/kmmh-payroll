// src/BankAccountPanel.jsx
// ─────────────────────────────────────────────
// 🆕 16ต.ค.69 หนังสือยืนยันหมายเลขบัญชี (ใช้กับพนักงานทุกคน · ปุ่มอยู่หน้า 👥 พนักงาน)
//   ขั้นตอน: HR กรอก → บันทึก → ปริ้นใบที่พิมพ์ข้อมูลแล้ว → พนักงานเซ็น → ถ่ายรูปแนบกลับ
//   เก็บลงฐานข้อมูลเฉพาะ: วิธีรับเงิน ธนาคาร เลขบัญชี ชื่อบัญชี พร้อมเพย์ (RPC bank_acc_*)
//   ⚠️ เลขบัตรประชาชน + ที่อยู่ = อยู่ใน state ของหน้าปริ้นเท่านั้น
//      ห้ามส่งไปฐานข้อมูล ห้ามเก็บ localStorage ห้าม console.log
//   รูปแนบ (สมุดบัญชี / ใบที่เซ็นแล้ว) อัป/ดูผ่าน edge function bank-doc — ลิงก์ดูหมดอายุ 120 วินาที
// ─────────────────────────────────────────────
import { useState, useEffect } from 'react'
import BankAccountPrint from './BankAccountPrint'
import { supabase } from './supabase'

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-doc`
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

const BANKS = [
  'กสิกรไทย', 'กรุงไทย', 'กรุงเทพ', 'ไทยพาณิชย์', 'กรุงศรีอยุธยา', 'ทหารไทยธนชาต (ttb)',
  'ออมสิน', 'ธ.ก.ส.', 'อาคารสงเคราะห์', 'ยูโอบี', 'ซีไอเอ็มบี ไทย', 'แลนด์ แอนด์ เฮ้าส์', 'เกียรตินาคินภัทร',
]
const METHOD_LABEL = { promptpay: 'พร้อมเพย์', transfer: 'โอนเข้าบัญชี', cash: 'เงินสด' }
const KIND_LABEL = { passbook: 'หน้าสมุดบัญชี', signed: 'ใบที่เซ็นแล้ว' }

const digits = (s) => String(s || '').replace(/[^0-9]/g, '')
const mask4 = (s) => (s ? '•••' + String(s).slice(-4) : '-')
const fmtDT = (iso) => {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear() + 543} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const whoLabel = (r) => (r === 'owner' ? 'เจ้าของ' : r === 'hr' ? 'HR' : r || '-')

async function callBankDoc(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('หมดเวลาเข้าระบบ — ออกแล้วเข้าใหม่')
  const resp = await fetch(FN_URL, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await resp.json().catch(() => ({}))
  if (!resp.ok || !j.ok) throw new Error(j.error || 'เรียกระบบรูปไม่สำเร็จ')
  return j
}

const EMPTY = { pay_method: '', cash_reason: '', bank_name: '', account_no: '', account_name: '', promptpay_id: '' }

export default function BankAccountPanel({ emp, position, onClose, onSaved }) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState(null)          // { current, history, docs }
  const [form, setForm] = useState(EMPTY)
  const [bankOther, setBankOther] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyKind, setBusyKind] = useState(null)
  const [msg, setMsg] = useState(null)            // { text, type }
  const [printOpen, setPrintOpen] = useState(false)

  async function load() {
    setLoading(true)
    const { data: r, error } = await supabase.rpc('bank_acc_get', { p_emp: emp.id })
    setLoading(false)
    if (error) { setMsg({ text: 'โหลดไม่ได้: ' + error.message, type: 'error' }); return }
    setData(r)
    const c = r?.current
    const f = c ? {
      pay_method: c.pay_method || '', cash_reason: c.cash_reason || '', bank_name: c.bank_name || '',
      account_no: c.account_no || '', account_name: c.account_name || '', promptpay_id: c.promptpay_id || '',
    } : { ...EMPTY, account_name: emp.full_name || '' }
    setForm(f)
    setBankOther(!!f.bank_name && !BANKS.includes(f.bank_name))
  }
  useEffect(() => { load() }, [emp.id])

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const say = (text, type = 'ok') => setMsg({ text, type })

  async function save() {
    setSaving(true)
    const { data: r, error } = await supabase.rpc('bank_acc_save', {
      p_emp: emp.id, p_pay_method: form.pay_method, p_cash_reason: form.cash_reason,
      p_bank_name: form.bank_name, p_account_no: form.account_no,
      p_account_name: form.account_name, p_promptpay_id: form.promptpay_id,
    })
    setSaving(false)
    if (error) { say('บันทึกไม่ได้: ' + error.message, 'error'); return }
    if (!r?.ok) { say(r?.error || 'บันทึกไม่ได้', 'error'); return }
    say(r.changed ? 'บันทึกแล้ว ✓ แจ้งเจ้าของทาง Telegram แล้ว' : 'ข้อมูลเหมือนเดิม ไม่มีอะไรเปลี่ยน')
    load(); onSaved && onSaved()
  }

  async function upload(kind, file) {
    if (!file) return
    setBusyKind(kind)
    try {
      const up = await callBankDoc({ action: 'upload', employee_id: emp.id, kind, filename: file.name, contentType: file.type, size: file.size })
      const { error: upErr } = await supabase.storage.from('hr-docs').uploadToSignedUrl(up.path, up.token, file, { contentType: file.type })
      if (upErr) throw new Error('อัปไม่สำเร็จ: ' + upErr.message)
      const { data: r, error } = await supabase.rpc('bank_acc_add_doc', { p_emp: emp.id, p_kind: kind, p_path: up.path })
      if (error || !r?.ok) throw new Error(error?.message || r?.error || 'ผูกรูปไม่สำเร็จ')
      say(`แนบ${KIND_LABEL[kind]}แล้ว ✓`)
      load(); onSaved && onSaved()
    } catch (e) {
      say(e.message, 'error')
    } finally {
      setBusyKind(null)
    }
  }

  async function view(path) {
    // เปิดแท็บก่อน (กันเบราว์เซอร์บล็อก popup) แล้วค่อยใส่ลิงก์ชั่วคราว
    const w = window.open('', '_blank')
    try {
      const r = await callBankDoc({ action: 'view', path })
      if (w) w.location.replace(r.url); else window.location.assign(r.url)
    } catch (e) {
      if (w) w.close()
      say(e.message, 'error')
    }
  }

  const docs = data?.docs || []
  const history = data?.history || []
  const lbl = { fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }
  const inp = { width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px', boxSizing: 'border-box' }

  if (printOpen) {
    return <BankAccountPrint emp={emp} position={position} form={form} onBack={() => setPrintOpen(false)} />
  }

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: '1.25rem 1.5rem', width: '100%', maxWidth: 560, maxHeight: '92vh', overflowY: 'auto', fontSize: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 16 }}>🏦 บัญชีรับเงิน — {emp.nickname}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#aaa' }}>×</button>
        </div>
        <div style={{ color: '#888', fontSize: 12, marginBottom: 14 }}>{emp.full_name} · {emp.emp_code || 'ยังไม่มีรหัส'}</div>

        {msg && (
          <div style={{ background: msg.type === 'error' ? '#FCEBEB' : '#EAF3DE', color: msg.type === 'error' ? '#A32D2D' : '#27500A', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>{msg.text}</div>
        )}

        {loading ? <div style={{ color: '#aaa', padding: 20, textAlign: 'center' }}>กำลังโหลด...</div> : (<>
          {/* ── ฟอร์ม ── */}
          <div style={lbl}>วิธีรับเงิน *</div>
          <div style={{ display: 'flex', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
            {Object.entries(METHOD_LABEL).map(([k, v]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="radio" name="pm" checked={form.pay_method === k} onChange={() => setF('pay_method', k)} /> {v}
              </label>
            ))}
          </div>

          {(form.pay_method === 'transfer' || form.pay_method === 'promptpay') && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              {form.pay_method === 'promptpay' && (
                <div style={{ gridColumn: '1/-1' }}>
                  <div style={lbl}>หมายเลขพร้อมเพย์ * (เบอร์มือถือ 10 หลัก หรือเลข 13 หลัก)</div>
                  <input value={form.promptpay_id} inputMode="numeric" autoComplete="off" onChange={e => setF('promptpay_id', digits(e.target.value).slice(0, 13))} style={inp} />
                </div>
              )}
              <div>
                <div style={lbl}>ธนาคาร {form.pay_method === 'transfer' ? '*' : '(ถ้ามี)'}</div>
                <select value={bankOther ? '__other' : form.bank_name} onChange={e => {
                  if (e.target.value === '__other') { setBankOther(true); setF('bank_name', '') }
                  else { setBankOther(false); setF('bank_name', e.target.value) }
                }} style={{ ...inp, padding: '0 6px' }}>
                  <option value="">— เลือก —</option>
                  {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                  <option value="__other">อื่น ๆ (พิมพ์เอง)</option>
                </select>
                {bankOther && <input value={form.bank_name} placeholder="ชื่อธนาคาร" onChange={e => setF('bank_name', e.target.value)} style={{ ...inp, marginTop: 6 }} />}
              </div>
              <div>
                <div style={lbl}>เลขที่บัญชี {form.pay_method === 'transfer' ? '*' : '(ถ้ามี)'}</div>
                <input value={form.account_no} inputMode="numeric" autoComplete="off" onChange={e => setF('account_no', digits(e.target.value).slice(0, 15))} style={inp} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <div style={lbl}>ชื่อบัญชี</div>
                <input value={form.account_name} autoComplete="off" onChange={e => setF('account_name', e.target.value)} style={inp} />
                {form.account_name && emp.full_name && form.account_name.replace(/\s+/g, '') !== emp.full_name.replace(/\s+/g, '') && (
                  <div style={{ fontSize: 11, color: '#B26A00', marginTop: 3 }}>⚠️ ชื่อบัญชีไม่ตรงกับชื่อพนักงาน — เช็กให้แน่ใจก่อนบันทึก</div>
                )}
              </div>
            </div>
          )}

          {form.pay_method === 'cash' && (
            <div style={{ marginBottom: 12 }}>
              <div style={lbl}>เหตุผลที่รับเงินสด *</div>
              <input value={form.cash_reason} onChange={e => setF('cash_reason', e.target.value)} placeholder="เช่น ยังไม่มีบัญชีธนาคาร" style={inp} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <button disabled={saving || !form.pay_method} onClick={save} style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 500, opacity: (saving || !form.pay_method) ? 0.5 : 1 }}>
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
            <button onClick={() => setPrintOpen(true)} style={{ background: '#fff', color: '#0C447C', border: '0.5px solid #B9D3F0', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 500 }}>
              🖨 ปริ้นใบยืนยัน
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#999', marginBottom: 16, lineHeight: 1.5 }}>
            บันทึกแล้วใช้ได้ทันที ระบบเก็บค่าเก่าไว้ในประวัติ และแจ้งเจ้าของทาง Telegram (เลขบัญชีแค่ 4 ตัวท้าย)
            · ช่องที่ยังไม่รู้ปล่อยว่างได้ ใบที่ปริ้นจะเป็นเส้นไข่ปลาให้เขียนมือ
          </div>

          {/* ── รูปแนบ ── */}
          <div style={{ borderTop: '0.5px solid #eee', paddingTop: 12, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>📎 รูปแนบ</div>
            {['passbook', 'signed'].map(kind => {
              const list = docs.filter(d => d.kind === kind)
              return (
                <div key={kind} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 100 }}>{KIND_LABEL[kind]}</span>
                    <label style={{ background: '#F1EFE8', borderRadius: 6, padding: '4px 10px', cursor: busyKind ? 'default' : 'pointer', fontSize: 12, opacity: busyKind ? 0.5 : 1 }}>
                      {busyKind === kind ? 'กำลังอัป...' : (list.length ? '📷 แนบรูปใหม่' : '📷 แนบรูป')}
                      <input type="file" accept="image/*,application/pdf" disabled={!!busyKind} style={{ display: 'none' }}
                        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; upload(kind, f) }} />
                    </label>
                    {!list.length && <span style={{ color: '#B26A00', fontSize: 12 }}>ยังไม่มี</span>}
                  </div>
                  {list.map((d, i) => (
                    <div key={d.id} style={{ fontSize: 12, color: i ? '#999' : '#444', marginTop: 4, marginLeft: 108 }}>
                      <button onClick={() => view(d.path)} style={{ background: 'none', border: 'none', padding: 0, color: '#0C447C', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
                        เปิดดู{i ? ' (รูปเก่า)' : ''}
                      </button>{' '}· {fmtDT(d.uploaded_at)} · {whoLabel(d.by)}
                    </div>
                  ))}
                </div>
              )
            })}
            <div style={{ fontSize: 11, color: '#999' }}>ลิงก์เปิดดูใช้ได้ 2 นาที — ส่งต่อให้คนอื่นก็เปิดไม่ได้หลังหมดเวลา</div>
          </div>

          {/* ── ประวัติ ── */}
          <div style={{ borderTop: '0.5px solid #eee', paddingTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>🕘 ประวัติการเปลี่ยน</div>
            {!history.length && <div style={{ color: '#aaa', fontSize: 12 }}>ยังไม่มี</div>}
            {history.map((h, i) => (
              <div key={i} style={{ fontSize: 12, padding: '6px 0', borderBottom: '0.5px dashed #eee', lineHeight: 1.6 }}>
                <div style={{ color: '#888' }}>{fmtDT(h.changed_at)} · แก้โดย {whoLabel(h.by)}</div>
                <div>{summarize(h.old)} <b>→</b> {summarize(h.new)}</div>
              </div>
            ))}
          </div>
        </>)}
      </div>
    </div>
  )
}

function summarize(d) {
  if (!d) return <span style={{ color: '#aaa' }}>ยังไม่มี</span>
  if (d.pay_method === 'cash') return `เงินสด (${d.cash_reason || '-'})`
  if (d.pay_method === 'promptpay') return `พร้อมเพย์ ${mask4(d.promptpay_id)}${d.bank_name ? ' · ' + d.bank_name : ''}`
  return `${d.bank_name || '-'} ${mask4(d.account_no)}`
}
