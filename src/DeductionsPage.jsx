// src/DeductionsPage.jsx
import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

const fmt = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// แปลงสตริงวันที่ "YYYY-MM-DD" (ค.ศ.) → "DD/MM/พ.ศ." (แสดงผลเท่านั้น — เก็บยังเป็น ค.ศ.)
const toBE = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
};

const CYCLE_OPTIONS = [
  { value: "saturday",  label: "🗓 วันเสาร์",   desc: "หักรอบเสาร์ที่ตรงกับสัปดาห์นี้" },
  { value: "month_end", label: "📅 สิ้นเดือน",  desc: "หักตอนปิดงวดสิ้นเดือน" },
];

// today ไม่ผ่าน toISOString (timezone)
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export default function DeductionsPage({ role }) {
  const [employees,      setEmployees]      = useState([]);
  const [deductionTypes, setDeductionTypes] = useState([]);
  const [deductions,     setDeductions]     = useState([]);
  const [loading,        setLoading]        = useState(false);

  // ── form state ──
  const [form, setForm] = useState({
    employee_id:       "",
    deduction_type_id: "",
    amount:            "",
    note:              "",
    deduct_date:       todayStr(),
    deduct_cycle:      "month_end",
  });
  const [saving,    setSaving]    = useState(false);
  const [msg,       setMsg]       = useState(null);

  // ── เพิ่มประเภทใหม่ ──
  const [newTypeName, setNewTypeName] = useState("");
  const [addingType,  setAddingType]  = useState(false);
  const [showAddType, setShowAddType] = useState(false);

  // ── แก้ไข / ลบ ──
  const [editRow,    setEditRow]    = useState(null);
  const [editVals,   setEditVals]   = useState({});
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    await Promise.all([loadEmployees(), loadTypes(), loadDeductions()]);
    setLoading(false);
  };

  const loadEmployees = async () => {
    const { data } = await supabase
      .from("employees").select("id, emp_code, nickname, full_name")
      .eq("is_active", true).order("emp_code");
    if (data) setEmployees(data);
  };

  const loadTypes = async () => {
    const { data } = await supabase
      .from("deduction_types").select("*")
      .eq("is_active", true).order("name");
    if (data) setDeductionTypes(data);
  };

  const loadDeductions = async () => {
    const { data } = await supabase
      .from("deductions")
      .select("*, employees(nickname, emp_code), deduction_types(name)")
      .order("deduct_date", { ascending: false })
      .limit(200);
    if (data) setDeductions(data);
  };

  // ── บันทึกรายจ่าย ──
  const handleSave = async () => {
    if (!form.employee_id || !form.deduction_type_id || !form.amount) {
      setMsg({ type: "error", text: "❌ กรุณากรอกข้อมูลให้ครบ" });
      return;
    }
    setSaving(true);
    setMsg(null);
    const { error } = await supabase.from("deductions").insert({
      employee_id:       form.employee_id,
      deduction_type_id: form.deduction_type_id,
      amount:            parseFloat(form.amount),
      note:              form.note || null,
      deduct_date:       form.deduct_date,
      deduct_cycle:      form.deduct_cycle,
      created_by:        role,
      is_paid:           false,
    });
    if (error) {
      setMsg({ type: "error", text: "❌ " + error.message });
    } else {
      setMsg({ type: "ok", text: "✅ บันทึกแล้ว" });
      setForm(f => ({ ...f, amount: "", note: "" }));
      loadDeductions();
    }
    setSaving(false);
  };

  // ── เพิ่มประเภทใหม่ ──
  const handleAddType = async () => {
    if (!newTypeName.trim()) return;
    setAddingType(true);
    const { error } = await supabase.from("deduction_types").insert({ name: newTypeName.trim() });
    if (!error) { setNewTypeName(""); setShowAddType(false); loadTypes(); }
    setAddingType(false);
  };

  // ── เปิด modal แก้ไข ──
  const openEdit = (row) => {
    setEditRow(row);
    setEditVals({
      amount:       row.amount,
      note:         row.note || "",
      deduct_date:  row.deduct_date,
      deduct_cycle: row.deduct_cycle || "month_end",
    });
  };

  // ── บันทึกแก้ไข ──
  const saveEdit = async () => {
    setSavingEdit(true);
    const { error } = await supabase.from("deductions").update({
      amount:       parseFloat(editVals.amount),
      note:         editVals.note || null,
      deduct_date:  editVals.deduct_date,
      deduct_cycle: editVals.deduct_cycle,
    }).eq("id", editRow.id);
    if (error) { alert("❌ " + error.message); }
    else { setEditRow(null); loadDeductions(); }
    setSavingEdit(false);
  };

  // ── ลบ ──
  const handleDelete = async (row) => {
    if (!window.confirm(`ลบรายการ "${row.deduction_types?.name}" ของ ${row.employees?.nickname} จำนวน ${fmt(row.amount)} บาท?`)) return;
    await supabase.from("deductions").delete().eq("id", row.id);
    loadDeductions();
  };

  const canEdit = (row) => !row.is_paid || role === "owner";

  const summary = employees.map(emp => {
    const rows = deductions.filter(d => d.employee_id === emp.id && !d.is_paid);
    if (rows.length === 0) return null;
    return { emp, rows, total: rows.reduce((s, r) => s + Number(r.amount), 0) };
  }).filter(Boolean);

  return (
    <div style={s.page}>

      {/* ── ฟอร์มบันทึก ── */}
      <div style={s.card}>
        <h3 style={s.cardTitle}>➕ บันทึกรายจ่ายพนักงาน</h3>

        <div style={s.formGrid}>
          {/* เลือกพนักงาน */}
          <div>
            <label style={s.label}>พนักงาน</label>
            <select value={form.employee_id}
              onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
              style={s.select}>
              <option value="">— เลือกพนักงาน —</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.nickname} ({emp.emp_code})</option>
              ))}
            </select>
          </div>

          {/* ประเภทรายจ่าย */}
          <div>
            <label style={s.label}>ประเภทรายจ่าย</label>
            <div style={{ display:"flex", gap:6 }}>
              <select value={form.deduction_type_id}
                onChange={e => setForm(f => ({ ...f, deduction_type_id: e.target.value }))}
                style={{ ...s.select, flex:1 }}>
                <option value="">— เลือกประเภท —</option>
                {deductionTypes.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button onClick={() => setShowAddType(v => !v)} style={s.addTypeBtn} title="เพิ่มประเภทใหม่">＋</button>
            </div>
          </div>

          {/* หักเมื่อไหร่ */}
          <div style={{ gridColumn:"1 / -1" }}>
            <label style={s.label}>หักเมื่อไหร่</label>
            <div style={{ display:"flex", gap:8 }}>
              {CYCLE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setForm(f => ({ ...f, deduct_cycle: opt.value }))}
                  style={{
                    ...s.cycleBtn,
                    ...(form.deduct_cycle === opt.value ? s.cycleBtnActive : {}),
                  }}>
                  <span style={{ fontWeight:700, fontSize:14 }}>{opt.label}</span>
                  <span style={{ fontSize:11, color: form.deduct_cycle === opt.value ? "#1d4ed8" : "#94a3b8", display:"block" }}>
                    {opt.desc}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* จำนวนเงิน + วันที่ทำรายการ (แถวเดียวกัน) */}
          <div>
            <label style={s.label}>จำนวนเงิน (บาท)</label>
            <input type="number" min="0" step="0.01"
              value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              placeholder="0.00"
              style={s.input} />
          </div>

          <div>
            <label style={s.label}>วันที่ทำรายการ</label>
            <input type="date" value={form.deduct_date}
              onChange={e => setForm(f => ({ ...f, deduct_date: e.target.value }))}
              style={s.input} />
          </div>

          {/* หมายเหตุ */}
          <div style={{ gridColumn:"1 / -1" }}>
            <label style={s.label}>หมายเหตุ (ถ้ามี)</label>
            <input type="text" value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
              placeholder="เช่น บิลเลขที่ / งวดที่"
              style={{ ...s.input, width:"100%" }} />
          </div>
        </div>

        {showAddType && (
          <div style={s.addTypeBox}>
            <input type="text" value={newTypeName}
              onChange={e => setNewTypeName(e.target.value)}
              placeholder="ชื่อประเภทรายจ่ายใหม่"
              style={{ ...s.input, flex:1 }}
              onKeyDown={e => e.key === "Enter" && handleAddType()} />
            <button onClick={handleAddType} disabled={addingType}
              style={{ ...s.btn, ...s.btnPrimary }}>{addingType ? "⏳" : "บันทึก"}</button>
            <button onClick={() => setShowAddType(false)} style={s.btn}>ยกเลิก</button>
          </div>
        )}

        {msg && (
          <div style={{ ...s.msgBox,
            background: msg.type==="ok"?"#f0fdf4":"#fef2f2",
            color: msg.type==="ok"?"#166534":"#991b1b",
            border: `1px solid ${msg.type==="ok"?"#86efac":"#fca5a5"}` }}>
            {msg.text}
          </div>
        )}

        <button onClick={handleSave} disabled={saving}
          style={{ ...s.btn, ...s.btnPrimary, width:"100%", marginTop:8 }}>
          {saving ? "⏳ กำลังบันทึก..." : "💾 บันทึกรายจ่าย"}
        </button>
      </div>

      {/* ── รายจ่ายที่ยังไม่ได้หัก ── */}
      <div style={s.card}>
        <h3 style={s.cardTitle}>⏳ รายจ่ายที่ยังไม่ได้หัก</h3>
        {loading && <p style={{ color:"#6b7280" }}>กำลังโหลด...</p>}
        {!loading && summary.length === 0 && (
          <p style={{ color:"#9ca3af", textAlign:"center", padding:24 }}>ยังไม่มีรายจ่ายค้างอยู่</p>
        )}
        {summary.map(({ emp, rows, total }) => (
          <div key={emp.id} style={s.empGroup}>
            <div style={s.empHeader}>
              <span style={{ fontWeight:700, fontSize:14 }}>{emp.nickname}</span>
              <span style={{ fontSize:12, color:"#64748b", marginLeft:8 }}>{emp.emp_code}</span>
              <span style={s.totalBadge}>รวม {fmt(total)} บาท</span>
            </div>
            {rows.map(row => (
              <div key={row.id} style={s.deductRow}>
                <div style={{ flex:1, display:"flex", alignItems:"center", flexWrap:"wrap", gap:4 }}>
                  <span style={s.typeBadge}>{row.deduction_types?.name}</span>
                  <span style={{ fontWeight:600 }}>{fmt(row.amount)} บาท</span>
                  {/* badge หักเมื่อไหร่ */}
                  <span style={{
                    fontSize:11, padding:"1px 7px", borderRadius:10, fontWeight:600,
                    background: row.deduct_cycle === "saturday" ? "#eff6ff" : "#f5f3ff",
                    color:      row.deduct_cycle === "saturday" ? "#1d4ed8" : "#6d28d9",
                  }}>
                    {row.deduct_cycle === "saturday" ? "🗓 เสาร์" : "📅 สิ้นเดือน"}
                  </span>
                  {row.note && <span style={{ color:"#64748b", fontSize:12 }}>— {row.note}</span>}
                  <span style={{ color:"#94a3b8", fontSize:11 }}>{toBE(row.deduct_date)}</span>
                </div>
                {canEdit(row) && (
                  <div style={{ display:"flex", gap:4 }}>
                    <button onClick={() => openEdit(row)} style={s.editBtn}>✏️</button>
                    <button onClick={() => handleDelete(row)} style={s.deleteBtn}>🗑</button>
                  </div>
                )}
                {!canEdit(row) && <span style={s.lockedBadge}>🔒 หักแล้ว</span>}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* ── ประวัติที่หักแล้ว ── */}
      <div style={s.card}>
        <h3 style={s.cardTitle}>✅ ประวัติที่หักออกแล้ว</h3>
        {deductions.filter(d => d.is_paid).length === 0 && (
          <p style={{ color:"#9ca3af", textAlign:"center", padding:16, fontSize:13 }}>ยังไม่มีประวัติ</p>
        )}
        {deductions.filter(d => d.is_paid).map(row => (
          <div key={row.id} style={{ ...s.deductRow, opacity:0.65 }}>
            <div style={{ flex:1, display:"flex", alignItems:"center", flexWrap:"wrap", gap:4 }}>
              <span style={{ fontWeight:600, fontSize:13 }}>{row.employees?.nickname}</span>
              <span style={s.typeBadge}>{row.deduction_types?.name}</span>
              <span style={{ fontWeight:600 }}>{fmt(row.amount)} บาท</span>
              {row.note && <span style={{ color:"#64748b", fontSize:12 }}>— {row.note}</span>}
              <span style={{ color:"#94a3b8", fontSize:11 }}>{toBE(row.deduct_date)}</span>
            </div>
            <span style={s.lockedBadge}>🔒 หักแล้ว</span>
            {role === "owner" && (
              <button onClick={() => openEdit(row)} style={{ ...s.editBtn, marginLeft:4 }}>✏️</button>
            )}
          </div>
        ))}
      </div>

      {/* ── Modal แก้ไข ── */}
      {editRow && (
        <div style={s.modalOverlay} onClick={() => setEditRow(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={{ fontWeight:700, color:"#fff" }}>
                ✏️ แก้ไข — {editRow.employees?.nickname} · {editRow.deduction_types?.name}
              </span>
              <button onClick={() => setEditRow(null)} style={s.closeBtn}>✕</button>
            </div>
            <div style={{ padding:16 }}>
              <div style={{ marginBottom:12 }}>
                <label style={s.label}>จำนวนเงิน (บาท)</label>
                <input type="number" value={editVals.amount}
                  onChange={e => setEditVals(v => ({ ...v, amount: e.target.value }))}
                  style={{ ...s.input, width:"100%" }} />
              </div>
              <div style={{ marginBottom:12 }}>
                <label style={s.label}>วันที่ทำรายการ</label>
                <input type="date" value={editVals.deduct_date}
                  onChange={e => setEditVals(v => ({ ...v, deduct_date: e.target.value }))}
                  style={{ ...s.input, width:"100%" }} />
              </div>
              <div style={{ marginBottom:12 }}>
                <label style={s.label}>หักเมื่อไหร่</label>
                <div style={{ display:"flex", gap:8 }}>
                  {CYCLE_OPTIONS.map(opt => (
                    <button key={opt.value}
                      onClick={() => setEditVals(v => ({ ...v, deduct_cycle: opt.value }))}
                      style={{
                        ...s.cycleBtn, flex:1,
                        ...(editVals.deduct_cycle === opt.value ? s.cycleBtnActive : {}),
                      }}>
                      <span style={{ fontWeight:700, fontSize:13 }}>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom:16 }}>
                <label style={s.label}>หมายเหตุ</label>
                <input type="text" value={editVals.note}
                  onChange={e => setEditVals(v => ({ ...v, note: e.target.value }))}
                  style={{ ...s.input, width:"100%" }} />
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={saveEdit} disabled={savingEdit}
                  style={{ ...s.btn, ...s.btnPrimary, flex:1 }}>
                  {savingEdit ? "⏳" : "💾 บันทึก"}
                </button>
                <button onClick={() => setEditRow(null)} style={s.btn}>ยกเลิก</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  page:     { maxWidth:960, margin:"0 auto", display:"flex", flexDirection:"column", gap:16 },
  card:     { background:"#fff", borderRadius:12, padding:16, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  cardTitle:{ margin:"0 0 14px", fontSize:15, fontWeight:700, color:"#1e3a5f" },
  formGrid: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 },
  label:    { display:"block", fontSize:12, color:"#64748b", fontWeight:600, marginBottom:4 },
  input:    { padding:"8px 10px", border:"1.5px solid #e2e8f0", borderRadius:8, fontSize:14, width:"100%", boxSizing:"border-box" },
  select:   { width:"100%", padding:"8px 10px", border:"1.5px solid #e2e8f0", borderRadius:8, fontSize:14 },
  btn:      { padding:"8px 16px", borderRadius:8, border:"1px solid #e2e8f0",
              background:"#f8fafc", cursor:"pointer", fontWeight:600, fontSize:14 },
  btnPrimary: { background:"#2563eb", color:"#fff", border:"none" },
  msgBox:   { padding:"8px 12px", borderRadius:8, fontWeight:600, fontSize:13, marginBottom:8 },
  addTypeBox: { display:"flex", gap:8, alignItems:"center", marginBottom:12,
               padding:10, background:"#f0f9ff", borderRadius:8, border:"1px solid #bae6fd" },
  addTypeBtn: { padding:"6px 12px", borderRadius:8, border:"1.5px solid #e2e8f0",
               background:"#f0f9ff", cursor:"pointer", fontWeight:700, fontSize:18, color:"#2563eb" },

  cycleBtn: {
    flex:1, padding:"8px 12px", borderRadius:10, border:"1.5px solid #e2e8f0",
    background:"#f8fafc", cursor:"pointer", textAlign:"left", transition:"all 0.15s",
  },
  cycleBtnActive: {
    background:"#eff6ff", borderColor:"#93c5fd", color:"#1d4ed8",
  },

  empGroup:  { marginBottom:12, border:"1px solid #e2e8f0", borderRadius:10, overflow:"hidden" },
  empHeader: { display:"flex", alignItems:"center", padding:"8px 12px",
               background:"#f8fafc", borderBottom:"1px solid #e2e8f0" },
  totalBadge:{ marginLeft:"auto", background:"#fef2f2", color:"#991b1b",
               padding:"2px 10px", borderRadius:20, fontSize:12, fontWeight:700 },
  deductRow: { display:"flex", alignItems:"center", padding:"8px 12px",
               borderBottom:"1px solid #f8fafc" },
  typeBadge: { background:"#eff6ff", color:"#1d4ed8",
               padding:"1px 8px", borderRadius:12, fontSize:11, fontWeight:600 },
  lockedBadge: { fontSize:11, color:"#9ca3af", background:"#f1f5f9", padding:"2px 8px", borderRadius:8 },
  editBtn:   { padding:"4px 8px", borderRadius:6, border:"1px solid #e2e8f0",
               background:"#fff", cursor:"pointer", fontSize:13 },
  deleteBtn: { padding:"4px 8px", borderRadius:6, border:"1px solid #fecaca",
               background:"#fef2f2", color:"#dc2626", cursor:"pointer", fontSize:13 },
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.45)",
                  display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal:     { background:"#fff", borderRadius:16, width:400, maxWidth:"92vw",
               boxShadow:"0 20px 60px rgba(0,0,0,0.3)" },
  modalHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
                 padding:"14px 16px", background:"#1e3a5f", borderRadius:"16px 16px 0 0" },
  closeBtn:  { background:"none", border:"none", color:"#fff", fontSize:20, cursor:"pointer" },
};
