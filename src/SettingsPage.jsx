// src/SettingsPage.jsx — หน้าวันหยุดบริษัท
import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

const MONTHS_TH = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.",
  "ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

const DAY_TH = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัส","ศุกร์","เสาร์"];

function formatDateTH(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${DAY_TH[d.getDay()]} ${d.getDate()} ${MONTHS_TH[d.getMonth()+1]} ${d.getFullYear()+543}`;
}

export default function SettingsPage({ role }) {
  const now = new Date();
  const [holidays, setHolidays] = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [filterYear, setFilterYear] = useState(now.getFullYear());

  // ── form ──
  const [form, setForm] = useState({
    holiday_date: "",
    name: "",
  });
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => { loadHolidays(); }, [filterYear]);

  const loadHolidays = async () => {
    setLoading(true);
    const from = `${filterYear}-01-01`;
    const to   = `${filterYear}-12-31`;
    const { data } = await supabase
      .from("company_holidays")
      .select("*")
      .gte("holiday_date", from)
      .lte("holiday_date", to)
      .order("holiday_date");
    if (data) setHolidays(data);
    setLoading(false);
  };

  const handleSave = async () => {
    if (!form.holiday_date || !form.name.trim()) {
      setMsg({ type: "error", text: "❌ กรุณากรอกวันที่และชื่อวันหยุด" });
      return;
    }
    // ตรวจว่าเป็นวันอาทิตย์ไหม
    const d = new Date(form.holiday_date + "T00:00:00");
    if (d.getDay() === 0) {
      setMsg({ type: "warn", text: "⚠️ วันอาทิตย์เป็นวันหยุดอัตโนมัติอยู่แล้ว ไม่จำเป็นต้องบันทึก" });
      return;
    }
    setSaving(true);
    setMsg(null);
    const { error } = await supabase.from("company_holidays").insert({
      holiday_date: form.holiday_date,
      name: form.name.trim(),
    });
    if (error) {
      if (error.code === "23505") {
        setMsg({ type: "error", text: "❌ วันนี้บันทึกไปแล้ว" });
      } else {
        setMsg({ type: "error", text: "❌ " + error.message });
      }
    } else {
      setMsg({ type: "ok", text: "✅ บันทึกวันหยุดแล้ว" });
      setForm({ holiday_date: "", name: "" });
      loadHolidays();
    }
    setSaving(false);
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`ลบวันหยุด "${row.name}" (${formatDateTH(row.holiday_date)}) ออกไหม?`)) return;
    await supabase.from("company_holidays").delete().eq("id", row.id);
    loadHolidays();
  };

  // group by เดือน
  const byMonth = {};
  holidays.forEach(h => {
    const m = h.holiday_date.slice(5, 7);
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(h);
  });

  return (
    <div style={s.page}>

      {/* ── หัว ── */}
      <div style={s.card}>
        <h3 style={s.cardTitle}>📅 วันหยุดบริษัท</h3>
        <p style={{ margin:"0 0 4px", fontSize:13, color:"#64748b" }}>
          บันทึกวันหยุดพิเศษของบริษัท — ระบบจะไม่นับวันเหล่านี้เป็นวันขาดงาน
        </p>
        <div style={s.infoBanner}>
          🗓 <strong>วันอาทิตย์</strong> เป็นวันหยุดอัตโนมัติ — ไม่ต้องบันทึก
        </div>
      </div>

      {/* ── ฟอร์มเพิ่ม ── */}
      <div style={s.card}>
        <h3 style={s.cardTitle}>➕ เพิ่มวันหยุด</h3>
        <div style={s.formRow}>
          <div style={{ flex:1 }}>
            <label style={s.label}>วันที่</label>
            <input type="date" value={form.holiday_date}
              onChange={e => setForm(f => ({ ...f, holiday_date: e.target.value }))}
              style={s.input} />
          </div>
          <div style={{ flex:2 }}>
            <label style={s.label}>ชื่อวันหยุด</label>
            <input type="text" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="เช่น วันสงกรานต์, วันหยุดพิเศษ"
              style={{ ...s.input, width:"100%" }}
              onKeyDown={e => e.key === "Enter" && handleSave()} />
          </div>
          <div style={{ alignSelf:"flex-end" }}>
            <button onClick={handleSave} disabled={saving}
              style={{ ...s.btn, ...s.btnPrimary }}>
              {saving ? "⏳" : "💾 บันทึก"}
            </button>
          </div>
        </div>

        {msg && (
          <div style={{ ...s.msgBox,
            background: msg.type==="ok" ? "#f0fdf4" : msg.type==="warn" ? "#fffbeb" : "#fef2f2",
            color: msg.type==="ok" ? "#166534" : msg.type==="warn" ? "#92400e" : "#991b1b",
            border: `1px solid ${msg.type==="ok" ? "#86efac" : msg.type==="warn" ? "#fde68a" : "#fca5a5"}` }}>
            {msg.text}
          </div>
        )}
      </div>

      {/* ── รายการวันหยุด ── */}
      <div style={s.card}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <h3 style={{ ...s.cardTitle, margin:0 }}>
            วันหยุดปี พ.ศ. {filterYear + 543}
          </h3>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <button onClick={() => setFilterYear(y => y-1)} style={s.yearBtn}>◀</button>
            <span style={{ fontWeight:700, minWidth:60, textAlign:"center" }}>{filterYear + 543}</span>
            <button onClick={() => setFilterYear(y => y+1)} style={s.yearBtn}>▶</button>
            <button onClick={loadHolidays} style={s.refreshBtn}>🔄</button>
          </div>
        </div>

        {loading && <p style={{ color:"#6b7280" }}>กำลังโหลด...</p>}

        {!loading && holidays.length === 0 && (
          <p style={{ color:"#9ca3af", textAlign:"center", padding:24 }}>
            ยังไม่มีวันหยุดที่บันทึกในปีนี้
          </p>
        )}

        {Object.keys(byMonth).sort().map(m => (
          <div key={m} style={{ marginBottom:12 }}>
            <div style={s.monthHeader}>
              {MONTHS_TH[parseInt(m)]} {filterYear + 543}
              <span style={s.countBadge}>{byMonth[m].length} วัน</span>
            </div>
            {byMonth[m].map(h => (
              <div key={h.id} style={s.holidayRow}>
                <div style={{ flex:1 }}>
                  <span style={s.dateTH}>{formatDateTH(h.holiday_date)}</span>
                  <span style={s.holidayName}>{h.name}</span>
                </div>
                <button onClick={() => handleDelete(h)} style={s.deleteBtn}>🗑</button>
              </div>
            ))}
          </div>
        ))}

        {holidays.length > 0 && (
          <div style={s.totalRow}>
            รวมทั้งปี <strong>{holidays.length} วันหยุด</strong>
            {" "}(ไม่นับวันอาทิตย์)
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  page: { maxWidth:760, margin:"0 auto", display:"flex", flexDirection:"column", gap:16 },
  card: { background:"#fff", borderRadius:12, padding:16, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  cardTitle: { margin:"0 0 12px", fontSize:15, fontWeight:700, color:"#1e3a5f" },
  infoBanner: { background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8,
    padding:"8px 12px", fontSize:13, color:"#1e40af", marginTop:8 },
  formRow: { display:"flex", gap:12, alignItems:"flex-start", flexWrap:"wrap" },
  label: { display:"block", fontSize:12, color:"#64748b", fontWeight:600, marginBottom:4 },
  input: { padding:"8px 10px", border:"1.5px solid #e2e8f0", borderRadius:8, fontSize:14 },
  btn: { padding:"9px 18px", borderRadius:8, border:"1px solid #e2e8f0",
    background:"#f8fafc", cursor:"pointer", fontWeight:600, fontSize:14 },
  btnPrimary: { background:"#2563eb", color:"#fff", border:"none" },
  msgBox: { padding:"8px 12px", borderRadius:8, fontWeight:600, fontSize:13, marginTop:10 },
  monthHeader: { display:"flex", alignItems:"center", gap:8, padding:"6px 10px",
    background:"#f8fafc", borderRadius:8, marginBottom:4,
    fontWeight:700, fontSize:13, color:"#1e3a5f" },
  countBadge: { background:"#dbeafe", color:"#1d4ed8", padding:"1px 8px",
    borderRadius:12, fontSize:11, fontWeight:600 },
  holidayRow: { display:"flex", alignItems:"center", padding:"8px 10px",
    borderBottom:"1px solid #f8fafc" },
  dateTH: { fontSize:13, color:"#64748b", marginRight:12, minWidth:160, display:"inline-block" },
  holidayName: { fontWeight:600, fontSize:14 },
  deleteBtn: { padding:"4px 8px", borderRadius:6, border:"1px solid #fecaca",
    background:"#fef2f2", color:"#dc2626", cursor:"pointer", fontSize:13 },
  yearBtn: { padding:"4px 10px", borderRadius:6, border:"1px solid #e2e8f0",
    background:"#f8fafc", cursor:"pointer", fontWeight:700 },
  refreshBtn: { padding:"4px 10px", borderRadius:6, border:"1px solid #e2e8f0",
    background:"#f8fafc", cursor:"pointer" },
  totalRow: { textAlign:"right", fontSize:13, color:"#64748b", marginTop:8, paddingTop:8,
    borderTop:"1px solid #e2e8f0" },
};
