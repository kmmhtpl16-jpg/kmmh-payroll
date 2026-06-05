// src/SettingsPage.jsx
// ─────────────────────────────────────────────────────────────
// หน้าตั้งค่า KMMH Payroll
// ปัจจุบันมี: จัดการวันหยุดบริษัท
// ─────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

const MONTHS_TH = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.",
  "ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

// วันหยุดราชการไทย 2569 (preset ให้เลือกได้)
const TH_HOLIDAYS_2569 = [
  { holiday_date: "2026-01-01", name: "วันขึ้นปีใหม่" },
  { holiday_date: "2026-02-12", name: "วันมาฆบูชา" },
  { holiday_date: "2026-04-06", name: "วันจักรี" },
  { holiday_date: "2026-04-13", name: "วันสงกรานต์" },
  { holiday_date: "2026-04-14", name: "วันสงกรานต์" },
  { holiday_date: "2026-04-15", name: "วันสงกรานต์" },
  { holiday_date: "2026-05-01", name: "วันแรงงานแห่งชาติ" },
  { holiday_date: "2026-05-04", name: "วันฉัตรมงคล" },
  { holiday_date: "2026-05-11", name: "วันวิสาขบูชา" },
  { holiday_date: "2026-06-03", name: "วันเฉลิมพระชนมพรรษาสมเด็จพระราชินี" },
  { holiday_date: "2026-07-09", name: "วันอาสาฬหบูชา" },
  { holiday_date: "2026-07-10", name: "วันเข้าพรรษา" },
  { holiday_date: "2026-07-28", name: "วันเฉลิมพระชนมพรรษา ร.10" },
  { holiday_date: "2026-08-12", name: "วันแม่แห่งชาติ" },
  { holiday_date: "2026-10-13", name: "วันนวมินทรมหาราช" },
  { holiday_date: "2026-10-23", name: "วันปิยมหาราช" },
  { holiday_date: "2026-12-05", name: "วันพ่อแห่งชาติ" },
  { holiday_date: "2026-12-10", name: "วันรัฐธรรมนูญ" },
  { holiday_date: "2026-12-31", name: "วันสิ้นปี" },
];

export default function SettingsPage({ role }) {
  const [holidays,    setHolidays]    = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [msg,         setMsg]         = useState(null);

  // form เพิ่มวันหยุดใหม่
  const [newDate,     setNewDate]     = useState("");
  const [newName,     setNewName]     = useState("");
  const [newPaidTrial, setNewPaidTrial] = useState(false);
  const [newNote,     setNewNote]     = useState("");

  // filter ปี
  const now = new Date();
  const [filterYear, setFilterYear] = useState(now.getFullYear() + 543);

  useEffect(() => { loadHolidays(); }, [filterYear]);

  const loadHolidays = async () => {
    setLoading(true);
    const yearAD = filterYear - 543;
    const { data, error } = await supabase
      .from("company_holidays")
      .select("*")
      .gte("holiday_date", `${yearAD}-01-01`)
      .lte("holiday_date", `${yearAD}-12-31`)
      .order("holiday_date");
    if (!error) setHolidays(data || []);
    setLoading(false);
  };

  const handleAdd = async () => {
    if (!newDate || !newName.trim()) {
      setMsg({ type:"warn", text:"⚠️ กรุณากรอกวันที่และชื่อวันหยุด" });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("company_holidays").insert({
      holiday_date:      newDate,
      name:              newName.trim(),
      is_paid_for_trial: newPaidTrial,
      note:              newNote.trim() || null,
      created_by_role:   role,
    });
    if (error) {
      setMsg({ type:"error", text:"❌ " + (error.code === "23505" ? "วันนี้มีอยู่แล้ว" : error.message) });
    } else {
      setMsg({ type:"ok", text:`✅ เพิ่ม "${newName}" สำเร็จ` });
      setNewDate(""); setNewName(""); setNewNote(""); setNewPaidTrial(false);
      loadHolidays();
    }
    setSaving(false);
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`ลบ "${name}" เลยไหม?`)) return;
    const { error } = await supabase.from("company_holidays").delete().eq("id", id);
    if (error) setMsg({ type:"error", text:"❌ " + error.message });
    else { setMsg({ type:"ok", text:`✅ ลบแล้ว` }); loadHolidays(); }
  };

  // import preset วันหยุดราชการ
  const handleImportPreset = async () => {
    if (!window.confirm(`import วันหยุดราชการ 2569 จำนวน ${TH_HOLIDAYS_2569.length} วัน?\n(ซ้ำจะถูกข้าม)`)) return;
    setSaving(true);
    const rows = TH_HOLIDAYS_2569.map(h => ({ ...h, created_by_role: role }));
    const { error } = await supabase.from("company_holidays")
      .upsert(rows, { onConflict: "holiday_date", ignoreDuplicates: true });
    if (error) setMsg({ type:"error", text:"❌ " + error.message });
    else { setMsg({ type:"ok", text:"✅ Import วันหยุดราชการ 2569 สำเร็จ" }); loadHolidays(); }
    setSaving(false);
  };

  // จัดกลุ่มตามเดือน
  const byMonth = {};
  holidays.forEach(h => {
    const m = new Date(h.holiday_date).getMonth() + 1;
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(h);
  });

  return (
    <div style={s.page}>

      {/* ── Header ─────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"center", flexWrap:"wrap", gap:10 }}>
          <div>
            <h2 style={{ margin:0, fontSize:18, color:"#1e3a5f" }}>🗓 จัดการวันหยุดบริษัท</h2>
            <p style={{ margin:"4px 0 0", fontSize:13, color:"#64748b" }}>
              วันหยุดที่บริษัทปิดเอง — พนักงานประจำได้ค่าจ้างปกติ
            </p>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <label style={s.lbl}>ปี (พ.ศ.)</label>
            <input type="number" value={filterYear}
              onChange={e=>setFilterYear(+e.target.value)}
              style={{ ...s.input, width:80 }} min={2560} max={2580} />
            <button onClick={handleImportPreset} disabled={saving}
              style={{ ...s.btn, background:"#7c3aed", color:"#fff" }}>
              📥 Import วันหยุดราชการ 2569
            </button>
          </div>
        </div>
      </div>

      {/* ── msg ─────────────────────────────────────────────── */}
      {msg && (
        <div style={{ ...s.msgBox,
          background: msg.type==="ok"?"#f0fdf4":msg.type==="warn"?"#fffbeb":"#fef2f2",
          borderColor: msg.type==="ok"?"#86efac":msg.type==="warn"?"#fde68a":"#fca5a5",
          color: msg.type==="ok"?"#166534":msg.type==="warn"?"#92400e":"#991b1b" }}>
          {msg.text}
        </div>
      )}

      {/* ── เพิ่มวันหยุดใหม่ ──────────────────────────────── */}
      <div style={s.card}>
        <p style={{ margin:"0 0 12px", fontWeight:700, fontSize:14 }}>➕ เพิ่มวันหยุด</p>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"flex-end" }}>
          <div>
            <label style={s.lbl}>วันที่</label>
            <input type="date" value={newDate} onChange={e=>setNewDate(e.target.value)}
              style={s.input} />
          </div>
          <div>
            <label style={s.lbl}>ชื่อวันหยุด</label>
            <input type="text" value={newName} onChange={e=>setNewName(e.target.value)}
              placeholder="เช่น วันหยุดพิเศษบริษัท"
              style={{ ...s.input, width:220 }} />
          </div>
          <div>
            <label style={s.lbl}>หมายเหตุ</label>
            <input type="text" value={newNote} onChange={e=>setNewNote(e.target.value)}
              placeholder="ไม่บังคับ"
              style={{ ...s.input, width:160 }} />
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, paddingBottom:2 }}>
            <input type="checkbox" id="paidTrial" checked={newPaidTrial}
              onChange={e=>setNewPaidTrial(e.target.checked)} style={{ width:16, height:16 }} />
            <label htmlFor="paidTrial" style={{ fontSize:13, color:"#374151", cursor:"pointer" }}>
              ทดลองงานได้เงินด้วย
            </label>
          </div>
          <button onClick={handleAdd} disabled={saving || !newDate || !newName}
            style={{ ...s.btn, ...s.btnPrimary,
              opacity: (!newDate || !newName) ? 0.5 : 1 }}>
            {saving ? "⏳" : "➕ เพิ่ม"}
          </button>
        </div>
      </div>

      {/* ── รายการวันหยุด ───────────────────────────────────── */}
      <div style={s.card}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:12 }}>
          <p style={{ margin:0, fontWeight:700, fontSize:14 }}>
            📋 วันหยุดปี {filterYear} ({holidays.length} วัน)
          </p>
          <button onClick={loadHolidays} style={{ ...s.btn, ...s.btnGray }}>🔄</button>
        </div>

        {loading && <p style={{ color:"#9ca3af" }}>กำลังโหลด...</p>}

        {!loading && holidays.length === 0 && (
          <p style={{ color:"#9ca3af", textAlign:"center", padding:24 }}>
            ยังไม่มีวันหยุด — เพิ่มเองหรือกด "Import วันหยุดราชการ"
          </p>
        )}

        {Object.keys(byMonth).sort((a,b)=>+a-+b).map(m => (
          <div key={m} style={{ marginBottom:16 }}>
            <p style={{ margin:"0 0 6px", fontSize:13, fontWeight:700,
              color:"#1e3a5f", borderBottom:"2px solid #e2e8f0", paddingBottom:4 }}>
              {MONTHS_TH[+m]}
            </p>
            {byMonth[m].map(h => (
              <div key={h.id} style={s.holidayRow}>
                <div style={{ display:"flex", alignItems:"center", gap:12, flex:1 }}>
                  <span style={s.dateChip}>
                    {new Date(h.holiday_date).toLocaleDateString("th-TH",
                      { day:"numeric", month:"short", year:"numeric", calendar:"buddhist" })}
                  </span>
                  <span style={{ fontWeight:600, fontSize:14 }}>{h.name}</span>
                  {h.is_paid_for_trial && (
                    <span style={s.trialBadge}>ทดลองงานได้ด้วย</span>
                  )}
                  {h.note && (
                    <span style={{ fontSize:12, color:"#94a3b8" }}>{h.note}</span>
                  )}
                </div>
                <button onClick={()=>handleDelete(h.id, h.name)} style={s.deleteBtn}>🗑</button>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* ── คำอธิบายการทำงาน ────────────────────────────────── */}
      <div style={{ ...s.card, background:"#f0f9ff", border:"1px solid #bae6fd" }}>
        <p style={{ margin:"0 0 8px", fontWeight:700, fontSize:14, color:"#0369a1" }}>
          ℹ️ วันหยุดบริษัทกระทบการคำนวณเงินเดือนอย่างไร?
        </p>
        <div style={{ fontSize:13, color:"#0c4a6e", lineHeight:1.8 }}>
          <p style={{ margin:"0 0 4px" }}>• <b>พนักงานประจำ</b> — ได้ค่าจ้างปกติ (บวก holiday_wage เข้าไป ไม่หัก work_days)</p>
          <p style={{ margin:"0 0 4px" }}>• <b>พนักงานทดลองงาน</b> — ไม่ได้ค่าจ้าง (ยกเว้นติ๊ก "ทดลองงานได้ด้วย")</p>
          <p style={{ margin:0 }}>• ระบบจะดึงวันหยุดในตารางนี้ไปใช้ตอนกด "คำนวณเงินเดือน" ในแท็บ 💰 เงินเดือน</p>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────
const s = {
  page: { maxWidth:900, margin:"0 auto" },
  card: { background:"#fff", borderRadius:12, padding:16,
    boxShadow:"0 1px 4px rgba(0,0,0,0.08)", marginBottom:12 },
  lbl: { display:"block", fontSize:12, color:"#64748b",
    fontWeight:600, marginBottom:4 },
  input: { padding:"7px 10px", border:"1.5px solid #e2e8f0",
    borderRadius:8, fontSize:14, display:"block" },
  btn: { padding:"8px 16px", borderRadius:8, border:"none",
    fontWeight:600, fontSize:13, cursor:"pointer" },
  btnPrimary: { background:"#2563eb", color:"#fff" },
  btnGray:    { background:"#f1f5f9", color:"#374151", border:"1px solid #e2e8f0" },
  msgBox: { padding:"10px 14px", borderRadius:8, border:"1px solid",
    marginBottom:12, fontWeight:600, fontSize:14 },
  holidayRow: { display:"flex", alignItems:"center", justifyContent:"space-between",
    padding:"8px 10px", borderRadius:8, marginBottom:4,
    background:"#f8fafc", border:"1px solid #f1f5f9" },
  dateChip: { background:"#dbeafe", color:"#1e40af", borderRadius:6,
    padding:"2px 10px", fontSize:12, fontWeight:700, whiteSpace:"nowrap" },
  trialBadge: { background:"#dcfce7", color:"#166534", borderRadius:4,
    padding:"1px 8px", fontSize:11, fontWeight:600 },
  deleteBtn: { background:"#fef2f2", border:"1px solid #fecaca",
    color:"#dc2626", borderRadius:8, padding:"5px 10px",
    cursor:"pointer", fontSize:14, flexShrink:0 },
};
