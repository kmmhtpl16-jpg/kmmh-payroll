import { useState, useEffect } from 'react'
import { supabase } from './supabase'

const COLORS = [
  { bg: '#E6F1FB', fg: '#0C447C' },
  { bg: '#EAF3DE', fg: '#27500A' },
  { bg: '#FAEEDA', fg: '#633806' },
  { bg: '#FBEAF0', fg: '#72243E' },
  { bg: '#E1F5EE', fg: '#085041' },
]

const fmtRate = (n) => n ? Number(n).toLocaleString('th-TH') : '-'
const fmtMoney = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const getInitials = (name) => (name || '??').substring(0, 2)
const getColor = (i) => COLORS[i % COLORS.length]

// แปลงวันที่ ค.ศ. → แสดง พ.ศ. (เช่น 2026-06-17 → 17/06/2569)
const toBE = (iso) => {
  if (!iso) return '-'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${Number(y) + 543}`
}

const EMPTY_FORM = {
  emp_code: '', nickname: '', full_name: '',
  emp_type: 'trial', monthly_salary: '', daily_rate: '',
  position_allowance: '0', pay_schedule: 'saturday',
  default_pay_method: 'transfer', insurance_level: 'none',
  app_fee_status: 'held', trial_start_date: '', permanent_start_date: '',
}

export default function EmployeesPage() {
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('active')
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editIsActive, setEditIsActive] = useState(true)   // 🆕 เก็บสถานะเดิม กันบั๊กปลุกกลับมา
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  // 🆕 state สำหรับ popup ลาออก
  const [resignModal, setResignModal] = useState(null)   // { emp } | null
  const [resignDate, setResignDate] = useState('')
  const [insBalance, setInsBalance] = useState(null)     // ยอดประกันคงเหลือ (null = กำลังโหลด)
  const [resignSaving, setResignSaving] = useState(false)

  useEffect(() => { fetchEmployees() }, [])

  async function fetchEmployees() {
    setLoading(true)
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .order('emp_code', { ascending: true })
    if (error) showToast('โหลดข้อมูลไม่ได้: ' + error.message, 'error')
    else setEmployees(data || [])
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const filtered = employees.filter(e => {
    const q = search.toLowerCase()
    const matchQ = !q || e.nickname?.toLowerCase().includes(q) ||
      e.full_name?.toLowerCase().includes(q) || e.emp_code?.toLowerCase().includes(q)
    const matchType = !filterType || e.emp_type === filterType
    const matchStatus = filterStatus === 'active' ? e.is_active : filterStatus === 'inactive' ? !e.is_active : true
    return matchQ && matchType && matchStatus
  })

  const stats = {
    total: employees.filter(e => e.is_active).length,
    perm: employees.filter(e => e.is_active && e.emp_type === 'permanent').length,
    trial: employees.filter(e => e.is_active && e.emp_type === 'trial').length,
    eom: employees.filter(e => e.is_active && e.pay_schedule === 'end_of_month').length,
  }

  function openModal(emp = null) {
    if (emp) {
      setEditId(emp.id)
      setEditIsActive(emp.is_active)   // 🆕 จำสถานะเดิมไว้
      setForm({
        emp_code: emp.emp_code || '',
        nickname: emp.nickname || '',
        full_name: emp.full_name || '',
        emp_type: emp.emp_type || 'trial',
        monthly_salary: emp.monthly_salary || '',
        daily_rate: emp.daily_rate || '',
        position_allowance: emp.position_allowance || '0',
        pay_schedule: emp.pay_schedule || 'saturday',
        default_pay_method: emp.default_pay_method || 'transfer',
        insurance_level: emp.insurance_level || 'none',
        app_fee_status: emp.app_fee_status || 'held',
        trial_start_date: emp.trial_start_date || '',
        permanent_start_date: emp.permanent_start_date || '',
      })
    } else {
      setEditId(null)
      setEditIsActive(true)            // 🆕 เพิ่มใหม่ = active
      setForm(EMPTY_FORM)
    }
    setModalOpen(true)
  }

  function closeModal() { setModalOpen(false) }

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function saveEmployee() {
    if (!form.nickname || !form.full_name || !form.daily_rate) {
      showToast('กรุณากรอก: ชื่อเล่น / ชื่อ-นามสกุล / ค่าแรงวัน', 'error')
      return
    }
    setSaving(true)
    const payload = {
      emp_code: form.emp_code || null,
      nickname: form.nickname,
      full_name: form.full_name,
      emp_type: form.emp_type,
      monthly_salary: form.emp_type === 'permanent' ? Number(form.monthly_salary) || null : null,
      daily_rate: Number(form.daily_rate),
      position_allowance: Number(form.position_allowance) || 0,
      pay_schedule: form.pay_schedule,
      default_pay_method: form.default_pay_method,
      insurance_level: form.insurance_level,
      app_fee_status: form.app_fee_status,
      trial_start_date: form.trial_start_date || null,
      permanent_start_date: form.emp_type === 'permanent' ? form.permanent_start_date || null : null,
      // 🔧 บั๊กเดิม: เคย hardcode true เสมอ → คนลาออกจะถูกปลุกกลับมา
      //    แก้: ตอนแก้ไข ใช้สถานะเดิม / ตอนเพิ่มใหม่ = true
      is_active: editId ? editIsActive : true,
    }
    let error
    if (editId) {
      ({ error } = await supabase.from('employees').update(payload).eq('id', editId))
    } else {
      ({ error } = await supabase.from('employees').insert(payload))
    }
    setSaving(false)
    if (error) { showToast('บันทึกไม่ได้: ' + error.message, 'error'); return }
    showToast(editId ? 'แก้ไขข้อมูลสำเร็จ ✓' : 'เพิ่มพนักงานสำเร็จ ✓')
    closeModal()
    fetchEmployees()
  }

  // 🆕 เปิด popup ลาออก + โหลดยอดประกันสด
  async function openResign(emp) {
    setResignModal({ emp })
    // default วันลาออก = วันนี้ (รูปแบบ YYYY-MM-DD)
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    setResignDate(iso)
    setInsBalance(null)
    // โหลดยอดประกันคงเหลือจากวิว v_insurance_balance
    const { data, error } = await supabase
      .from('v_insurance_balance')
      .select('balance')
      .eq('employee_id', emp.id)
      .maybeSingle()
    if (error) {
      setInsBalance(0)   // ดึงไม่ได้ → ถือว่า 0 ไว้ก่อน
    } else {
      setInsBalance(Number(data?.balance || 0))
    }
  }

  function closeResign() {
    setResignModal(null)
    setResignDate('')
    setInsBalance(null)
  }

  // 🆕 ยืนยันลาออก: บันทึก resigned_date + ปิด is_active
  async function confirmResign() {
    if (!resignModal) return
    if (!resignDate) { showToast('กรุณาเลือกวันที่ลาออก', 'error'); return }
    setResignSaving(true)
    const { error } = await supabase
      .from('employees')
      .update({ resigned_date: resignDate, is_active: false })
      .eq('id', resignModal.emp.id)
    setResignSaving(false)
    if (error) { showToast('บันทึกลาออกไม่ได้: ' + error.message, 'error'); return }
    showToast(`บันทึกการลาออก ${resignModal.emp.nickname} (${toBE(resignDate)}) แล้ว ✓`)
    closeResign()
    fetchEmployees()
  }

  // 🆕 กลับมาทำงาน (ล้างวันลาออก)
  async function reactivate(emp) {
    if (!window.confirm(`ให้ ${emp.nickname} กลับมาทำงานใช่ไหม? (จะล้างวันลาออกออก)`)) return
    const { error } = await supabase
      .from('employees')
      .update({ is_active: true, resigned_date: null })
      .eq('id', emp.id)
    if (error) showToast('แก้ไขไม่ได้: ' + error.message, 'error')
    else { showToast(`${emp.nickname} กลับมาทำงานแล้ว`); fetchEmployees() }
  }

  // ── ยอดคืนใน popup ลาออก ──
  const resignEmp = resignModal?.emp
  const appRefund = resignEmp?.app_fee_status === 'held' ? 100 : 0
  const totalRefund = (insBalance || 0) + appRefund

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '1rem', fontFamily: 'sans-serif', fontSize: 14 }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 999,
          background: toast.type === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: toast.type === 'error' ? '#A32D2D' : '#27500A',
          border: `0.5px solid ${toast.type === 'error' ? '#F09595' : '#C0DD97'}`,
          borderRadius: 8, padding: '10px 16px', fontWeight: 500, maxWidth: 360,
        }}>{toast.msg}</div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 18 }}>ทะเบียนลูกจ้าง KMMH</div>
          <div style={{ color: '#888', fontSize: 12 }}>บจก.กิจมั่งมีโฮม</div>
        </div>
        <button onClick={() => openModal()} style={{
          background: '#111', color: '#fff', border: 'none', borderRadius: 8,
          padding: '8px 16px', cursor: 'pointer', fontWeight: 500, fontSize: 13,
        }}>+ เพิ่มพนักงาน</button>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'พนักงานทั้งหมด', value: stats.total, sub: 'ที่ยังทำงาน' },
          { label: 'พนักงานประจำ', value: stats.perm, sub: 'คน' },
          { label: 'ทดลองงาน', value: stats.trial, sub: 'คน' },
          { label: 'จ่ายสิ้นเดือน', value: stats.eom, sub: 'คน' },
        ].map((s, i) => (
          <div key={i} style={{ background: '#f5f5f3', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#888' }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: '#aaa' }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="ค้นหาชื่อ / รหัส..."
          style={{ flex: 1, minWidth: 160, height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px' }} />
        <select value={filterType} onChange={e => setFilterType(e.target.value)}
          style={{ height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 8px' }}>
          <option value="">ประเภท: ทั้งหมด</option>
          <option value="permanent">ประจำ</option>
          <option value="trial">ทดลองงาน</option>
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          style={{ height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 8px' }}>
          <option value="">สถานะ: ทั้งหมด</option>
          <option value="active">ยังทำงาน</option>
          <option value="inactive">ลาออกแล้ว</option>
        </select>
      </div>

      {/* Table */}
      <div style={{ border: '0.5px solid #e5e5e5', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#fafafa' }}>
              {['พนักงาน','ประเภท','ค่าแรงวัน','เงินเดือน','รอบจ่าย','ประกันงาน','สถานะ',''].map((h, i) => (
                <th key={i} style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 500, color: '#888', fontSize: 12, borderBottom: '0.5px solid #e5e5e5', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: '#aaa' }}>กำลังโหลด...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: '#aaa' }}>ไม่พบพนักงาน</td></tr>
            ) : filtered.map((e, i) => {
              const col = getColor(i)
              return (
                <tr key={e.id} style={{ borderBottom: '0.5px solid #f0f0f0' }}
                  onMouseEnter={ev => ev.currentTarget.style.background = '#fafafa'}
                  onMouseLeave={ev => ev.currentTarget.style.background = ''}>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: col.bg, color: col.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
                        {getInitials(e.nickname)}
                      </div>
                      <div>
                        <div style={{ fontWeight: 500 }}>{e.nickname} — {e.full_name}</div>
                        <div style={{ fontSize: 11, color: '#aaa' }}>
                          {e.emp_code || 'ยังไม่มีรหัส'}
                          {!e.is_active && e.resigned_date && (
                            <span style={{ color: '#A32D2D', marginLeft: 6 }}>· ออก {toBE(e.resigned_date)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ background: e.emp_type === 'permanent' ? '#E6F1FB' : '#FAEEDA', color: e.emp_type === 'permanent' ? '#0C447C' : '#633806', padding: '3px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500 }}>
                      {e.emp_type === 'permanent' ? 'ประจำ' : 'ทดลองงาน'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>{fmtRate(e.daily_rate)} บ.</td>
                  <td style={{ padding: '10px 12px' }}>{e.monthly_salary ? fmtRate(e.monthly_salary) + ' บ.' : '-'}</td>
                  <td style={{ padding: '10px 12px' }}>{e.pay_schedule === 'saturday' ? 'รายเสาร์' : 'สิ้นเดือน'}</td>
                  <td style={{ padding: '10px 12px' }}>{e.insurance_level === 'none' ? '-' : e.insurance_level + ' บ.'}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ background: e.is_active ? '#EAF3DE' : '#F1EFE8', color: e.is_active ? '#27500A' : '#444', padding: '3px 8px', borderRadius: 99, fontSize: 11, fontWeight: 500 }}>
                      {e.is_active ? 'ทำงานอยู่' : 'ลาออกแล้ว'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => openModal(e)} style={{ background: 'none', border: '0.5px solid #ddd', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12, color: '#555' }}>แก้ไข</button>
                      {e.is_active ? (
                        <button onClick={() => openResign(e)} style={{ background: 'none', border: '0.5px solid #ddd', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12, color: '#A32D2D' }}>
                          ลาออก
                        </button>
                      ) : (
                        <button onClick={() => reactivate(e)} style={{ background: 'none', border: '0.5px solid #ddd', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12, color: '#27500A' }}>
                          กลับมา
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ═══ Modal แก้ไข/เพิ่ม (เดิม) ═══ */}
      {modalOpen && (
        <div onClick={e => e.target === e.currentTarget && closeModal()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '1.5rem', width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <span style={{ fontWeight: 600, fontSize: 16 }}>{editId ? 'แก้ไขข้อมูลพนักงาน' : 'เพิ่มพนักงานใหม่'}</span>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#aaa' }}>×</button>
            </div>

            {/* 🆕 แจ้งเตือนถ้ากำลังแก้คนที่ลาออกแล้ว */}
            {editId && !editIsActive && (
              <div style={{ background: '#FBF3E6', border: '0.5px solid #E8C98C', borderRadius: 8, padding: '8px 12px', marginBottom: 16, fontSize: 12, color: '#7A5418' }}>
                ⚠️ พนักงานคนนี้ลาออกแล้ว — การแก้ไขนี้จะไม่ทำให้กลับมาทำงาน (สถานะคงเดิม)
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {[
                { label: 'รหัสพนักงาน', key: 'emp_code', placeholder: 'K001', full: false },
                { label: 'ชื่อเล่น *', key: 'nickname', placeholder: 'เช่น จ๋า', full: false },
                { label: 'ชื่อ-นามสกุล *', key: 'full_name', placeholder: 'สมใจ ใจดี', full: true },
              ].map(f => (
                <div key={f.key} style={{ gridColumn: f.full ? '1/-1' : undefined }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>{f.label}</div>
                  <input value={form[f.key]} onChange={e => setF(f.key, e.target.value)} placeholder={f.placeholder}
                    style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px', boxSizing: 'border-box' }} />
                </div>
              ))}

              <div style={{ gridColumn: '1/-1', borderTop: '0.5px solid #eee', paddingTop: 10, fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ประเภทและค่าแรง</div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>ประเภทพนักงาน *</div>
                <select value={form.emp_type} onChange={e => setF('emp_type', e.target.value)}
                  style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 8px' }}>
                  <option value="trial">ทดลองงาน</option>
                  <option value="permanent">ประจำ</option>
                </select>
              </div>

              {form.emp_type === 'permanent' && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>เงินเดือน (บาท)</div>
                  <input type="number" value={form.monthly_salary} onChange={e => setF('monthly_salary', e.target.value)} placeholder="เช่น 13000"
                    style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px', boxSizing: 'border-box' }} />
                </div>
              )}

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>ค่าแรงวัน (บาท) *</div>
                <input type="number" value={form.daily_rate} onChange={e => setF('daily_rate', e.target.value)} placeholder="เช่น 400"
                  style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px', boxSizing: 'border-box' }} />
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>เงินประจำตำแหน่ง</div>
                <input type="number" value={form.position_allowance} onChange={e => setF('position_allowance', e.target.value)}
                  style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px', boxSizing: 'border-box' }} />
              </div>

              <div style={{ gridColumn: '1/-1', borderTop: '0.5px solid #eee', paddingTop: 10, fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>วันที่เริ่มงาน</div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>วันเริ่มทดลองงาน</div>
                <input type="date" value={form.trial_start_date} onChange={e => setF('trial_start_date', e.target.value)}
                  style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px', boxSizing: 'border-box' }} />
              </div>

              {form.emp_type === 'permanent' && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>วันเข้าประจำ</div>
                  <input type="date" value={form.permanent_start_date} onChange={e => setF('permanent_start_date', e.target.value)}
                    style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px', boxSizing: 'border-box' }} />
                </div>
              )}

              <div style={{ gridColumn: '1/-1', borderTop: '0.5px solid #eee', paddingTop: 10, fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>การจ่ายเงิน</div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>รอบจ่ายเงิน</div>
                <select value={form.pay_schedule} onChange={e => setF('pay_schedule', e.target.value)}
                  style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 8px' }}>
                  <option value="saturday">รายเสาร์</option>
                  <option value="end_of_month">สิ้นเดือน</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>ช่องทางรับเงิน</div>
                <select value={form.default_pay_method} onChange={e => setF('default_pay_method', e.target.value)}
                  style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 8px' }}>
                  <option value="transfer">โอนธนาคาร</option>
                  <option value="cash">รับสด</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>ประกันงาน</div>
                <select value={form.insurance_level} onChange={e => setF('insurance_level', e.target.value)}
                  style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 8px' }}>
                  <option value="none">ไม่มี</option>
                  <option value="200">200 บ./เดือน</option>
                  <option value="500">500 บ./เดือน</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>ค่าสมัครงาน</div>
                <select value={form.app_fee_status} onChange={e => setF('app_fee_status', e.target.value)}
                  style={{ width: '100%', height: 34, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 8px' }}>
                  <option value="none">ไม่มี</option>
                  <option value="held">หัก 100 บ. (เดือนแรก)</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button onClick={closeModal} style={{ height: 36, padding: '0 16px', borderRadius: 8, border: '0.5px solid #ccc', background: 'none', cursor: 'pointer', fontSize: 14 }}>ยกเลิก</button>
              <button onClick={saveEmployee} disabled={saving} style={{ height: 36, padding: '0 20px', borderRadius: 8, border: 'none', background: '#111', color: '#fff', cursor: 'pointer', fontWeight: 500, fontSize: 14, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'กำลังบันทึก...' : editId ? 'บันทึกการแก้ไข' : 'บันทึก'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ 🆕 Modal ลาออก ═══ */}
      {resignModal && (
        <div onClick={e => e.target === e.currentTarget && closeResign()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '1.5rem', width: '100%', maxWidth: 460 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontWeight: 600, fontSize: 16 }}>บันทึกการลาออก</span>
              <button onClick={closeResign} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#aaa' }}>×</button>
            </div>

            <div style={{ background: '#F7F7F5', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{resignEmp?.nickname} — {resignEmp?.full_name}</div>
              <div style={{ fontSize: 12, color: '#888' }}>
                {resignEmp?.emp_code} · {resignEmp?.emp_type === 'permanent' ? 'ประจำ' : 'ทดลองงาน'}
              </div>
            </div>

            {/* วันที่ลาออก */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: '#666', marginBottom: 4 }}>วันสุดท้ายที่ทำงาน *</div>
              <input type="date" value={resignDate} onChange={e => setResignDate(e.target.value)}
                style={{ width: '100%', height: 36, borderRadius: 8, border: '0.5px solid #ccc', padding: '0 10px', boxSizing: 'border-box' }} />
              {resignDate && (
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>= {toBE(resignDate)} (พ.ศ.)</div>
              )}
            </div>

            {/* สรุปยอดคืน */}
            <div style={{ border: '0.5px solid #e5e5e5', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ background: '#fafafa', padding: '8px 14px', fontSize: 12, fontWeight: 600, color: '#666' }}>
                ยอดที่ต้องคืนพนักงาน
              </div>
              <div style={{ padding: '4px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '0.5px solid #f0f0f0' }}>
                  <span>ประกันงานคงเหลือ</span>
                  <span style={{ fontWeight: 600 }}>
                    {insBalance === null ? 'กำลังโหลด...' : `${fmtMoney(insBalance)} บ.`}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '0.5px solid #f0f0f0' }}>
                  <span>คืนค่าสมัครงาน</span>
                  <span style={{ fontWeight: 600 }}>
                    {appRefund > 0 ? `${fmtMoney(appRefund)} บ.` : '— (ไม่ได้หักไว้)'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontWeight: 700 }}>
                  <span>รวมคืน</span>
                  <span style={{ color: '#085041' }}>
                    {insBalance === null ? '...' : `${fmtMoney(totalRefund)} บ.`}
                  </span>
                </div>
              </div>
            </div>

            {/* คำเตือนเรื่องค่าแรงงวดสุดท้าย */}
            <div style={{ background: '#EAF1FB', border: '0.5px solid #B9D3F0', borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 12, color: '#1A4B82', lineHeight: 1.6 }}>
              💡 ยอดข้างบนคือ <b>เงินคืนที่ผูกกับการลาออก</b> เท่านั้น<br />
              <b>ค่าแรงงวดสุดท้าย</b> (ตามวันทำงานจริง − สาย − ปกส.) ให้ไปกดคำนวณที่หน้า <b>เงินเดือน</b> เดือนที่ลาออก — ระบบจะรวมเงินคืนข้างบนให้อัตโนมัติ
            </div>

            {insBalance === 0 && resignEmp?.insurance_level !== 'none' && (
              <div style={{ background: '#FBF3E6', border: '0.5px solid #E8C98C', borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 12, color: '#7A5418', lineHeight: 1.6 }}>
                ⚠️ คนนี้ตั้งหักประกัน {resignEmp.insurance_level} บ./เดือน แต่กระปุกมียอด 0 — อาจยังไม่ได้ใส่ยอดที่หักสะสมมา ตรวจสอบก่อนยืนยัน
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={closeResign} style={{ height: 36, padding: '0 16px', borderRadius: 8, border: '0.5px solid #ccc', background: 'none', cursor: 'pointer', fontSize: 14 }}>ยกเลิก</button>
              <button onClick={confirmResign} disabled={resignSaving || insBalance === null} style={{ height: 36, padding: '0 20px', borderRadius: 8, border: 'none', background: '#A32D2D', color: '#fff', cursor: 'pointer', fontWeight: 500, fontSize: 14, opacity: (resignSaving || insBalance === null) ? 0.6 : 1 }}>
                {resignSaving ? 'กำลังบันทึก...' : 'ยืนยันลาออก'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
