// src/WeeklySummaryPage.jsx
// ─────────────────────────────────────────────────────────────
// หน้าสรุปรายอาทิตย์ KMMH
// - สร้าง/เลือก pay_cycle (รอบจ่าย)
// - ดูสรุปการมาทำงาน + สาย + OT รายคน ต่อรอบ
// - บันทึก pay_cycles ลง Supabase
// - ออก Excel สรุปรอบ
// ─────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import * as XLSX from "xlsx";

const MONTHS_TH = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.",
  "ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
const DAYS_TH = ["อา","จ","อ","พ","พฤ","ศ","ส"];

const fmt  = (n) => Number(n||0).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtI = (n) => Number(n||0).toLocaleString("th-TH");

// ─── helper: วันในเดือน ────────────────────────────────────
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// ─── helper: สร้าง range วัน จ-ส อัตโนมัติในเดือน ─────────
function autoWeekRanges(yearAD, month) {
  const days = getDaysInMonth(yearAD, month);
  const ranges = [];
  let cur = new Date(yearAD, month - 1, 1);

  // หา จันทร์แรกของเดือน (หรือวันที่ 1 ถ้าเป็นจันทร์)
  while (cur.getDay() !== 1) cur = new Date(cur.getTime() + 86400000);

  while (cur.getMonth() === month - 1) {
    const from = new Date(cur);
    const to   = new Date(cur.getTime() + 5 * 86400000); // เสาร์
    const sat  = new Date(cur.getTime() + 5 * 86400000);
    ranges.push({
      date_from: from.toISOString().slice(0,10),
      date_to:   to.toISOString().slice(0,10),
      cycle_date: sat.toISOString().slice(0,10), // default = เสาร์
    });
    cur = new Date(cur.getTime() + 7 * 86400000);
  }
  return ranges;
}

export default function WeeklySummaryPage({ role }) {
  const now = new Date();
  const [yearBE,  setYearBE]  = useState(now.getFullYear() + 543);
  const [month,   setMonth]   = useState(now.getMonth() + 1);
  const [cycles,  setCycles]  = useState([]);      // pay_cycles ใน DB
  const [employees, setEmployees] = useState([]);
  const [logs,    setLogs]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState(null);
  const [selectedCycle, setSelectedCycle] = useState(null);

  // ── draft rows สำหรับสร้าง cycle ใหม่ ─────────────────────
  const [draftCycles, setDraftCycles] = useState([]);
  const [showDraft,   setShowDraft]   = useState(false);

  useEffect(() => { loadAll(); }, [yearBE, month]);

  const loadAll = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const yearAD = yearBE - 543;
      const dateFrom = `${yearAD}-${String(month).padStart(2,"0")}-01`;
      const days = getDaysInMonth(yearAD, month);
      const dateTo = `${yearAD}-${String(month).padStart(2,"0")}-${String(days).padStart(2,"0")}`;

      // โหลด employees
      const { data: emps } = await supabase
        .from("employees").select("id,emp_code,nickname,full_name,emp_type,daily_rate,monthly_salary")
        .eq("is_active", true).order("emp_code");
      setEmployees(emps || []);

      // โหลด attendance_logs ในเดือน
      const { data: logData } = await supabase
        .from("attendance_logs")
        .select("employee_id,work_date,late_minutes,ot_hours,needs_hr_review,scan_am_in,scan_pm_out")
        .gte("work_date", dateFrom).lte("work_date", dateTo);
      setLogs(logData || []);

      // โหลด pay_cycles ที่บันทึกไว้
      const { data: period } = await supabase
        .from("pay_periods").select("id")
        .eq("year", yearAD).eq("month", month).maybeSingle();

      if (period) {
        const { data: cyc } = await supabase
          .from("pay_cycles").select("*")
          .eq("period_id", period.id).order("date_from");
        setCycles(cyc || []);
      } else {
        setCycles([]);
      }
    } catch(e) {
      setMsg({ type:"error", text:"❌ โหลดข้อมูลไม่สำเร็จ: " + e.message });
    } finally {
      setLoading(false);
    }
  };

  // ── คำนวณสรุปรอบ ──────────────────────────────────────────
  function calcCycleSummary(dateFrom, dateTo) {
    const from = new Date(dateFrom);
    const to   = new Date(dateTo);
    return employees.map(emp => {
      const empLogs = logs.filter(l => {
        const d = new Date(l.work_date);
        return l.employee_id === emp.id && d >= from && d <= to;
      });
      const work_days   = empLogs.filter(l => !l.needs_hr_review).length;
      const late_minutes = empLogs.reduce((s,l) => s + (l.late_minutes||0), 0);
      const ot_hours    = empLogs.reduce((s,l) => s + (l.ot_hours||0), 0);
      const daysInMonth = getDaysInMonth(yearBE - 543, month);
      const dailyRate   = emp.emp_type === "permanent"
        ? emp.monthly_salary / daysInMonth
        : (emp.daily_rate || 0);
      const hourlyRate  = dailyRate / 8;
      const base_wage   = Math.round(dailyRate * work_days * 100) / 100;
      const ot_amount   = Math.round(hourlyRate * ot_hours * 100) / 100;
      // สาย cap ต่อวัน
      let late_deduct = 0;
      empLogs.forEach(l => {
        const m = l.late_minutes || 0;
        if (m <= 0) return;
        if (m <= 40) late_deduct += m;
        else if (m <= 60) late_deduct += hourlyRate;
        else late_deduct += hourlyRate + 1;
      });
      late_deduct = Math.round(late_deduct * 100) / 100;
      const subtotal = Math.floor(base_wage + ot_amount - late_deduct);
      return { emp, work_days, late_minutes, ot_hours, base_wage, ot_amount, late_deduct, subtotal,
        has_review: empLogs.some(l => l.needs_hr_review) };
    });
  }

  // ── สร้าง draft cycles อัตโนมัติ ─────────────────────────
  const handleAutoDraft = () => {
    const ranges = autoWeekRanges(yearBE - 543, month);
    setDraftCycles(ranges.map(r => ({ ...r, note: "" })));
    setShowDraft(true);
  };

  // ── บันทึก cycles ─────────────────────────────────────────
  const handleSaveCycles = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const yearAD = yearBE - 543;
      const daysInMonth = getDaysInMonth(yearAD, month);

      // หรือสร้าง pay_period ถ้ายังไม่มี
      let { data: period } = await supabase
        .from("pay_periods").select("id")
        .eq("year", yearAD).eq("month", month).maybeSingle();

      if (!period) {
        const { data: newP, error: pErr } = await supabase
          .from("pay_periods")
          .insert({ year: yearAD, month, days_in_month: daysInMonth })
          .select("id").single();
        if (pErr) throw new Error("สร้าง pay_period ไม่สำเร็จ: " + pErr.message);
        period = newP;
      }

      // upsert pay_cycles
      const rows = draftCycles.map(d => ({
        period_id:  period.id,
        cycle_date: d.cycle_date,
        date_from:  d.date_from,
        date_to:    d.date_to,
        note:       d.note || null,
      }));

      const { error } = await supabase
        .from("pay_cycles")
        .upsert(rows, { onConflict: "period_id,cycle_date" });
      if (error) throw new Error("บันทึกไม่สำเร็จ: " + error.message);

      setMsg({ type:"ok", text:`✅ บันทึก ${rows.length} รอบสำเร็จ` });
      setShowDraft(false);
      loadAll();
    } catch(e) {
      setMsg({ type:"error", text:"❌ " + e.message });
    } finally {
      setSaving(false);
    }
  };

  // ── mark จ่ายแล้ว ─────────────────────────────────────────
  const handleMarkPaid = async (cycleId) => {
    const { error } = await supabase
      .from("pay_cycles")
      .update({ is_paid: true, paid_at: new Date().toISOString(), paid_by_role: role })
      .eq("id", cycleId);
    if (error) { setMsg({ type:"error", text:"❌ " + error.message }); return; }
    setMsg({ type:"ok", text:"✅ mark จ่ายแล้วสำเร็จ" });
    loadAll();
  };

  // ── Export Excel ─────────────────────────────────────────
  const handleExport = (cycle) => {
    const summary = calcCycleSummary(cycle.date_from, cycle.date_to);
    const wb = XLSX.utils.book_new();

    // Sheet: สรุปรอบ
    const rows = [
      [`สรุปรายอาทิตย์ — รอบ ${cycle.date_from} ถึง ${cycle.date_to} จ่าย ${cycle.cycle_date}`],
      [],
      ["ชื่อเล่น","ชื่อ-สกุล","ประเภท","วันทำงาน","OT(ชม.)","สาย(น.)","ค่าแรง","OT","หักสาย","รวมสุทธิรอบนี้","หมายเหตุ"],
      ...summary.map(r => [
        r.emp.nickname, r.emp.full_name,
        r.emp.emp_type === "permanent" ? "ประจำ" : "ทดลอง",
        r.work_days, r.ot_hours, r.late_minutes,
        r.base_wage, r.ot_amount, r.late_deduct, r.subtotal,
        r.has_review ? "⚠️ ต้องตรวจ" : "",
      ]),
      [],
      ["รวม",null,null,
        summary.reduce((s,r)=>s+r.work_days,0),
        summary.reduce((s,r)=>s+r.ot_hours,0),
        summary.reduce((s,r)=>s+r.late_minutes,0),
        summary.reduce((s,r)=>s+r.base_wage,0),
        summary.reduce((s,r)=>s+r.ot_amount,0),
        summary.reduce((s,r)=>s+r.late_deduct,0),
        summary.reduce((s,r)=>s+r.subtotal,0),
      ],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{wch:10},{wch:22},{wch:8},{wch:10},{wch:8},{wch:8},{wch:12},{wch:10},{wch:10},{wch:14},{wch:16}];
    XLSX.utils.book_append_sheet(wb, ws, "สรุปรอบ");
    XLSX.writeFile(wb, `สรุปรายอาทิตย์_${cycle.date_from}_${cycle.date_to}.xlsx`);
  };

  // ─── Render ──────────────────────────────────────────────
  const selSummary = selectedCycle ? calcCycleSummary(selectedCycle.date_from, selectedCycle.date_to) : [];

  return (
    <div style={s.page}>

      {/* Period picker */}
      <div style={s.topBar}>
        <div style={s.picker}>
          <label style={s.lbl}>ปี (พ.ศ.)</label>
          <input type="number" value={yearBE} onChange={e=>setYearBE(+e.target.value)}
            style={s.input} min={2560} max={2580} />
          <label style={s.lbl}>เดือน</label>
          <select value={month} onChange={e=>setMonth(+e.target.value)} style={s.sel}>
            {MONTHS_TH.slice(1).map((m,i)=>(
              <option key={i+1} value={i+1}>{m}</option>
            ))}
          </select>
          <button onClick={loadAll} disabled={loading} style={{...s.btn,...s.btnGray}}>
            {loading ? "⏳" : "🔄 โหลด"}
          </button>
        </div>
        <button onClick={handleAutoDraft} style={{...s.btn,...s.btnPrimary}}>
          ➕ สร้างรอบอัตโนมัติ
        </button>
      </div>

      {/* msg */}
      {msg && (
        <div style={{...s.msg,
          background: msg.type==="ok"?"#f0fdf4":msg.type==="warn"?"#fffbeb":"#fef2f2",
          borderColor: msg.type==="ok"?"#86efac":msg.type==="warn"?"#fde68a":"#fca5a5",
          color: msg.type==="ok"?"#166534":msg.type==="warn"?"#92400e":"#991b1b"}}>
          {msg.text}
        </div>
      )}

      {/* Draft cycles */}
      {showDraft && (
        <div style={s.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <p style={{margin:0,fontWeight:700,fontSize:15}}>📋 รอบที่จะสร้าง — แก้วันจ่ายได้ก่อนบันทึก</p>
            <button onClick={()=>setShowDraft(false)} style={s.closeBtn}>✕</button>
          </div>
          <table style={s.table}>
            <thead><tr>
              <th style={s.th}>รอบที่</th>
              <th style={s.th}>ตั้งแต่</th>
              <th style={s.th}>ถึง</th>
              <th style={s.th}>วันจ่าย (แก้ได้)</th>
              <th style={s.th}>หมายเหตุ</th>
            </tr></thead>
            <tbody>
              {draftCycles.map((d,i) => (
                <tr key={i}>
                  <td style={{...s.td,textAlign:"center"}}>{i+1}</td>
                  <td style={s.td}>{d.date_from}</td>
                  <td style={s.td}>{d.date_to}</td>
                  <td style={s.td}>
                    <input type="date" value={d.cycle_date}
                      onChange={e=>{
                        const arr=[...draftCycles];
                        arr[i]={...arr[i],cycle_date:e.target.value};
                        setDraftCycles(arr);
                      }}
                      style={{...s.input,width:130}} />
                  </td>
                  <td style={s.td}>
                    <input type="text" value={d.note||""} placeholder="เช่น วันหยุดยาว"
                      onChange={e=>{
                        const arr=[...draftCycles];
                        arr[i]={...arr[i],note:e.target.value};
                        setDraftCycles(arr);
                      }}
                      style={{...s.input,width:160}} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{marginTop:12,display:"flex",gap:8}}>
            <button onClick={handleSaveCycles} disabled={saving}
              style={{...s.btn,...s.btnSuccess}}>
              {saving?"⏳ กำลังบันทึก...":"💾 บันทึกรอบทั้งหมด"}
            </button>
            <button onClick={()=>setShowDraft(false)} style={{...s.btn,...s.btnGray}}>ยกเลิก</button>
          </div>
        </div>
      )}

      {/* รายการรอบที่มีอยู่ */}
      <div style={s.card}>
        <p style={{margin:"0 0 12px",fontWeight:700,fontSize:15}}>
          📅 รอบที่บันทึกไว้ — {MONTHS_TH[month]} {yearBE}
        </p>

        {cycles.length === 0 && !loading && (
          <p style={{color:"#9ca3af",textAlign:"center",padding:24}}>
            ยังไม่มีรอบที่บันทึก — กด "สร้างรอบอัตโนมัติ" ด้านบน
          </p>
        )}

        {cycles.map((c, i) => {
          const summary = calcCycleSummary(c.date_from, c.date_to);
          const totalNet = summary.reduce((s,r)=>s+r.subtotal, 0);
          const hasReview = summary.some(r=>r.has_review);
          const isSelected = selectedCycle?.id === c.id;

          return (
            <div key={c.id} style={{...s.cycleCard,
              border:`2px solid ${isSelected?"#2563eb":c.is_paid?"#86efac":"#e2e8f0"}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                <div>
                  <span style={{fontWeight:700,fontSize:15}}>รอบ {i+1}</span>
                  <span style={{color:"#64748b",fontSize:13,marginLeft:8}}>
                    {c.date_from} → {c.date_to}
                  </span>
                  <span style={{marginLeft:8,fontSize:13,
                    color: c.is_paid?"#166534":"#1e40af",fontWeight:600}}>
                    จ่าย {c.cycle_date} {c.is_paid?"✅ จ่ายแล้ว":""}
                  </span>
                  {hasReview && <span style={s.warnBadge}>⚠️ ต้องตรวจ</span>}
                  {c.note && <span style={{fontSize:12,color:"#64748b",marginLeft:8}}>{c.note}</span>}
                </div>
                <div style={{fontWeight:700,fontSize:16,color:"#1e3a5f"}}>
                  รวม {fmtI(totalNet)} บ.
                </div>
              </div>

              <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
                <button onClick={()=>setSelectedCycle(isSelected?null:c)}
                  style={{...s.btn, background:isSelected?"#eff6ff":"#f8fafc",
                    color:isSelected?"#2563eb":"#374151", border:"1.5px solid #e2e8f0"}}>
                  {isSelected?"▲ ซ่อน":"▼ ดูรายคน"}
                </button>
                <button onClick={()=>handleExport(c)}
                  style={{...s.btn,...s.btnExcel}}>📊 Excel</button>
                {!c.is_paid && role==="owner" && (
                  <button onClick={()=>handleMarkPaid(c.id)}
                    style={{...s.btn,...s.btnSuccess}}>✅ Mark จ่ายแล้ว</button>
                )}
              </div>

              {/* รายคน */}
              {isSelected && (
                <div style={{overflowX:"auto",marginTop:12}}>
                  <table style={s.table}>
                    <thead><tr>
                      {["ชื่อ","ประเภท","วันทำงาน","OT(ชม.)","สาย(น.)","ค่าแรง","OT","หักสาย","รวม"].map(h=>(
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {summary.map(r=>(
                        <tr key={r.emp.id} style={{background:r.has_review?"#fffbeb":"white"}}>
                          <td style={{...s.td,fontWeight:600}}>
                            {r.emp.nickname}
                            {r.has_review&&<span style={{marginLeft:4,fontSize:11}}>⚠️</span>}
                          </td>
                          <td style={s.td}>{r.emp.emp_type==="permanent"?"ประจำ":"ทดลอง"}</td>
                          <td style={{...s.td,textAlign:"right"}}>{r.work_days}</td>
                          <td style={{...s.td,textAlign:"right"}}>{r.ot_hours}</td>
                          <td style={{...s.td,textAlign:"right",
                            color:r.late_minutes>0?"#dc2626":"inherit"}}>
                            {r.late_minutes}
                          </td>
                          <td style={{...s.td,textAlign:"right"}}>{fmt(r.base_wage)}</td>
                          <td style={{...s.td,textAlign:"right"}}>{fmt(r.ot_amount)}</td>
                          <td style={{...s.td,textAlign:"right",color:"#dc2626"}}>{fmt(r.late_deduct)}</td>
                          <td style={{...s.td,textAlign:"right",fontWeight:700,color:"#1e3a5f"}}>
                            {fmtI(r.subtotal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{background:"#f0f4f8",fontWeight:700}}>
                        <td style={s.td} colSpan={2}>รวม</td>
                        <td style={{...s.td,textAlign:"right"}}>{summary.reduce((s,r)=>s+r.work_days,0)}</td>
                        <td style={{...s.td,textAlign:"right"}}>{summary.reduce((s,r)=>s+r.ot_hours,0).toFixed(2)}</td>
                        <td style={{...s.td,textAlign:"right"}}>{summary.reduce((s,r)=>s+r.late_minutes,0)}</td>
                        <td style={{...s.td,textAlign:"right"}}>{fmt(summary.reduce((s,r)=>s+r.base_wage,0))}</td>
                        <td style={{...s.td,textAlign:"right"}}>{fmt(summary.reduce((s,r)=>s+r.ot_amount,0))}</td>
                        <td style={{...s.td,textAlign:"right"}}>{fmt(summary.reduce((s,r)=>s+r.late_deduct,0))}</td>
                        <td style={{...s.td,textAlign:"right",color:"#1e3a5f"}}>{fmtI(totalNet)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────
const s = {
  page: { maxWidth:1000, margin:"0 auto" },
  topBar: { display:"flex", alignItems:"flex-end", gap:12, marginBottom:12,
    flexWrap:"wrap", background:"#fff", padding:16, borderRadius:12,
    boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  picker: { display:"flex", alignItems:"center", gap:8, flex:1, flexWrap:"wrap" },
  lbl: { fontSize:13, color:"#64748b", fontWeight:600 },
  input: { padding:"6px 10px", border:"1.5px solid #e2e8f0",
    borderRadius:8, fontSize:14 },
  sel: { padding:"6px 10px", border:"1.5px solid #e2e8f0", borderRadius:8, fontSize:14 },
  btn: { padding:"8px 16px", borderRadius:8, border:"none",
    fontWeight:600, fontSize:13, cursor:"pointer" },
  btnPrimary: { background:"#2563eb", color:"#fff" },
  btnSuccess: { background:"#16a34a", color:"#fff" },
  btnExcel:   { background:"#0f766e", color:"#fff" },
  btnGray:    { background:"#f1f5f9", color:"#374151", border:"1px solid #e2e8f0" },
  msg: { padding:"10px 14px", borderRadius:8, border:"1px solid",
    marginBottom:12, fontWeight:600, fontSize:14 },
  card: { background:"#fff", borderRadius:12, padding:16,
    boxShadow:"0 1px 4px rgba(0,0,0,0.08)", marginBottom:12 },
  cycleCard: { borderRadius:10, padding:"12px 14px", marginBottom:10 },
  warnBadge: { marginLeft:8, fontSize:11, background:"#fffbeb", color:"#92400e",
    border:"1px solid #fde68a", borderRadius:4, padding:"1px 6px" },
  table: { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th: { padding:"8px 8px", textAlign:"left", background:"#1e3a5f",
    color:"#fff", fontWeight:700, whiteSpace:"nowrap" },
  td: { padding:"7px 8px", borderBottom:"1px solid #f1f5f9", whiteSpace:"nowrap" },
  closeBtn: { background:"none", border:"none", fontSize:18, cursor:"pointer", color:"#64748b" },
};
