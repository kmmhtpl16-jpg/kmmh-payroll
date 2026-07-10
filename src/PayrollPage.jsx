// src/PayrollPage.jsx
// หน้าเงินเดือน — ภาพรวมทั้งเดือนรายคน
// 🔧 v3: เลิกแยกเสาร์/สิ้นเดือน — แสดงรายได้รวม / รายหักรวม / สุทธิ ทั้งเดือน
//        (การแยกรอบจ่ายย้ายไปหน้า 📅 รายอาทิตย์)
// 🔧 v4: ตอนกด "บันทึกลง DB" ระบบจะเตรียมรายการ OT ลงหน้ารายได้พิเศษให้
//        อัตโนมัติ (ตั้งต้นจ่ายสิ้นเดือน) — ยอดสุทธิหน้านี้ยังรวม OT ตามเดิม
// 🔧 v5: ตารางเต็มความกว้างจอ + ตรึงคอลัมน์ "ชื่อ" ให้ติดซ้ายตลอดเวลาเลื่อน
// 🔧 v6: ป็อปอัปรายคนโชว์บรรทัด "คืนค่าประกันงาน" + "คืนค่าสมัครงาน" (เฉพาะตอนลาออก > 0)
import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";
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

  // 🔒 สถานะงวด (ปิดแล้ว = ห้ามบันทึกทับ)
  const [periodInfo, setPeriodInfo] = useState(null);   // { id, is_closed } | "none" | null(กำลังโหลด)
  const [unlocking,  setUnlocking]  = useState(false);

  const loadPeriod = useCallback(async () => {
    setPeriodInfo(null);
    const { data } = await supabase
      .from("pay_periods").select("id, is_closed")
      .eq("year", year - 543).eq("month", month).maybeSingle();
    setPeriodInfo(data || "none");
  }, [year, month]);

  useEffect(() => { loadPeriod(); }, [loadPeriod]);

  const isClosed = periodInfo && periodInfo !== "none" && periodInfo.is_closed === true;

  // เปิด/ปิดงวด — เจ้าของเท่านั้น (ทางปลดล็อกที่ชัดเจน ไม่ใช่ปุ่มลับ)
  const togglePeriodLock = async () => {
    if (!periodInfo || periodInfo === "none") return;
    const next = !periodInfo.is_closed;
    const warn = next
      ? `ปิดงวด ${MONTHS_TH[month]} ${year}?\nหลังปิดจะบันทึกทับไม่ได้จนกว่าจะเปิดใหม่`
      : `เปิดงวด ${MONTHS_TH[month]} ${year} ให้แก้ไขได้?\n\n⚠️ ระวัง: การกด "บันทึกลง DB" หลังเปิดงวด จะทับยอดสุทธิที่ปรับมือไว้ทั้งหมด`;
    if (!confirm(warn)) return;
    setUnlocking(true);
    try {
      const { error } = await supabase
        .from("pay_periods").update({ is_closed: next }).eq("id", periodInfo.id);
      if (error) throw error;
      setMsg({ type: next ? "ok" : "warn", text: next ? "🔒 ปิดงวดแล้ว" : "🔓 เปิดงวดแล้ว — ระวังการบันทึกทับ" });
      await loadPeriod();
    } catch (e) {
      setMsg({ type:"error", text:"❌ " + e.message });
    } finally { setUnlocking(false); }
  };

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
    if (isClosed) {
      setMsg({ type:"error", text:"🔒 งวดนี้ปิดแล้ว — บันทึกทับไม่ได้ (เปิดงวดก่อน)" });
      return;
    }
    setSaving(true);
    try {
      const res = await savePayrollResults(year - 543, month, result.results);
      let text = `✅ บันทึกเงินเดือน ${result.results.length} คน สำเร็จ`;
      const ot = res?.ot;
      const otParts = [];
      if (ot?.created) otParts.push(`เพิ่ม OT ${ot.created} คน`);
      if (ot?.updated) otParts.push(`อัปเดต OT ${ot.updated} คน`);
      if (ot?.removed) otParts.push(`เอา OT ออก ${ot.removed} คน`);
      if (otParts.length) text += " · รายได้พิเศษ: " + otParts.join(" · ");
      setMsg({ type: "ok", text });
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

      {/* ── 🔒 ป้ายสถานะงวด ── */}
      {isClosed && (
        <div style={s.lockBar}>
          <span style={{ fontWeight:800 }}>🔒 งวด {MONTHS_TH[month]} {year} ปิดแล้ว</span>
          <span style={{ flex:1, fontSize:13 }}>
            บันทึกทับไม่ได้ — ยอดสุทธิบางคนถูกปรับมือไว้ ถ้าบันทึกใหม่จะถูกทับทันที
          </span>
          {role === "owner" && (
            <button onClick={togglePeriodLock} disabled={unlocking}
              style={{ ...s.btn, background:"#b91c1c", color:"#fff", padding:"6px 12px", fontSize:13 }}>
              {unlocking ? "⏳..." : "🔓 เปิดงวด (เจ้าของ)"}
            </button>
          )}
        </div>
      )}
      {periodInfo && periodInfo !== "none" && !isClosed && role === "owner" && (
        <div style={{ ...s.lockBar, background:"#f8fafc", borderColor:"#cbd5e1", color:"#475569" }}>
          <span style={{ flex:1, fontSize:13 }}>งวด {MONTHS_TH[month]} {year} · เปิดอยู่ (แก้ไขได้)</span>
          <button onClick={togglePeriodLock} disabled={unlocking}
            style={{ ...s.btn, background:"#334155", color:"#fff", padding:"6px 12px", fontSize:13 }}>
            {unlocking ? "⏳..." : "🔒 ปิดงวด"}
          </button>
        </div>
      )}

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
              { label:"พนักงาน",     value: fmtInt(result.summary.count) + " คน", color:"#1e3a5f" },
              { label:"รายได้รวม",   value: fmt(result.summary.total_income),      color:"#166534" },
              { label:"รายหักรวม",   value: fmt(result.summary.total_deduct),      color:"#991b1b" },
              { label:"จ่ายสุทธิรวม", value: fmtInt(result.summary.total_net_pay),  color:"#1e40af", big:true },
              { label:"ปกส.รวม",     value: fmt(result.summary.total_ss),          color:"#6b7280" },
            ].map((c,i) => (
              <div key={i} style={{ ...s.card, borderColor: c.color }}>
                <p style={s.cardLabel}>{c.label}</p>
                <p style={{ ...s.cardValue, color: c.color, fontSize: c.big ? 20 : 16 }}>{c.value}</p>
              </div>
            ))}
          </div>

          <div style={s.actionRow}>
            <button onClick={handleSave} disabled={saving || isClosed}
              title={isClosed ? "งวดนี้ปิดแล้ว — เปิดงวดก่อนจึงบันทึกได้" : ""}
              style={{ ...s.btn, ...s.btnSuccess,
                ...(isClosed ? { background:"#cbd5e1", color:"#64748b", cursor:"not-allowed" } : {}) }}>
              {isClosed ? "🔒 งวดปิดแล้ว" : saving ? "⏳ กำลังบันทึก..." : "💾 บันทึกลง DB"}
            </button>
            <button onClick={handleExport} disabled={exporting} style={{ ...s.btn, ...s.btnExcel }}>
              {exporting ? "⏳ กำลัง export..." : "📊 ออก Excel"}
            </button>
          </div>

          <div style={{ overflowX:"auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["ชื่อ","ประเภท","วันทำงาน","OT(ชม.)","เงินเดือน","ค่าอาทิตย์","OT","ตำแหน่ง","เบี้ยขยัน","อื่นๆ",
                    "รายได้รวม","สาย(น.)","หักสาย","ปกส.","ประกันงาน","เบิก","รายหักรวม","สุทธิ"].map((h, idx) => (
                    <th key={h} style={idx===0 ? { ...s.th, ...s.stickyTh } : s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.employee_id} style={{ background: r.has_review ? "#fffbeb" : "white" }}
                    onClick={() => setDetail(r)}>
                    <td style={{ ...s.td, ...s.stickyTd, fontWeight:700,
                      background: r.has_review ? "#fffbeb" : "#fff" }}>
                      <span style={s.viewIcon}>🔍</span>
                      {r.nickname}{r.has_review && <span style={s.reviewTag}>⚠️</span>}
                    </td>
                    <td style={s.td}>{r.emp_type==="permanent" ? "ประจำ" : "ทดลอง"}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{r.work_days}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{r.ot_hours}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.base_wage)}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.holiday_wage)}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.ot_amount)}</td>
                    <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.position_allowance)}</td>
                    <td style={{ ...s.td, textAlign:"right", color: r.diligence_bonus>0?"#166534":"#9ca3af" }}>
                      {fmt(r.diligence_bonus)}
                    </td>
                    <td style={{ ...s.td, textAlign:"right", color: r.other_income>0?"#166534":"#9ca3af" }}>
                      {r.other_income>0 ? fmt(r.other_income) : "—"}
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
                    <td style={{ ...s.td, textAlign:"right", color: r.advance_total>0?"#dc2626":"#9ca3af" }}>
                      {r.advance_total>0 ? fmt(r.advance_total) : "—"}
                    </td>
                    <td style={{ ...s.td, textAlign:"right", color:"#991b1b" }}>{fmt(r.total_deduct)}</td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:700, fontSize:15, color:"#1e40af" }}>
                      {fmtInt(r.net_pay)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background:"#f0f4f8", fontWeight:700 }}>
                  <td style={{ ...s.td, ...s.stickyTd, background:"#f0f4f8" }} colSpan={4}>รวม</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((a,r)=>a+r.base_wage,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((a,r)=>a+r.holiday_wage,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((a,r)=>a+r.ot_amount,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((a,r)=>a+r.position_allowance,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((a,r)=>a+r.diligence_bonus,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((a,r)=>a+(r.other_income||0),0))}</td>
                  <td style={{ ...s.td, textAlign:"right", color:"#166534" }}>{fmt(result.summary.total_income)}</td>
                  <td style={s.td}></td>
                  <td style={{ ...s.td, textAlign:"right", color:"#dc2626" }}>{fmt(result.results.reduce((a,r)=>a+r.late_deduct,0))}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.summary.total_ss)}</td>
                  <td style={{ ...s.td, textAlign:"right" }}>{fmt(result.results.reduce((a,r)=>a+r.job_insurance,0))}</td>
                  <td style={{ ...s.td, textAlign:"right", color:"#dc2626" }}>{fmt(result.results.reduce((a,r)=>a+r.advance_total,0))}</td>
                  <td style={{ ...s.td, textAlign:"right", color:"#991b1b" }}>{fmt(result.summary.total_deduct)}</td>
                  <td style={{ ...s.td, textAlign:"right", color:"#1e40af" }}>{fmtInt(result.summary.total_net_pay)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {/* ── Modal รายละเอียดรายคน (ภาพรวมทั้งเดือน) ── */}
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
              {/* ── รายได้ทั้งเดือน ── */}
              <p style={s.sectionTitle}>💰 รายได้ทั้งเดือน</p>
              {[
                ["ค่าแรง/วัน",        fmt(detail.daily_rate)],
                ["วันทำงาน",          detail.work_days + " วัน"],
                ["ค่าแรงปกติ",        `+${fmt(detail.base_wage)}`],
                ["ค่าแรงวันอาทิตย์",  `+${fmt(detail.holiday_wage)}`],
                ["OT",                `${detail.ot_hours} ชม. = +${fmt(detail.ot_amount)}`],
                ["เงินประจำตำแหน่ง",  `+${fmt(detail.position_allowance)}`],
                ["เบี้ยขยัน",         `+${fmt(detail.diligence_bonus)}`],
              ].map(([k,v]) => <Row key={k} label={k} value={v} />)}
              {/* รายได้อื่นๆ — แตกเป็นบรรทัดย่อย (เช่น ค่าเที่ยว + ช่วงเวลา) ถ้ามี */}
              {detail.other_income_items?.length > 0
                ? detail.other_income_items.map((it, i) => (
                    <Row key={"oi" + i} label={it.label || "รายได้อื่นๆ"} value={`+${fmt(it.amount)}`} />
                  ))
                : detail.other_income > 0 && (
                    <Row label="รายได้อื่นๆ" value={`+${fmt(detail.other_income)}`} />
                  )}
              {detail.insurance_refund > 0 && (
                <Row label="คืนค่าประกันงาน" value={`+${fmt(detail.insurance_refund)}`} green />
              )}
              {detail.app_fee_refund > 0 && (
                <Row label="คืนค่าสมัครงาน" value={`+${fmt(detail.app_fee_refund)}`} green />
              )}
              <Row label="รวมรายได้" value={fmt(detail.total_income)} bold green />

              {/* ── รายหักทั้งเดือน ── */}
              <p style={{ ...s.sectionTitle, marginTop:14 }}>📉 รายหักทั้งเดือน</p>
              {[
                ["หักสาย",            `${detail.late_minutes} น. = (${fmt(detail.late_deduct)})`],
                ["ประกันสังคม (5%)",  `(${fmt(detail.social_security)})`],
                ["ประกันงาน",         `(${fmt(detail.job_insurance)})`],
              ].map(([k,v]) => <Row key={k} label={k} value={v} red />)}

              {/* รายจ่ายพนักงาน — แสดงรายการย่อย */}
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
              {detail.advance_total > 0 && (
                <Row label="เบิกล่วงหน้า (รวมทั้งเดือน)" value={`(${fmt(detail.advance_total)})`} red />
              )}
              <Row label="รวมรายหัก" value={fmt(detail.total_deduct)} bold red />

              {/* ── สุทธิทั้งเดือน ── */}
              <div style={s.netBox}>
                <span style={{ fontWeight:600 }}>💵 สุทธิทั้งเดือน</span>
                <span style={{ fontSize:22, fontWeight:800, color:"#1e40af" }}>
                  {fmtInt(detail.net_pay)} บาท
                </span>
              </div>

              <p style={{ marginTop:10, fontSize:12, color:"#94a3b8", textAlign:"center" }}>
                💡 ดูว่าจ่ายรอบไหนเท่าไหร่ → แท็บ 📅 รายอาทิตย์
              </p>

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
  page: { maxWidth:"100%", margin:"0 auto" },
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
  lockBar: { display:"flex", alignItems:"center", gap:10, flexWrap:"wrap",
    padding:"10px 14px", borderRadius:8, border:"1px solid #fca5a5",
    background:"#fef2f2", color:"#991b1b", marginBottom:12, fontSize:14 },
  cardRow:   { display:"flex", gap:10, marginBottom:12, flexWrap:"wrap" },
  card:      { flex:1, minWidth:140, background:"#fff", borderRadius:10, padding:"10px 14px",
    border:"2px solid", boxShadow:"0 1px 4px rgba(0,0,0,0.06)" },
  cardLabel: { margin:0, fontSize:12, color:"#64748b" },
  cardValue: { margin:"4px 0 0", fontWeight:700 },
  actionRow: { display:"flex", gap:10, marginBottom:12 },
  table: { width:"100%", borderCollapse:"collapse", fontSize:12, background:"#fff", borderRadius:12, overflow:"hidden" },
  th: { padding:"8px 8px", textAlign:"left", background:"#1e3a5f", color:"#fff", fontWeight:700, whiteSpace:"nowrap" },
  td: { padding:"7px 8px", borderBottom:"1px solid #f1f5f9", whiteSpace:"nowrap", cursor:"pointer" },
  stickyTh: { position:"sticky", left:0, zIndex:3, background:"#1e3a5f", boxShadow:"2px 0 5px rgba(0,0,0,0.12)" },
  stickyTd: { position:"sticky", left:0, zIndex:2, boxShadow:"2px 0 5px rgba(0,0,0,0.06)" },
  reviewTag: { marginLeft:4, fontSize:11 },
  viewIcon: { marginRight:6, fontSize:12, opacity:0.55 },
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
  deductBox: { border:"1px solid #fde68a", borderRadius:8, overflow:"hidden", margin:"4px 0" },
  deductHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"6px 10px", background:"#fffbeb", fontWeight:700, fontSize:13, color:"#92400e" },
  deductTotal: { fontWeight:700, color:"#991b1b" },
  deductItem: { display:"flex", alignItems:"center", padding:"5px 10px",
    borderTop:"1px solid #fef9c3", fontSize:12 },
  deductType: { background:"#fef9c3", color:"#92400e", padding:"1px 7px",
    borderRadius:10, fontSize:11, fontWeight:600 },
};
