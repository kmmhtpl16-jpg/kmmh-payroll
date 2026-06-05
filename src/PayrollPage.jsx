// src/PayrollPage.jsx
import { useState } from "react";
import { calcPayroll, savePayrollResults } from "./payrollCalc";
import { exportPayrollExcel } from "./payrollExport";

const MONTHS_TH = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.",
  "ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

const fmt    = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => Number(n || 0).toLocaleString("th-TH");

export default function PayrollPage({ role }) {
  const now = new Date();
  const [year,      setYear]      = useState(now.getFullYear() + 543);
  const [month,     setMonth]     = useState(now.getMonth() + 1);
  const [result,    setResult]    = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [exporting, setExporting] = useState(false);
  const [msg,       setMsg]       = useState(null);
  const [detail,    setDetail]    = useState(null);

  const handleCalc = async () => {
    setLoading(true); setMsg(null); setResult(null);
    try {
      const data = await calcPayroll(year - 543, month);
      setResult(data);
      if (data.summary.has_review_count > 0) {
        setMsg({ type: "warn", text: `⚠️ มี ${data.summary.has_review_count} คนที่มีข้อมูลบันทึกเวลายังต้องตรวจ — ผลอาจไม่ถูกต้อง` });
      }
    } catch (e) {
      setMsg({ type: "error", text: "❌ " + e.message });
    } finally { setLoading(false); }
  };

  const handleSave = async () => {
    if (!result) return;
    setSaving(true);
    try {
      await savePayrollResults(year - 543, month, result.results);
      setMsg({ type: "ok", text: `✅ บันทึก payroll_records ${result.results.length} คน สำเร็จ` });
    } catch (e) {
      setMsg({ type: "error", text: "❌ " + e.message });
    } finally { setSaving(false); }
  };

  const handleExport = async () => {
    if (!result) return;
    setExporting(true);
    try { await exportPayrollExcel(result, year, month); }
    catch (e) { setMsg({ type: "error", text: "❌ Export ไม่สำเร็จ: " + e.message }); }
    finally { setExporting(false); }
  };

  return (
    <div style={s.page}>

      {/* ── เลือกงวด ── */}
      <div style={s.topBar}>
        <div style={s.periodPicker}>
          <label style={s.label}>ปี (พ.ศ.)</label>
          <input type="number" value={year} onChange={e => setYear(+e.target.value)}
            style={s.input} min={2560} max={2580} />
          <label style={s.label}>เดือน</label>
          <select value={month} onChange={e => setMonth(+e.target.value)} style={s.select}>
            {MONTHS_TH.slice(1).map((m, i) => (
              <option key={i+1} value={i+1}>{m}</option>
            ))}
          </select>
        </div>
        <button onClick={handleCalc} disabled={loading} style={{ ...s.btn, ...s.btnPrimary }}>
          {loading ? "⏳ กำลังคำนวณ..." : "🧮 คำนวณเงินเดือน"}
        </button>
      </div>

      {/* ── status ── */}
      {msg && (
        <div style={{ ...s.msgBox,
          background:  msg.type==="ok" ? "#f0fdf4" : msg.type==="warn" ? "#fffbeb" : "#fef2f2",
          borderColor: msg.type==="ok" ? "#86efac" : msg.type==="warn" ? "#fde68a" : "#fca5a5",
          color:       msg.type==="ok" ? "#166534" : msg.type==="warn" ? "#92400e" : "#991b1b",
        }}>{msg.text}</div>
      )}

      {/* ── ผลลัพธ์ ── */}
      {result && (
        <>
          <div style={s.cardRow}>
            {[
              { label:"พนักงาน",   value: fmtInt(result.summary.count) + " คน", color:"#1e3a5f" },
              { label:"รายได้รวม", value: fmt(result.summary.total_income),      color:"#166534" },
              { label:"รายหักรวม", value: fmt(result.summary.total_deduct),      color:"#991b1b" },
              { label:"สุทธิรวม",  value: fmtInt(result.summary.total_net_pay),  color:"#1e40af", big:true },
              { label:"ปกส.รวม",   value: fmt(result.summary.total_ss),          color:"#6b7280" },
            ].map((c,i) => (
              <div key={i} style={{ ...s.card, borderColor: c.color }}>
                <p style={s.cardLabel}>{c.label}</p>
                <p style={{ ...s.cardValue, color: c.color, fontSize: c.big ? 20 : 16 }}>{c.value}</p>
              </div>
            ))}
          </div>

          <div style={s.actionRow}>
            <button onClick={handleSave} disabled={saving} style={{ ...s.btn, ...s.btnSuccess }}>
              {saving ? "⏳ กำลังบันทึก..." : "💾 บันทึกลง DB"}
            </button>
            <button onClick={handleExport} disabled={exporting} style={{ ...s.btn, ...s.btnExcel }}>
              {exporting ? "⏳ กำลัง export..." : "📊 ออก Excel"}
            </button>
          </div>

          <div style={{ overflowX:"auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["ชื่อ","ประเภท","วันทำงาน","OT(ชม.)","เงินเดือน","OT","ตำแหน่ง","เบี้ยขยัน",
                    "รายได้รวม","สาย(น.)","หักสาย","ปกส.","ประกันงาน","รายหักรวม","สุทธิ",""].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.employee_id} style={{ background: r.has_review ? "#fffbeb" : "white" }}
                    onClick={() => setDetail(r)}>
                    <td style={{ ...s.td, fontWeight:700 }}>
                      {r.nickname}{r.has_review && <span style={s.reviewTag}>⚠️</span>}
                    </td>
                    <td style={s.td}>{r.emp_type==="permanent" ? "ประจำ" : "ทดลอง"}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{r.work_days}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{r.ot_hours}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.base_wage)}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.ot_amount)}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.position_allowance)}</td>
                    <td style={{ ...s.td, textAlign:"right", color: r.diligence_bonus>0?"#166534":"#9ca3af" }}>
                      {fmt(r.diligence_bonus)}
                    </td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:600, color:"#166534" }}>
                      {fmt(r.total_income)}
                    </td>
                    <td style={{ ...s.td, textAlign:"right", color: r.late_minutes>0?"#dc2626":"inherit" }}>
                      {r.late_minutes}
                    </td>
                    <td style={{ ...s.td, textAlign:"right", color:"#dc2626" }}>{fmt(r.late_deduct)}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.social_security)}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.job_insurance)}</td>
                    <td style={{ ...s.td, textAlign:"right", color:"#991b1b" }}>{fmt(r.total_deduct)}</td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:700, fontSize:15, color:"#1e3a5f" }}>
                      {fmtInt(r.net_pay)}
                    </td>
                    <td style={s.td}>
                      <button onClick={e => { e.stopPropagation(); setDetail(r); }} style={s.detailBtn}>ดู</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background:"#f0f4f8", fontWeight:700 }}>
                  <td style={s.td} colSpan={4}>รวม</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((s,r)=>s+r.base_wage,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((s,r)=>s+r.ot_amount,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((s,r)=>s+r.position_allowance,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((s,r)=>s+r.diligence_bonus,0))}</td>
                  <td style={{ ...s.td, textAlign:"right", color:"#166534" }}>{fmt(result.summary.total_income)}</td>
                  <td style={s.td}></td>
                  <td style={{ ...s.td, textAlign:"right", color:"#dc2626" }}>{fmt(result.results.reduce((s,r)=>s+r.late_deduct,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.summary.total_ss)}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((s,r)=>s+r.job_insurance,0))}</td>
                  <td style={{ ...s.td, textAlign:"right", color:"#991b1b" }}>{fmt(result.summary.total_deduct)}</td>
                  <td style={{ ...s.td, textAlign:"right", color:"#1e3a5f" }}>{fmtInt(result.summary.total_net_pay)}</td>
                  <td style={s.td}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {/* ── Modal รายละเอียดรายคน ── */}
      {detail && (
        <div style={s.modalOverlay} onClick={() => setDetail(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={{ fontWeight:700, fontSize:16, color:"#fff" }}>
                {detail.nickname} — {detail.full_name}
              </span>
              <button onClick={() => setDetail(null)} style={s.closeBtn}>✕</button>
            </div>

            <div style={s.modalBody}>
              {/* รายได้ */}
              <p style={s.sectionTitle}>💰 รายได้</p>
              {[
                ["ค่าแรง/วัน",        fmt(detail.daily_rate)],
                ["วันทำงาน",          detail.work_days + " วัน"],
                ["วันอาทิตย์",        detail.holiday_days + " วัน"],
                ["ค่าแรงปกติ",        fmt(detail.base_wage)],
                ["ค่าแรงวันอาทิตย์",  fmt(detail.holiday_wage)],
                ["OT",                `${detail.ot_hours} ชม. = ${fmt(detail.ot_amount)}`],
                ["เงินประจำตำแหน่ง", fmt(detail.position_allowance)],
                ["เบี้ยขยัน",         fmt(detail.diligence_bonus)],
              ].map(([k,v]) => <Row key={k} label={k} value={v} />)}
              <Row label="รวมรายได้" value={fmt(detail.total_income)} bold green />

              {/* รายหัก */}
              <p style={{ ...s.sectionTitle, marginTop:12 }}>📉 รายหัก</p>
              {[
                ["สาย",               `${detail.late_minutes} น. = ${fmt(detail.late_deduct)}`],
                ["ประกันสังคม (5%)",  fmt(detail.social_security)],
                ["ประกันงาน",         fmt(detail.job_insurance)],
              ].map(([k,v]) => <Row key={k} label={k} value={v} />)}

              {/* ✅ รายจ่ายพนักงาน — แสดงรายการย่อย */}
              {detail.deduction_items?.length > 0 && (
                <div style={s.deductBox}>
                  <div style={s.deductHeader}>
                    📋 รายจ่ายพนักงาน
                    <span style={s.deductTotal}>{fmt(detail.other_deduct)} บาท</span>
                  </div>
                  {detail.deduction_items.map((d, i) => (
                    <div key={i} style={s.deductItem}>
                      <span style={s.deductType}>{d.deduction_types?.name || "อื่นๆ"}</span>
                      <span style={{ fontSize:12, color:"#64748b", marginLeft:6 }}>{d.deduct_date}</span>
                      <span style={{ marginLeft:"auto", fontWeight:600, color:"#991b1b" }}>
                        {fmt(d.amount)} บาท
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {detail.deduction_items?.length === 0 && (
                <Row label="รายจ่ายพนักงาน" value={fmt(0)} />
              )}

              <Row label="รวมรายหัก" value={fmt(detail.total_deduct)} bold red />

              {/* สุทธิ */}
              <div style={s.netBox}>
                <span style={{ fontWeight:600 }}>💵 สุทธิ</span>
                <span style={{ fontSize:22, fontWeight:800, color:"#1e3a5f" }}>
                  {fmtInt(detail.net_pay)} บาท
                </span>
              </div>

              {detail.has_review && (
                <div style={{ marginTop:8, padding:"8px 12px", background:"#fffbeb",
                  borderRadius:8, color:"#92400e", fontSize:13 }}>
                  ⚠️ มีข้อมูลบันทึกเวลาที่ยังต้องตรวจ — ผลอาจไม่ถูกต้อง
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold, green, red }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"4px 0",
      borderBottom:"1px solid #f1f5f9" }}>
      <span style={{ color:"#64748b", fontSize:13 }}>{label}</span>
      <span style={{ fontWeight: bold?700:400, fontSize:13,
        color: green?"#166534" : red?"#991b1b" : "#1e293b" }}>{value}</span>
    </div>
  );
}

const s = {
  page: { maxWidth:1100, margin:"0 auto" },
  topBar: { display:"flex", alignItems:"flex-end", gap:12, marginBottom:12,
    flexWrap:"wrap", background:"#fff", padding:16, borderRadius:12,
    boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  periodPicker: { display:"flex", alignItems:"center", gap:8, flex:1, flexWrap:"wrap" },
  label:  { fontSize:13, color:"#64748b", fontWeight:600 },
  input:  { width:80, padding:"6px 10px", border:"1.5px solid #e2e8f0", borderRadius:8, fontSize:14, textAlign:"center" },
  select: { padding:"6px 10px", border:"1.5px solid #e2e8f0", borderRadius:8, fontSize:14 },
  btn:        { padding:"10px 20px", borderRadius:10, border:"none", fontWeight:700, fontSize:14, cursor:"pointer" },
  btnPrimary: { background:"#2563eb", color:"#fff" },
  btnSuccess: { background:"#16a34a", color:"#fff" },
  btnExcel:   { background:"#0f766e", color:"#fff" },
  msgBox: { padding:"10px 14px", borderRadius:8, border:"1px solid", marginBottom:12, fontWeight:600, fontSize:14 },
  cardRow:   { display:"flex", gap:10, marginBottom:12, flexWrap:"wrap" },
  card:      { flex:1, minWidth:140, background:"#fff", borderRadius:10, padding:"10px 14px",
    border:"2px solid", boxShadow:"0 1px 4px rgba(0,0,0,0.06)" },
  cardLabel: { margin:0, fontSize:12, color:"#64748b" },
  cardValue: { margin:"4px 0 0", fontWeight:700 },
  actionRow: { display:"flex", gap:10, marginBottom:12 },
  table: { width:"100%", borderCollapse:"collapse", fontSize:12, background:"#fff", borderRadius:12, overflow:"hidden" },
  th: { padding:"8px 8px", textAlign:"left", background:"#1e3a5f", color:"#fff", fontWeight:700, whiteSpace:"nowrap" },
  td: { padding:"7px 8px", borderBottom:"1px solid #f1f5f9", whiteSpace:"nowrap", cursor:"pointer" },
  reviewTag: { marginLeft:4, fontSize:11 },
  detailBtn: { padding:"3px 10px", borderRadius:6, border:"1px solid #e2e8f0", background:"#f8fafc", cursor:"pointer", fontSize:12 },
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.4)",
    display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal: { background:"#fff", borderRadius:16, width:440, maxWidth:"90vw",
    maxHeight:"90vh", overflow:"auto", boxShadow:"0 20px 60px rgba(0,0,0,0.3)" },
  modalHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"14px 16px", background:"#1e3a5f", borderRadius:"16px 16px 0 0" },
  modalBody:    { padding:16 },
  closeBtn:     { background:"none", border:"none", color:"#fff", fontSize:20, cursor:"pointer", lineHeight:1 },
  sectionTitle: { margin:"4px 0 6px", fontWeight:700, fontSize:14, color:"#1e3a5f" },
  netBox: { display:"flex", justifyContent:"space-between", alignItems:"center",
    marginTop:12, padding:"10px 14px", background:"#eff6ff", borderRadius:10, border:"2px solid #bfdbfe" },
  // รายจ่ายพนักงาน
  deductBox: { border:"1px solid #fde68a", borderRadius:8, overflow:"hidden", marginBottom:4 },
  deductHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"6px 10px", background:"#fffbeb", fontWeight:700, fontSize:13, color:"#92400e" },
  deductTotal: { fontWeight:700, color:"#991b1b" },
  deductItem: { display:"flex", alignItems:"center", padding:"5px 10px",
    borderTop:"1px solid #fef9c3", fontSize:12 },
  deductType: { background:"#fef9c3", color:"#92400e", padding:"1px 7px",
    borderRadius:10, fontSize:11, fontWeight:600 },
};
