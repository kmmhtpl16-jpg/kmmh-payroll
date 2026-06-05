// src/WeeklyPage.jsx
// หน้าสรุปรายจ่ายรายอาทิตย์ — ดึงจาก pay_cycles + payroll_records
// ต้องกด "คำนวณเงินเดือน" ใน PayrollPage ก่อน จึงจะมีข้อมูล

import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

const fmt    = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => Number(n || 0).toLocaleString("th-TH");

const DAYS_TH = ["อา","จ","อ","พ","พฤ","ศ","ส"];
const MONTHS_SHORT = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return `${dt.getDate()} ${MONTHS_SHORT[dt.getMonth() + 1]}`;
}

// คำนวณค่าแรงรอบนี้ = base_wage × (วันทำในรอบ / วันทำทั้งหมด)
// ใช้ attendance_logs นับวันทำจริงในช่วง date_from..date_to
function calcCycleWage(record, cycleDays) {
  // ถ้าไม่มีข้อมูลวันทำรอบ ใช้ base_wage หารจำนวนวันทำทั้งเดือน × วันในรอบ
  if (!record) return 0;
  const dailyRate = record.work_days > 0
    ? record.base_wage / record.work_days
    : 0;
  return parseFloat((dailyRate * cycleDays).toFixed(2));
}

export default function WeeklyPage({ role }) {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  const [cycles,        setCycles]        = useState([]);
  const [payrolls,      setPayrolls]      = useState([]); // payroll_records เดือนนี้
  const [advances,      setAdvances]      = useState([]); // advance_requests
  const [cycleLogs,     setCycleLogs]     = useState({}); // { cycle_id: { emp_id: days } }
  const [period,        setPeriod]        = useState(null); // pay_periods record
  const [loading,       setLoading]       = useState(true);
  const [marking,       setMarking]       = useState(null);
  const [markingMonthEnd, setMarkingMonthEnd] = useState(false);
  const [detail,        setDetail]        = useState(null); // { record, cycleWage, advance }
  const [msg,           setMsg]           = useState(null);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    setMsg(null);
    try {
      // 1. pay_period เดือนนี้
      const { data: period } = await supabase
        .from("pay_periods")
        .select("id")
        .eq("year", year)
        .eq("month", month)
        .single();

      if (!period) {
        setMsg({ type: "warn", text: "⚠️ ยังไม่มีข้อมูลงวดเดือนนี้ — กรุณาสร้าง pay_period ก่อน" });
        setLoading(false);
        return;
      }
      setPeriod(period);

      // 2. pay_cycles
      const { data: cyc } = await supabase
        .from("pay_cycles")
        .select("*")
        .eq("period_id", period.id)
        .order("cycle_date");
      setCycles(cyc || []);

      // 3. payroll_records — ดึง pay_schedule ด้วย
      const { data: pr } = await supabase
        .from("payroll_records")
        .select("*, employees(nickname, full_name, emp_type, emp_code, pay_schedule)")
        .eq("period_id", period.id);
      setPayrolls(pr || []);

      if ((pr || []).length === 0) {
        setMsg({ type: "warn", text: "⚠️ ยังไม่มีผลคำนวณเงินเดือน — กรุณากด 'คำนวณเงินเดือน' ในแท็บ 💰 เงินเดือน ก่อน" });
      }

      // 4. advance_requests ในเดือนนี้ (ผูก cycle)
      const cycIds = (cyc || []).map(c => c.id);
      if (cycIds.length > 0) {
        const { data: adv } = await supabase
          .from("advance_requests")
          .select("employee_id, cycle_id, amount")
          .in("cycle_id", cycIds);
        setAdvances(adv || []);
      }

      // 5. นับวันทำจริงในแต่ละรอบ จาก attendance_logs
      const empIds = (pr || []).map(r => r.employee_id);
      if (empIds.length > 0 && (cyc || []).length > 0) {
        const { data: logs } = await supabase
          .from("attendance_logs")
          .select("employee_id, work_date")
          .in("employee_id", empIds)
          .gte("work_date", `${year}-${String(month).padStart(2,"0")}-01`)
          .lte("work_date", `${year}-${String(month).padStart(2,"0")}-30`);

        // จัด index: { cycle_id: { emp_id: count } }
        const idx = {};
        for (const cyc_ of (cyc || [])) {
          idx[cyc_.id] = {};
          for (const log of (logs || [])) {
            if (log.work_date >= cyc_.date_from && log.work_date <= cyc_.date_to) {
              idx[cyc_.id][log.employee_id] = (idx[cyc_.id][log.employee_id] || 0) + 1;
            }
          }
        }
        setCycleLogs(idx);
      }
    } catch (e) {
      setMsg({ type: "error", text: "❌ โหลดข้อมูลไม่สำเร็จ: " + e.message });
    } finally { setLoading(false); }
  };

  const markPaid = async (cycle) => {
    if (cycle.is_paid) return;
    if (!window.confirm(`Mark รอบ ${fmtDate(cycle.date_from)}–${fmtDate(cycle.date_to)} ว่าจ่ายแล้วไหม?`)) return;
    setMarking(cycle.id);
    const { error } = await supabase
      .from("pay_cycles")
      .update({ is_paid: true, paid_at: new Date().toISOString() })
      .eq("id", cycle.id);
    if (error) {
      setMsg({ type: "error", text: "❌ " + error.message });
    } else {
      setCycles(prev => prev.map(c => c.id === cycle.id ? { ...c, is_paid: true } : c));
      setMsg({ type: "ok", text: `✅ Mark จ่ายแล้ว รอบ ${fmtDate(cycle.date_from)}–${fmtDate(cycle.date_to)}` });
    }
    setMarking(null);
  };

  // Mark จ่ายสิ้นเดือนแล้ว
  const markMonthEndPaid = async () => {
    if (!period) return;
    if (!window.confirm("Mark จ่ายสิ้นเดือนแล้วไหม? (อาทิตย์ + OT หักปกส.+ประกันงาน)")) return;
    setMarkingMonthEnd(true);
    const { error } = await supabase
      .from("pay_periods")
      .update({ is_month_end_paid: true, month_end_paid_at: new Date().toISOString() })
      .eq("id", period.id);
    if (error) {
      setMsg({ type: "error", text: "❌ " + error.message });
    } else {
      setPeriod(prev => ({ ...prev, is_month_end_paid: true, month_end_paid_at: new Date().toISOString() }));
      setMsg({ type: "ok", text: "✅ Mark จ่ายสิ้นเดือนแล้ว" });
    }
    setMarkingMonthEnd(false);
  };

  // คำนวณยอดจ่ายรอบนี้รายคน — เฉพาะ pay_schedule=saturday เท่านั้น
  function getCycleRows(cycle) {
    const logMap = cycleLogs[cycle.id] || {};
    return payrolls.filter(r => r.employees?.pay_schedule !== "end_of_month").map(r => {
      const cycleDays  = logMap[r.employee_id] || 0;
      const cycleWage  = calcCycleWage(r, cycleDays);
      const advAmt     = advances
        .filter(a => a.cycle_id === cycle.id && a.employee_id === r.employee_id)
        .reduce((s, a) => s + parseFloat(a.amount || 0), 0);
      const toPay = Math.max(0, cycleWage - advAmt);
      return { record: r, cycleDays, cycleWage, advAmt, toPay };
    }).filter(row => row.cycleDays > 0 || row.advAmt > 0);
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h2 style={s.title}>📅 รายอาทิตย์</h2>
        <button onClick={loadAll} style={s.refreshBtn}>🔄 โหลดใหม่</button>
      </div>

      {msg && (
        <div style={{ ...s.msgBox,
          background:  msg.type==="ok"?"#f0fdf4":msg.type==="warn"?"#fffbeb":"#fef2f2",
          borderColor: msg.type==="ok"?"#86efac":msg.type==="warn"?"#fde68a":"#fca5a5",
          color:       msg.type==="ok"?"#166534":msg.type==="warn"?"#92400e":"#991b1b",
        }}>{msg.text}</div>
      )}

      {loading && <p style={{ color:"#6b7280", textAlign:"center", padding:32 }}>⏳ กำลังโหลด...</p>}

      {!loading && cycles.map((cycle, ci) => {
        const rows     = getCycleRows(cycle);
        const totalPay = rows.reduce((s, r) => s + r.toPay, 0);

        return (
          <div key={cycle.id} style={{ ...s.cycleCard, opacity: cycle.is_paid ? 0.75 : 1 }}>

            {/* ── header รอบ ── */}
            <div style={s.cycleHeader}>
              <div>
                <span style={s.cycleLabel}>รอบที่ {ci + 1}</span>
                <span style={s.cycleDates}>
                  จ. {fmtDate(cycle.date_from)} – ส. {fmtDate(cycle.date_to)}
                </span>
              </div>
              {cycle.is_paid
                ? <span style={s.paidBadge}>✅ จ่ายแล้ว</span>
                : <span style={s.pendingBadge}>⏳ ยังไม่จ่าย</span>
              }
            </div>

            {/* ── ตารางรายคน ── */}
            {rows.length === 0
              ? <p style={{ color:"#9ca3af", padding:"12px 16px", fontSize:13 }}>
                  ยังไม่มีข้อมูลการทำงานในรอบนี้
                </p>
              : (
                <div style={{ overflowX:"auto" }}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        {["ชื่อ","ประเภท","วันทำ","ค่าแรงรอบนี้","เบิกไปแล้ว","จ่ายเสาร์",""].map(h => (
                          <th key={h} style={s.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ record: r, cycleDays, cycleWage, advAmt, toPay }) => (
                        <tr key={r.employee_id} style={s.tr}>
                          <td style={{ ...s.td, fontWeight:700 }}>
                            {r.employees?.nickname}
                            {r.has_review && <span style={s.reviewDot}>⚠️</span>}
                          </td>
                          <td style={{ ...s.td, color:"#64748b" }}>
                            {r.employees?.emp_type === "permanent" ? "ประจำ" : "ทดลอง"}
                          </td>
                          <td style={{ ...s.td, textAlign:"right" }}>{cycleDays} วัน</td>
                          <td style={{ ...s.td, textAlign:"right" }}>{fmt(cycleWage)}</td>
                          <td style={{ ...s.td, textAlign:"right",
                            color: advAmt > 0 ? "#dc2626" : "#9ca3af" }}>
                            {advAmt > 0 ? `(${fmt(advAmt)})` : "—"}
                          </td>
                          <td style={{ ...s.td, textAlign:"right",
                            fontWeight:700, fontSize:15, color:"#1e3a5f" }}>
                            {fmtInt(toPay)}
                          </td>
                          <td style={{ ...s.td, textAlign:"center" }}>
                            <button
                              onClick={() => setDetail({ record: r, cycleWage, advAmt, toPay, cycleDays })}
                              style={s.glassBtn}
                              title="ดูรายละเอียด"
                            >🔍</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background:"#f0f4f8" }}>
                        <td style={s.td} colSpan={5}>
                          <span style={{ fontWeight:700, color:"#374151" }}>รวมที่ต้องจ่าย</span>
                        </td>
                        <td style={{ ...s.td, textAlign:"right",
                          fontWeight:800, fontSize:17, color:"#1e3a5f" }}>
                          {fmtInt(totalPay)}
                        </td>
                        <td style={s.td} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            }

            {/* ── ปุ่ม Mark จ่ายแล้ว ── */}
            {!cycle.is_paid && role === "owner" && (
              <div style={s.markRow}>
                <button
                  onClick={() => markPaid(cycle)}
                  disabled={marking === cycle.id}
                  style={{ ...s.markBtn, opacity: marking === cycle.id ? 0.6 : 1 }}
                >
                  {marking === cycle.id ? "⏳ กำลังบันทึก..." : "💰 Mark จ่ายแล้ว"}
                </button>
                <span style={{ fontSize:12, color:"#94a3b8" }}>
                  รวม {fmtInt(totalPay)} บาท
                </span>
              </div>
            )}

            {cycle.is_paid && cycle.paid_at && (
              <p style={s.paidAt}>
                จ่ายแล้วเมื่อ {new Date(cycle.paid_at).toLocaleString("th-TH")}
              </p>
            )}

          </div>
        );
      })}

      {/* ══ Section สิ้นเดือน ══ */}
      {payrolls.length > 0 && (
        <div style={{ ...s.cycleCard,
          opacity: period?.is_month_end_paid ? 0.75 : 1,
          border: "2px solid #7c3aed" }}>

          <div style={{ ...s.cycleHeader, background:"#4c1d95" }}>
            <div>
              <span style={s.cycleLabel}>💜 สิ้นเดือน</span>
              <span style={s.cycleDates}>ค่าแรงวันอาทิตย์ + OT ทั้งเดือน</span>
            </div>
            {period?.is_month_end_paid
              ? <span style={s.paidBadge}>✅ จ่ายแล้ว</span>
              : <span style={s.pendingBadge}>⏳ ยังไม่จ่าย</span>
            }
          </div>

          <div style={{ overflowX:"auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["ชื่อ","ประเภท","รอบจ่าย","อาทิตย์(วัน)","ค่าอาทิตย์","OT(ชม.)","ค่า OT","ปกส.","ประกันงาน","จ่ายสิ้นเดือน",""].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payrolls.map(r => {
                  const isMonthEnd = r.employees?.pay_schedule === "end_of_month";
                  // end_of_month: รับทุกอย่างสิ้นเดือน (ค่าแรง+อาทิตย์+OT−ทุกหัก)
                  // saturday: รับแค่ อาทิตย์+OT−ปกส.−ประกันงาน (ค่าแรงรับรายเสาร์แล้ว)
                  const monthEndPay = Math.max(0, isMonthEnd
                    ? (r.base_wage || 0) + (r.holiday_wage || 0) + (r.ot_amount || 0)
                      - (r.late_deduct || 0) - (r.social_security || 0)
                      - (r.job_insurance || 0) - (r.other_deduct || 0) - (r.advance_total || 0)
                    : (r.holiday_wage || 0) + (r.ot_amount || 0)
                      - (r.social_security || 0) - (r.job_insurance || 0)
                  );
                  return (
                    <tr key={r.employee_id} style={s.tr}>
                      <td style={{ ...s.td, fontWeight:700 }}>
                        {r.employees?.nickname}
                        {r.has_review && <span style={s.reviewDot}>⚠️</span>}
                      </td>
                      <td style={{ ...s.td, color:"#64748b" }}>
                        {r.employees?.emp_type === "permanent" ? "ประจำ" : "ทดลอง"}
                      </td>
                      <td style={{ ...s.td, textAlign:"center" }}>
                        <span style={{
                          fontSize:12, padding:"3px 10px", borderRadius:20, fontWeight:700,
                          letterSpacing:0.3,
                          background: isMonthEnd ? "#7c3aed" : "#0ea5e9",
                          color: "#fff",
                          boxShadow: isMonthEnd
                            ? "0 1px 4px rgba(124,58,237,0.4)"
                            : "0 1px 4px rgba(14,165,233,0.4)",
                        }}>
                          {isMonthEnd ? "💜 สิ้นเดือน" : "🔵 รายเสาร์"}
                        </span>
                      </td>
                      <td style={{ ...s.td, textAlign:"right" }}>{r.holiday_days || 0} วัน</td>
                      <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.holiday_wage)}</td>
                      <td style={{ ...s.td, textAlign:"right" }}>{r.ot_hours || 0} ชม.</td>
                      <td style={{ ...s.td, textAlign:"right" }}>{fmt(r.ot_amount)}</td>
                      <td style={{ ...s.td, textAlign:"right", color:"#dc2626" }}>
                        {r.social_security > 0 ? `(${fmt(r.social_security)})` : "—"}
                      </td>
                      <td style={{ ...s.td, textAlign:"right", color:"#dc2626" }}>
                        {r.job_insurance > 0 ? `(${fmt(r.job_insurance)})` : "—"}
                      </td>
                      <td style={{ ...s.td, textAlign:"right",
                        fontWeight:700, fontSize:15, color:"#4c1d95" }}>
                        {fmtInt(monthEndPay)}
                      </td>
                      <td style={{ ...s.td, textAlign:"center" }}>
                        <button
                          onClick={() => setDetail({ record: r,
                            cycleWage: isMonthEnd
                              ? (r.base_wage||0)+(r.holiday_wage||0)+(r.ot_amount||0)
                              : (r.holiday_wage||0)+(r.ot_amount||0),
                            advAmt: isMonthEnd
                              ? (r.late_deduct||0)+(r.social_security||0)+(r.job_insurance||0)+(r.other_deduct||0)+(r.advance_total||0)
                              : (r.social_security||0)+(r.job_insurance||0),
                            toPay: monthEndPay,
                            cycleDays: r.holiday_days || 0,
                            isMonthEnd: true })}
                          style={s.glassBtn} title="ดูรายละเอียด">🔍</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background:"#f5f3ff" }}>
                  <td style={s.td} colSpan={9}>
                    <span style={{ fontWeight:700, color:"#4c1d95" }}>รวมที่ต้องจ่ายสิ้นเดือน</span>
                  </td>
                  <td style={{ ...s.td, textAlign:"right",
                    fontWeight:800, fontSize:17, color:"#4c1d95" }}>
                    {fmtInt(payrolls.reduce((sum, r) => {
                      const isME = r.employees?.pay_schedule === "end_of_month";
                      return sum + Math.max(0, isME
                        ? (r.base_wage||0)+(r.holiday_wage||0)+(r.ot_amount||0)-(r.late_deduct||0)-(r.social_security||0)-(r.job_insurance||0)-(r.other_deduct||0)-(r.advance_total||0)
                        : (r.holiday_wage||0)+(r.ot_amount||0)-(r.social_security||0)-(r.job_insurance||0));
                    }, 0))}
                  </td>
                  <td style={s.td} />
                </tr>
              </tfoot>
            </table>
          </div>

          {!period?.is_month_end_paid && role === "owner" && (
            <div style={s.markRow}>
              <button
                onClick={markMonthEndPaid}
                disabled={markingMonthEnd}
                style={{ ...s.markBtn, background:"#7c3aed",
                  opacity: markingMonthEnd ? 0.6 : 1 }}>
                {markingMonthEnd ? "⏳ กำลังบันทึก..." : "💜 Mark จ่ายสิ้นเดือนแล้ว"}
              </button>
              <span style={{ fontSize:12, color:"#94a3b8" }}>
                อาทิตย์ + OT หักปกส.+ประกันงาน
              </span>
            </div>
          )}

          {period?.is_month_end_paid && period?.month_end_paid_at && (
            <p style={s.paidAt}>
              จ่ายแล้วเมื่อ {new Date(period.month_end_paid_at).toLocaleString("th-TH")}
            </p>
          )}
        </div>
      )}

      {/* ══ Modal รายละเอียดรายคน ══ */}
      {detail && (
        <div style={s.modalOverlay} onClick={() => setDetail(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={{ fontWeight:700, fontSize:15, color:"#fff" }}>
                🔍 {detail.record.employees?.nickname} — {detail.record.employees?.full_name}
              </span>
              <button onClick={() => setDetail(null)} style={s.closeBtn}>✕</button>
            </div>

            <div style={s.modalBody}>

              {/* รอบนี้ */}
              <div style={s.cycleBox}>
                <span style={{ fontWeight:700, color:"#1e3a5f" }}>รอบนี้จ่าย</span>
                <span style={{ fontWeight:800, fontSize:20, color:"#1e3a5f" }}>
                  {fmtInt(detail.toPay)} บาท
                </span>
              </div>
              <MiniRow label="ค่าแรงรอบนี้ ({detail.cycleDays} วัน)" value={fmt(detail.cycleWage)} />
              {detail.advAmt > 0 && <MiniRow label="หักเบิก" value={`(${fmt(detail.advAmt)})`} red />}

              <div style={s.divider} />

              {/* รายได้ทั้งเดือน */}
              <p style={s.sectionTitle}>💰 รายได้ทั้งเดือน</p>
              {[
                ["ค่าแรงปกติ",          fmt(detail.record.base_wage)],
                ["ค่าแรงวันอาทิตย์",    fmt(detail.record.holiday_wage)],
                ["OT",                  `${detail.record.ot_hours} ชม. = ${fmt(detail.record.ot_amount)}`],
                ["เงินประจำตำแหน่ง",   fmt(detail.record.position_allowance)],
                ["เบี้ยขยัน",           fmt(detail.record.diligence_bonus)],
              ].map(([k,v]) => <MiniRow key={k} label={k} value={v} />)}
              <MiniRow label="รวมรายได้" value={fmt(detail.record.total_income)} bold green />

              <div style={s.divider} />

              {/* รายหักทั้งเดือน */}
              <p style={s.sectionTitle}>📉 รายหักทั้งเดือน</p>
              {[
                ["สาย",                 `${detail.record.late_minutes} น. = ${fmt(detail.record.late_deduct)}`],
                ["ประกันสังคม (5%)",    fmt(detail.record.social_security)],
                ["ประกันงาน",           fmt(detail.record.job_insurance)],
                ["รายจ่ายพนักงาน",     fmt(detail.record.other_deduct)],
                ["เบิกล่วงหน้า (รวม)", fmt(detail.record.advance_total)],
              ].map(([k,v]) => <MiniRow key={k} label={k} value={v} />)}
              <MiniRow label="รวมรายหัก" value={fmt(detail.record.total_deduct)} bold red />

              <div style={s.divider} />

              {/* สุทธิทั้งเดือน */}
              <div style={s.netBox}>
                <span style={{ fontWeight:600, color:"#475569" }}>💵 สุทธิทั้งเดือน</span>
                <span style={{ fontWeight:800, fontSize:20, color:"#1e3a5f" }}>
                  {fmtInt(detail.record.net_pay)} บาท
                </span>
              </div>

              {detail.record.has_review && (
                <div style={s.reviewNote}>
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

function MiniRow({ label, value, bold, green, red }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between",
      padding:"5px 0", borderBottom:"1px solid #f1f5f9" }}>
      <span style={{ color:"#64748b", fontSize:13 }}>{label}</span>
      <span style={{ fontWeight: bold?700:400, fontSize:13,
        color: green?"#166534":red?"#991b1b":"#1e293b" }}>{value}</span>
    </div>
  );
}

const s = {
  page: { maxWidth:960, margin:"0 auto" },
  header: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 },
  title:  { margin:0, fontSize:18, fontWeight:800, color:"#1e3a5f" },
  refreshBtn: { padding:"6px 14px", borderRadius:8, border:"1px solid #e2e8f0",
    background:"#f8fafc", cursor:"pointer", fontSize:13 },
  msgBox: { padding:"10px 14px", borderRadius:8, border:"1px solid",
    marginBottom:12, fontWeight:600, fontSize:14 },

  cycleCard: { background:"#fff", borderRadius:14, marginBottom:16,
    boxShadow:"0 1px 6px rgba(0,0,0,0.08)", overflow:"hidden" },
  cycleHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"12px 16px", background:"#1e3a5f", color:"#fff" },
  cycleLabel:  { fontWeight:800, fontSize:14, marginRight:10 },
  cycleDates:  { fontSize:13, color:"#93c5fd" },
  paidBadge:   { fontSize:12, background:"#dcfce7", color:"#166534",
    padding:"3px 10px", borderRadius:20, fontWeight:700 },
  pendingBadge:{ fontSize:12, background:"#fef9c3", color:"#92400e",
    padding:"3px 10px", borderRadius:20, fontWeight:700 },

  table: { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th: { padding:"8px 12px", textAlign:"left", background:"#f8fafc",
    borderBottom:"2px solid #e2e8f0", fontWeight:700, color:"#374151", whiteSpace:"nowrap" },
  tr: { transition:"background 0.1s" },
  td: { padding:"9px 12px", borderBottom:"1px solid #f1f5f9", whiteSpace:"nowrap" },
  reviewDot: { marginLeft:4, fontSize:11 },

  glassBtn: { background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8,
    padding:"4px 10px", cursor:"pointer", fontSize:14 },

  markRow: { display:"flex", alignItems:"center", gap:12,
    padding:"12px 16px", borderTop:"1px solid #f1f5f9" },
  markBtn: { padding:"8px 20px", borderRadius:10, border:"none",
    background:"#16a34a", color:"#fff", fontWeight:700, fontSize:14, cursor:"pointer" },
  paidAt: { margin:0, padding:"8px 16px", fontSize:12,
    color:"#6b7280", borderTop:"1px solid #f1f5f9" },

  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.4)",
    display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal: { background:"#fff", borderRadius:16, width:420, maxWidth:"90vw",
    maxHeight:"88vh", overflow:"auto", boxShadow:"0 20px 60px rgba(0,0,0,0.3)" },
  modalHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"14px 16px", background:"#1e3a5f", borderRadius:"16px 16px 0 0",
    position:"sticky", top:0, zIndex:1 },
  modalBody: { padding:16 },
  closeBtn: { background:"none", border:"none", color:"#fff", fontSize:20,
    cursor:"pointer", lineHeight:1 },

  cycleBox: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"10px 14px", background:"#eff6ff", borderRadius:10,
    border:"2px solid #bfdbfe", marginBottom:12 },
  divider:     { borderTop:"2px solid #f1f5f9", margin:"12px 0" },
  sectionTitle:{ margin:"4px 0 6px", fontWeight:700, fontSize:14, color:"#1e3a5f" },
  netBox: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"10px 14px", background:"#f0fdf4", borderRadius:10,
    border:"2px solid #86efac", marginTop:8 },
  reviewNote: { marginTop:8, padding:"8px 12px", background:"#fffbeb",
    borderRadius:8, color:"#92400e", fontSize:13 },
};
