// src/WeeklyPage.jsx
// หน้าสรุปรายจ่ายบริษัท — รอบเสาร์ + สิ้นเดือน
//
// ─── ทาง B (v4) ───────────────────────────────────────────────
// รอบคำนวณจากวันสแกนจริงใน attendance_logs
//   ไม่พึ่ง pay_cycles.date_from/date_to อีก (timezone bug เดิม)
//
// ─── ระบบ payout_vouchers ─────────────────────────────────────
// flow: draft → submitted (HR) → approved/returned (owner)
//   returned → HR แก้ + ยื่นใหม่
//   ตอน submitted: freeze snapshot lines (jsonb) — ยอดไม่เปลี่ยนตามหลัง
//
// ─── กฎห้ามพัง ────────────────────────────────────────────────
//   เสาร์ทุกรอบ + สิ้นเดือน = net_pay เป๊ะเสมอ ทุกคน
//
// format date ไม่ใช้ toISOString() (timezone bug) → format ตรงๆ

import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

const MONTHS_SHORT = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

// format วันจาก Date object → "5 มิ.ย." (ห้ามใช้ toISOString)
function fmtDate(d) {
  if (!d) return "";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth() + 1]}`;
}

// YYYY-MM-DD จาก Date โดยไม่ผ่าน UTC (ป้องกัน timezone shift)
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

const fmt    = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => Number(n || 0).toLocaleString("th-TH");

// badge สถานะ voucher
const STATUS_LABEL = {
  draft:     { text: "📝 ร่าง",        bg: "#f1f5f9", color: "#475569" },
  submitted: { text: "📤 รออนุมัติ",   bg: "#fef3c7", color: "#92400e" },
  approved:  { text: "✅ อนุมัติแล้ว", bg: "#dcfce7", color: "#166534" },
  returned:  { text: "↩️ ตีกลับ",     bg: "#fee2e2", color: "#991b1b" },
  cancelled: { text: "🚫 ยกเลิก",     bg: "#f1f5f9", color: "#9ca3af" },
};

// ══════════════════════════════════════════════════════════════
// คำนวณรอบเสาร์จากปฏิทิน (ไม่พึ่ง pay_cycles)
// คืน array ของ { dateFrom: Date, dateTo: Date (เสาร์) }
// ══════════════════════════════════════════════════════════════
function buildCyclesFromCalendar(year, month, logDates) {
  // logDates = Set ของ YYYY-MM-DD ที่มีบันทึกจริง
  const daysInMonth = new Date(year, month, 0).getDate();
  const saturdays = [];

  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month - 1, d).getDay() === 6) saturdays.push(d);
  }

  const cycles = [];
  let fromDay = 1;

  for (let i = 0; i < saturdays.length; i++) {
    const toDay = saturdays[i];
    const dateFrom = new Date(year, month - 1, fromDay);
    const dateTo   = new Date(year, month - 1, toDay);

    // ตรวจว่ารอบนี้มีข้อมูลสแกนจริงไหม
    let hasLog = false;
    for (let d = fromDay; d <= toDay; d++) {
      const dateStr = toLocalDateStr(new Date(year, month - 1, d));
      if (logDates.has(dateStr)) { hasLog = true; break; }
    }

    if (hasLog) {
      cycles.push({ dateFrom, dateTo, fromDay, toDay });
    }

    fromDay = toDay + 1;
  }

  // สิ้นเดือน (หลังเสาร์สุดท้าย → วันสุดท้ายของเดือน)
  const lastSat = saturdays[saturdays.length - 1] || 0;
  if (lastSat < daysInMonth) {
    const dateFrom = new Date(year, month - 1, lastSat + 1);
    const dateTo   = new Date(year, month - 1, daysInMonth);
    cycles.push({ dateFrom, dateTo, fromDay: lastSat + 1, toDay: daysInMonth, isMonthEnd: true });
  }

  return cycles;
}

// ══════════════════════════════════════════════════════════════
// ค่าแรงรายคนในช่วงวันที่กำหนด (ไม่รวมอาทิตย์)
// ══════════════════════════════════════════════════════════════
function calcCycleWageForEmployee(record, logsInCycle) {
  // ใช้ logsInCycle = attendance_logs ที่กรองมาแล้ว (ไม่ใช่อาทิตย์)
  const workDays = logsInCycle.filter(
    l => new Date(l.work_date + "T00:00:00").getDay() !== 0
  ).length;

  if (!workDays || !record.work_days) return { workDays: 0, wage: 0 };

  const dailyRate = record.base_wage / record.work_days;
  const wage = parseFloat((dailyRate * workDays).toFixed(2));
  return { workDays, wage };
}

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════
export default function WeeklyPage({ role }) {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  // ── state ──
  const [period,       setPeriod]       = useState(null);
  const [payrolls,     setPayrolls]     = useState([]);
  const [allLogs,      setAllLogs]      = useState([]);
  const [advances,     setAdvances]     = useState([]);
  const [vouchers,     setVouchers]     = useState({}); // key = cycleKey → voucher
  const [cycles,       setCycles]       = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [msg,          setMsg]          = useState(null);
  const [detail,       setDetail]       = useState(null);
  const [submitting,   setSubmitting]   = useState(null);
  const [approving,    setApproving]    = useState(null);
  const [returnModal,  setReturnModal]  = useState(null); // { cycleKey, voucherId }
  const [returnReason, setReturnReason] = useState("");

  // ══════════════════════════════════════════════════════════
  // loadAll
  // ══════════════════════════════════════════════════════════
  const loadAll = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      // 1. ดึง pay_period
      const { data: per } = await supabase
        .from("pay_periods")
        .select("id, year, month")
        .eq("year", year)
        .eq("month", month)
        .single();

      if (!per) {
        setMsg({ type: "warn", text: "⚠️ ยังไม่มีงวดเดือนนี้ — สร้าง pay_period ก่อน" });
        setLoading(false);
        return;
      }
      setPeriod(per);

      // 2. ดึง payroll_records (ต้องคำนวณก่อน)
      const { data: pr } = await supabase
        .from("payroll_records")
        .select("*, employees(nickname, full_name, emp_type, emp_code, pay_schedule)")
        .eq("period_id", per.id);

      setPayrolls(pr || []);

      if ((pr || []).length === 0) {
        setMsg({ type: "warn", text: "⚠️ ยังไม่มีผลคำนวณ — กด 'คำนวณเงินเดือน' ในแท็บ 💰 เงินเดือน ก่อน" });
        setLoading(false);
        return;
      }

      // 3. ดึง attendance_logs ทั้งเดือน
      const empIds = (pr || []).map(r => r.employee_id);
      const monthStr = String(month).padStart(2, "0");
      const daysInMonth = new Date(year, month, 0).getDate();
      const dateFrom = `${year}-${monthStr}-01`;
      const dateTo   = `${year}-${monthStr}-${String(daysInMonth).padStart(2, "0")}`;

      const { data: logs } = await supabase
        .from("attendance_logs")
        .select("employee_id, work_date")
        .in("employee_id", empIds)
        .gte("work_date", dateFrom)
        .lte("work_date", dateTo);

      setAllLogs(logs || []);

      // 4. สร้างรอบจากปฏิทิน
      const logDates = new Set((logs || []).map(l => l.work_date));
      const builtCycles = buildCyclesFromCalendar(year, month, logDates);
      setCycles(builtCycles);

      // 5. ดึงรายจ่ายที่เลือก "หักวันเสาร์" (deduct_cycle = 'saturday')
      //    ครอบคลุมทุก type: เบิกเงินสด, เงินกู้ยืม, หรืออื่นๆ ที่ HR ติ๊กว่าหักเสาร์
      const { data: adv } = await supabase
        .from("deductions")
        .select("employee_id, amount, deduct_date")
        .eq("deduct_cycle", "saturday")
        .in("employee_id", empIds)
        .gte("deduct_date", dateFrom)
        .lte("deduct_date", dateTo);

      setAdvances(adv || []);

      // 6. ดึง payout_vouchers ทั้งเดือน
      const { data: vList } = await supabase
        .from("payout_vouchers")
        .select("*")
        .eq("period_id", per.id);

      // index vouchers by cycle_date (YYYY-MM-DD) หรือ "month_end"
      const vMap = {};
      for (const v of (vList || [])) {
        const key = v.cycle_date || "month_end";
        vMap[key] = v;
      }
      setVouchers(vMap);

    } catch (e) {
      setMsg({ type: "error", text: "❌ " + e.message });
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ══════════════════════════════════════════════════════════
  // cycleKey = YYYY-MM-DD (วันเสาร์) หรือ "month_end"
  // ══════════════════════════════════════════════════════════
  function getCycleKey(cycle) {
    return cycle.isMonthEnd ? "month_end" : toLocalDateStr(cycle.dateTo);
  }

  // ── logs ในรอบนี้ของพนักงานคนนี้ (ไม่ใช่อาทิตย์) ──
  function getLogsInCycle(empId, cycle) {
    const fromStr = toLocalDateStr(cycle.dateFrom);
    const toStr   = toLocalDateStr(cycle.dateTo);
    return allLogs.filter(l =>
      l.employee_id === empId &&
      l.work_date >= fromStr &&
      l.work_date <= toStr &&
      new Date(l.work_date + "T00:00:00").getDay() !== 0
    );
  }

  // ── เบิกล่วงหน้าในรอบ (ใช้ deduct_date) ──
  function getAdvanceInCycle(empId, cycle) {
    const fromStr = toLocalDateStr(cycle.dateFrom);
    const toStr   = toLocalDateStr(cycle.dateTo);
    return advances
      .filter(a => a.employee_id === empId && a.deduct_date >= fromStr && a.deduct_date <= toStr)
      .reduce((s, a) => s + parseFloat(a.amount || 0), 0);
  }

  // ── แถวรอบเสาร์รายคน ──
  function getSaturdayRows(cycle) {
    return payrolls
      .filter(r => r.employees?.pay_schedule !== "end_of_month")
      .map(r => {
        const logs = getLogsInCycle(r.employee_id, cycle);
        const { workDays, wage } = calcCycleWageForEmployee(r, logs);
        const advAmt = getAdvanceInCycle(r.employee_id, cycle);
        const toPay  = Math.max(0, parseFloat((wage - advAmt).toFixed(2)));
        return { record: r, workDays, wage, advAmt, toPay };
      })
      .filter(row => row.workDays > 0 || row.advAmt > 0);
  }

  // ── ยอดเสาร์ทั้งเดือนของคนคนหนึ่ง ──
  function getEmpSaturdayTotal(r) {
    if (r.employees?.pay_schedule === "end_of_month") return 0;
    return cycles
      .filter(c => !c.isMonthEnd)
      .reduce((sum, c) => {
        const logs = getLogsInCycle(r.employee_id, c);
        const { wage } = calcCycleWageForEmployee(r, logs);
        const adv = getAdvanceInCycle(r.employee_id, c);
        return sum + Math.max(0, wage - adv);
      }, 0);
  }

  // ── สิ้นเดือน = net_pay − เสาร์รวม ──
  function getMonthEndPay(r) {
    const net = r.net_pay != null ? r.net_pay : (r.total_income || 0) - (r.total_deduct || 0);
    return parseFloat((net - getEmpSaturdayTotal(r)).toFixed(2));
  }

  // ── summary ──
  const allNetTotal      = payrolls.reduce((s, r) => s + (r.net_pay != null ? r.net_pay : (r.total_income||0)-(r.total_deduct||0)), 0);
  const allSaturdayTotal = payrolls.reduce((s, r) => s + getEmpSaturdayTotal(r), 0);
  const monthEndTotal    = payrolls.reduce((s, r) => s + getMonthEndPay(r), 0);
  const grandTotal       = allSaturdayTotal + monthEndTotal;
  const isBalanced       = Math.abs(grandTotal - allNetTotal) < 1;

  // ══════════════════════════════════════════════════════════
  // Voucher Actions
  // ══════════════════════════════════════════════════════════

  // สร้าง snapshot lines จากแถวปัจจุบัน
  function buildLines(rows) {
    return rows.map(row => ({
      employee_id:   row.record.employee_id,
      emp_code:      row.record.employees?.emp_code,
      nickname:      row.record.employees?.nickname,
      work_days:     row.workDays,
      wage:          row.wage,
      advance:       row.advAmt,
      to_pay:        row.toPay,
    }));
  }

  // สร้าง voucher_no (เช่น V2569-06-001)
  function genVoucherNo(cycleKey, existingCount) {
    const seq = String(existingCount + 1).padStart(3, "0");
    return `V${year}-${String(month).padStart(2,"0")}-${seq}`;
  }

  // HR ยื่นเบิก
  async function submitVoucher(cycle, rows, isMonthEnd) {
    const cycleKey = getCycleKey(cycle);
    const existing = vouchers[cycleKey];

    // ถ้ามีอยู่แล้วและไม่ใช่ returned → ห้ามยื่นซ้ำ
    if (existing && existing.status !== "returned") {
      setMsg({ type: "warn", text: "⚠️ รอบนี้มีใบเบิกแล้ว — รอเจ้าของอนุมัติ" });
      return;
    }

    const totalAmount = rows.reduce((s, r) => s + r.toPay, 0);
    const lines = buildLines(rows);
    const cycleCount = Object.keys(vouchers).length;

    setSubmitting(cycleKey);
    try {
      const payload = {
        period_id:       period.id,
        cycle_date:      isMonthEnd ? null : toLocalDateStr(cycle.dateTo),
        voucher_no:      existing?.voucher_no || genVoucherNo(cycleKey, cycleCount),
        status:          "submitted",
        total_amount:    totalAmount,
        employee_count:  rows.length,
        lines:           lines,
        submitted_at:    new Date().toISOString(),
      };

      let error;
      if (existing) {
        // re-submit หลัง returned
        ({ error } = await supabase
          .from("payout_vouchers")
          .update({ ...payload, returned_at: null, return_reason: null })
          .eq("id", existing.id));
      } else {
        ({ error } = await supabase
          .from("payout_vouchers")
          .insert(payload));
      }

      if (error) throw error;
      setMsg({ type: "ok", text: `✅ ยื่นใบเบิกรอบ ${fmtDate(cycle.dateFrom)}–${fmtDate(cycle.dateTo)} แล้ว` });
      await loadAll();
    } catch (e) {
      setMsg({ type: "error", text: "❌ " + e.message });
    } finally {
      setSubmitting(null);
    }
  }

  // เจ้าของ อนุมัติ
  async function approveVoucher(cycleKey) {
    const v = vouchers[cycleKey];
    if (!v) return;
    setApproving(cycleKey);
    try {
      const { error } = await supabase
        .from("payout_vouchers")
        .update({ status: "approved", approved_at: new Date().toISOString() })
        .eq("id", v.id);
      if (error) throw error;
      setMsg({ type: "ok", text: "✅ อนุมัติใบเบิกแล้ว" });
      await loadAll();
    } catch (e) {
      setMsg({ type: "error", text: "❌ " + e.message });
    } finally {
      setApproving(null);
    }
  }

  // เจ้าของ ตีกลับ
  async function returnVoucher() {
    if (!returnModal) return;
    const v = vouchers[returnModal.cycleKey];
    if (!v) return;
    try {
      const { error } = await supabase
        .from("payout_vouchers")
        .update({
          status:        "returned",
          returned_at:   new Date().toISOString(),
          return_reason: returnReason || "ตีกลับ",
        })
        .eq("id", v.id);
      if (error) throw error;
      setMsg({ type: "warn", text: "↩️ ตีกลับใบเบิกแล้ว — HR แก้ไขและยื่นใหม่" });
      setReturnModal(null);
      setReturnReason("");
      await loadAll();
    } catch (e) {
      setMsg({ type: "error", text: "❌ " + e.message });
    }
  }

  // ══════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════
  return (
    <div style={s.page}>
      <div style={s.header}>
        <h2 style={s.title}>💸 รายจ่ายบริษัท</h2>
        <button onClick={loadAll} style={s.refreshBtn}>🔄 โหลดใหม่</button>
      </div>

      {msg && (
        <div style={{
          ...s.msgBox,
          background:  msg.type==="ok"?"#f0fdf4":msg.type==="warn"?"#fffbeb":"#fef2f2",
          borderColor: msg.type==="ok"?"#86efac":msg.type==="warn"?"#fde68a":"#fca5a5",
          color:       msg.type==="ok"?"#166534":msg.type==="warn"?"#92400e":"#991b1b",
        }}>
          {msg.text}
          <button onClick={() => setMsg(null)} style={s.msgClose}>✕</button>
        </div>
      )}

      {loading && (
        <p style={{ color:"#6b7280", textAlign:"center", padding:32 }}>⏳ กำลังโหลด...</p>
      )}

      {/* แถบตรวจยอด */}
      {!loading && payrolls.length > 0 && (
        <div style={{
          display:"flex", alignItems:"center", justifyContent:"space-between",
          flexWrap:"wrap", gap:8, padding:"10px 16px", borderRadius:10, marginBottom:14,
          background: isBalanced ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${isBalanced ? "#86efac" : "#fca5a5"}`,
        }}>
          <span style={{ fontWeight:700, fontSize:14, color: isBalanced?"#166534":"#991b1b" }}>
            {isBalanced ? "✅ ยอดตรง" : "❌ ยอดไม่ตรง — ตรวจสอบ"}
          </span>
          <span style={{ fontSize:13, color:"#475569" }}>
            เสาร์รวม <b>{fmtInt(allSaturdayTotal)}</b>
            {" + สิ้นเดือน "}<b>{fmtInt(monthEndTotal)}</b>
            {" = "}<b>{fmtInt(grandTotal)}</b>
            {"  |  สุทธิรวม "}<b>{fmtInt(allNetTotal)}</b>
          </span>
        </div>
      )}

      {/* ── รอบเสาร์ทุกรอบ ── */}
      {!loading && cycles.filter(c => !c.isMonthEnd).map((cycle, ci) => {
        const cycleKey = getCycleKey(cycle);
        const rows     = getSaturdayRows(cycle);
        const voucher  = vouchers[cycleKey];
        const totalPay = rows.reduce((s, r) => s + r.toPay, 0);
        const statusInfo = voucher ? STATUS_LABEL[voucher.status] : null;

        return (
          <div key={cycleKey} style={s.cycleCard}>
            {/* header */}
            <div style={s.cycleHeader}>
              <div>
                <span style={s.cycleLabel}>รอบที่ {ci + 1}</span>
                <span style={s.cycleDates}>
                  จ. {fmtDate(cycle.dateFrom)} – ส. {fmtDate(cycle.dateTo)}
                </span>
              </div>
              {statusInfo
                ? <span style={{ ...s.statusBadge, background: statusInfo.bg, color: statusInfo.color }}>
                    {statusInfo.text}
                  </span>
                : <span style={{ ...s.statusBadge, background:"#f1f5f9", color:"#94a3b8" }}>
                    📋 ยังไม่มีใบเบิก
                  </span>
              }
            </div>

            {/* ตารางรายคน */}
            {rows.length === 0
              ? <p style={s.emptyMsg}>ยังไม่มีข้อมูลการทำงานในรอบนี้</p>
              : (
                <div style={{ overflowX:"auto" }}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        {["ชื่อ","ประเภท","วันทำ","ค่าแรงรอบนี้","เบิกในรอบ","จ่ายเสาร์",""].map(h => (
                          <th key={h} style={s.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ record: r, workDays, wage, advAmt, toPay }) => (
                        <tr key={r.employee_id} style={s.tr}>
                          <td style={{ ...s.td, fontWeight:700 }}>
                            {r.employees?.nickname}
                            {r.has_review && <span style={{ marginLeft:4, fontSize:11 }}>⚠️</span>}
                          </td>
                          <td style={{ ...s.td, color:"#64748b" }}>
                            {r.employees?.emp_type === "permanent" ? "ประจำ" : "ทดลอง"}
                          </td>
                          <td style={{ ...s.td, textAlign:"right" }}>{workDays} วัน</td>
                          <td style={{ ...s.td, textAlign:"right" }}>{fmt(wage)}</td>
                          <td style={{ ...s.td, textAlign:"right", color: advAmt>0?"#dc2626":"#9ca3af" }}>
                            {advAmt > 0 ? `(${fmt(advAmt)})` : "—"}
                          </td>
                          <td style={{ ...s.td, textAlign:"right", fontWeight:700, fontSize:15, color:"#1e3a5f" }}>
                            {fmtInt(toPay)}
                          </td>
                          <td style={{ ...s.td, textAlign:"center" }}>
                            <button
                              onClick={() => setDetail({ record: r, workDays, wage, advAmt, toPay, cycleLabel: `รอบที่ ${ci+1}` })}
                              style={s.glassBtn} title="รายละเอียด">🔍</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background:"#f0f4f8" }}>
                        <td style={s.td} colSpan={5}>
                          <span style={{ fontWeight:700 }}>รวม</span>
                        </td>
                        <td style={{ ...s.td, textAlign:"right", fontWeight:800, fontSize:17, color:"#1e3a5f" }}>
                          {fmtInt(totalPay)}
                        </td>
                        <td style={s.td} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            }

            {/* voucher info */}
            {voucher && (
              <VoucherInfo voucher={voucher} />
            )}

            {/* actions */}
            <VoucherActions
              role={role}
              cycleKey={cycleKey}
              voucher={voucher}
              rows={rows}
              totalPay={totalPay}
              submitting={submitting}
              approving={approving}
              onSubmit={() => submitVoucher(cycle, rows, false)}
              onApprove={() => approveVoucher(cycleKey)}
              onReturn={() => setReturnModal({ cycleKey })}
            />
          </div>
        );
      })}

      {/* ── สิ้นเดือน ── */}
      {!loading && payrolls.length > 0 && (() => {
        const meRows = payrolls.map(r => ({
          record:    r,
          workDays:  0,
          wage:      0,
          advAmt:    getEmpSaturdayTotal(r),
          toPay:     getMonthEndPay(r),
        }));
        const voucherMe = vouchers["month_end"];
        const statusInfo = voucherMe ? STATUS_LABEL[voucherMe.status] : null;

        return (
          <div style={{ ...s.cycleCard, border:"2px solid #7c3aed" }}>
            <div style={{ ...s.cycleHeader, background:"#4c1d95" }}>
              <div>
                <span style={s.cycleLabel}>💜 จ่ายสิ้นเดือน</span>
                <span style={s.cycleDates}>ส่วนที่เหลือ = สุทธิทั้งเดือน − จ่ายเสาร์แล้ว</span>
              </div>
              {statusInfo
                ? <span style={{ ...s.statusBadge, background: statusInfo.bg, color: statusInfo.color }}>
                    {statusInfo.text}
                  </span>
                : <span style={{ ...s.statusBadge, background:"#f1f5f9", color:"#94a3b8" }}>
                    📋 ยังไม่มีใบเบิก
                  </span>
              }
            </div>

            <div style={{ overflowX:"auto" }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {["ชื่อ","รอบจ่าย","สุทธิทั้งเดือน","จ่ายเสาร์แล้ว","จ่ายสิ้นเดือน",""].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payrolls.map(r => {
                    const isME     = r.employees?.pay_schedule === "end_of_month";
                    const net      = r.net_pay != null ? r.net_pay : (r.total_income||0)-(r.total_deduct||0);
                    const satTotal = getEmpSaturdayTotal(r);
                    const mePay    = getMonthEndPay(r);
                    return (
                      <tr key={r.employee_id} style={s.tr}>
                        <td style={{ ...s.td, fontWeight:700 }}>{r.employees?.nickname}</td>
                        <td style={{ ...s.td, textAlign:"center" }}>
                          <span style={{
                            fontSize:12, padding:"3px 10px", borderRadius:20, fontWeight:700,
                            background: isME?"#7c3aed":"#0ea5e9", color:"#fff",
                          }}>
                            {isME ? "💜 สิ้นเดือน" : "🔵 รายเสาร์"}
                          </span>
                        </td>
                        <td style={{ ...s.td, textAlign:"right" }}>{fmtInt(net)}</td>
                        <td style={{ ...s.td, textAlign:"right", color: satTotal>0?"#0ea5e9":"#9ca3af" }}>
                          {satTotal > 0 ? `(${fmtInt(satTotal)})` : "—"}
                        </td>
                        <td style={{ ...s.td, textAlign:"right", fontWeight:700, fontSize:15, color:"#4c1d95" }}>
                          {fmtInt(mePay)}
                        </td>
                        <td style={{ ...s.td, textAlign:"center" }}>
                          <button
                            onClick={() => setDetail({
                              record: r, toPay: mePay, satTotal, isMonthEnd: true
                            })}
                            style={s.glassBtn}>🔍</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background:"#f5f3ff" }}>
                    <td style={s.td} colSpan={2}><span style={{ fontWeight:700, color:"#4c1d95" }}>รวม</span></td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:700 }}>{fmtInt(allNetTotal)}</td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:700, color:"#0ea5e9" }}>({fmtInt(allSaturdayTotal)})</td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:800, fontSize:17, color:"#4c1d95" }}>
                      {fmtInt(monthEndTotal)}
                    </td>
                    <td style={s.td} />
                  </tr>
                </tfoot>
              </table>
            </div>

            {voucherMe && <VoucherInfo voucher={voucherMe} />}

            <VoucherActions
              role={role}
              cycleKey="month_end"
              voucher={voucherMe}
              rows={meRows}
              totalPay={monthEndTotal}
              submitting={submitting}
              approving={approving}
              onSubmit={() => submitVoucher({ dateFrom: new Date(year,month-1,1), dateTo: new Date(year,month,0), isMonthEnd:true }, meRows, true)}
              onApprove={() => approveVoucher("month_end")}
              onReturn={() => setReturnModal({ cycleKey: "month_end" })}
              purple
            />
          </div>
        );
      })()}

      {/* ── Modal รายละเอียดรายคน ── */}
      {detail && (
        <DetailModal detail={detail} onClose={() => setDetail(null)} />
      )}

      {/* ── Modal ตีกลับ ── */}
      {returnModal && (
        <div style={s.modalOverlay} onClick={() => setReturnModal(null)}>
          <div style={{ ...s.modal, width:380 }} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={{ fontWeight:700, color:"#fff" }}>↩️ ตีกลับใบเบิก</span>
              <button onClick={() => setReturnModal(null)} style={s.closeBtn}>✕</button>
            </div>
            <div style={{ padding:16 }}>
              <p style={{ fontSize:14, color:"#475569", marginTop:0 }}>ระบุเหตุผลตีกลับ (ไม่บังคับ)</p>
              <textarea
                value={returnReason}
                onChange={e => setReturnReason(e.target.value)}
                placeholder="เช่น ยอดไม่ตรง, ข้อมูลผิด"
                rows={3}
                style={{ width:"100%", borderRadius:8, border:"1px solid #e2e8f0", padding:"8px 10px", fontSize:13, resize:"vertical", boxSizing:"border-box" }}
              />
              <div style={{ display:"flex", gap:8, marginTop:12 }}>
                <button
                  onClick={returnVoucher}
                  style={{ ...s.markBtn, background:"#dc2626", flex:1 }}>
                  ↩️ ยืนยันตีกลับ
                </button>
                <button
                  onClick={() => setReturnModal(null)}
                  style={{ ...s.markBtn, background:"#94a3b8", flex:1 }}>
                  ยกเลิก
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// VoucherInfo — แสดงข้อมูล voucher ที่มีอยู่
// ══════════════════════════════════════════════════════════════
function VoucherInfo({ voucher }) {
  const [showLines, setShowLines] = useState(false);
  if (!voucher) return null;

  const lines = voucher.lines || [];

  return (
    <div style={{
      margin:"8px 12px 0", padding:"10px 12px", background:"#f8fafc",
      borderRadius:10, border:"1px solid #e2e8f0", fontSize:13,
    }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontWeight:700, color:"#374151" }}>
          ใบเบิก {voucher.voucher_no}
        </span>
        <button
          onClick={() => setShowLines(v => !v)}
          style={{ fontSize:12, padding:"2px 8px", borderRadius:6, border:"1px solid #e2e8f0",
            background:"#fff", cursor:"pointer", color:"#64748b" }}>
          {showLines ? "ซ่อนรายการ" : "ดู snapshot"}
        </button>
      </div>
      {voucher.return_reason && (
        <p style={{ margin:"6px 0 0", color:"#991b1b", fontSize:12 }}>
          ⚠️ เหตุผลตีกลับ: {voucher.return_reason}
        </p>
      )}
      {showLines && lines.length > 0 && (
        <div style={{ marginTop:8, overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr>
                {["ชื่อ","วันทำ","ค่าแรง","เบิก","จ่าย"].map(h => (
                  <th key={h} style={{ padding:"4px 8px", textAlign: h==="ชื่อ"?"left":"right",
                    background:"#f1f5f9", borderBottom:"1px solid #e2e8f0" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ padding:"4px 8px" }}>{l.nickname}</td>
                  <td style={{ padding:"4px 8px", textAlign:"right" }}>{l.work_days} วัน</td>
                  <td style={{ padding:"4px 8px", textAlign:"right" }}>{Number(l.wage||0).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  <td style={{ padding:"4px 8px", textAlign:"right", color: l.advance>0?"#dc2626":"#9ca3af" }}>
                    {l.advance > 0 ? `(${Number(l.advance).toLocaleString("th-TH")})` : "—"}
                  </td>
                  <td style={{ padding:"4px 8px", textAlign:"right", fontWeight:700 }}>
                    {Number(l.to_pay||0).toLocaleString("th-TH")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// VoucherActions — ปุ่มดำเนินการตาม role + status
// ══════════════════════════════════════════════════════════════
function VoucherActions({
  role, cycleKey, voucher, rows, totalPay,
  submitting, approving,
  onSubmit, onApprove, onReturn,
  purple,
}) {
  const fmtInt = (n) => Number(n || 0).toLocaleString("th-TH");
  const status = voucher?.status;
  const btnColor = purple ? "#7c3aed" : "#1e3a5f";

  return (
    <div style={{
      display:"flex", alignItems:"center", flexWrap:"wrap", gap:10,
      padding:"12px 16px", borderTop:"1px solid #f1f5f9",
    }}>
      {/* HR: ยื่น / re-submit */}
      {role === "hr" && (!voucher || status === "returned") && rows.length > 0 && (
        <button
          onClick={onSubmit}
          disabled={submitting === cycleKey}
          style={{ ...s.markBtn, background: btnColor, opacity: submitting===cycleKey?0.6:1 }}>
          {submitting === cycleKey ? "⏳..." : "📤 ยื่นเบิกเงิน"}
        </button>
      )}

      {/* Owner: อนุมัติ */}
      {role === "owner" && status === "submitted" && (
        <button
          onClick={onApprove}
          disabled={approving === cycleKey}
          style={{ ...s.markBtn, background:"#16a34a", opacity: approving===cycleKey?0.6:1 }}>
          {approving === cycleKey ? "⏳..." : "✅ อนุมัติ"}
        </button>
      )}

      {/* Owner: ตีกลับ */}
      {role === "owner" && status === "submitted" && (
        <button onClick={onReturn} style={{ ...s.markBtn, background:"#dc2626" }}>
          ↩️ ตีกลับ
        </button>
      )}

      {status === "approved" && (
        <span style={{ fontSize:12, color:"#16a34a", fontWeight:700 }}>
          ✅ อนุมัติแล้ว • อนุมัติเมื่อ {new Date(voucher.approved_at).toLocaleString("th-TH")}
        </span>
      )}

      <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>
        รวม {fmtInt(totalPay)} บาท
      </span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DetailModal
// ══════════════════════════════════════════════════════════════
function DetailModal({ detail, onClose }) {
  const fmt    = (n) => Number(n||0).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtInt = (n) => Number(n||0).toLocaleString("th-TH");
  const r = detail.record;

  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <span style={{ fontWeight:700, fontSize:15, color:"#fff" }}>
            🔍 {r.employees?.nickname} — {r.employees?.full_name}
          </span>
          <button onClick={onClose} style={s.closeBtn}>✕</button>
        </div>
        <div style={{ padding:16 }}>
          <div style={s.cycleBox}>
            <span style={{ fontWeight:700, color: detail.isMonthEnd?"#4c1d95":"#1e3a5f" }}>
              {detail.isMonthEnd ? "💜 จ่ายสิ้นเดือน" : `🔵 ${detail.cycleLabel} (${detail.workDays} วัน)`}
            </span>
            <span style={{ fontWeight:800, fontSize:20, color: detail.isMonthEnd?"#4c1d95":"#1e3a5f" }}>
              {fmtInt(detail.toPay)} บาท
            </span>
          </div>

          {detail.isMonthEnd && (
            <div style={s.calcBox}>
              <MiniRow label="สุทธิทั้งเดือน"
                value={fmtInt(r.net_pay ?? (r.total_income||0)-(r.total_deduct||0))} />
              <MiniRow label="− จ่ายเสาร์ไปแล้ว" value={`(${fmtInt(detail.satTotal)})`} red />
              <MiniRow label="= ส่วนเหลือสิ้นเดือน" value={fmtInt(detail.toPay)} bold green />
            </div>
          )}

          <div style={s.divider} />
          <p style={s.sectionTitle}>💰 รายได้ทั้งเดือน</p>
          {[
            ["ค่าแรงปกติ",         fmt(r.base_wage)],
            ["ค่าแรงวันอาทิตย์",   fmt(r.holiday_wage)],
            ["OT",                  `${r.ot_hours||0} ชม. = ${fmt(r.ot_amount)}`],
            ["เงินประจำตำแหน่ง",   fmt(r.position_allowance)],
            ["เบี้ยขยัน",          fmt(r.diligence_bonus)],
          ].map(([k,v]) => <MiniRow key={k} label={k} value={v} />)}
          <MiniRow label="รวมรายได้" value={fmt(r.total_income)} bold green />

          <div style={s.divider} />
          <p style={s.sectionTitle}>📉 รายหักทั้งเดือน</p>
          {[
            ["สาย",                 `${r.late_minutes||0} น. = ${fmt(r.late_deduct)}`],
            ["ประกันสังคม",        fmt(r.social_security)],
            ["ประกันงาน",          fmt(r.job_insurance)],
            ["รายจ่ายพนักงาน",    fmt(r.other_deduct)],
            ["เบิกล่วงหน้า",       fmt(r.advance_total)],
          ].map(([k,v]) => <MiniRow key={k} label={k} value={v} />)}
          <MiniRow label="รวมรายหัก" value={fmt(r.total_deduct)} bold red />

          <div style={s.divider} />
          <div style={s.netBox}>
            <span style={{ fontWeight:600, color:"#475569" }}>💵 สุทธิทั้งเดือน</span>
            <span style={{ fontWeight:800, fontSize:20, color:"#1e3a5f" }}>{fmtInt(r.net_pay)} บาท</span>
          </div>
        </div>
      </div>
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

// ══════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════
const s = {
  page:        { maxWidth:960, margin:"0 auto" },
  header:      { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 },
  title:       { margin:0, fontSize:18, fontWeight:800, color:"#1e3a5f" },
  refreshBtn:  { padding:"6px 14px", borderRadius:8, border:"1px solid #e2e8f0",
                 background:"#f8fafc", cursor:"pointer", fontSize:13 },
  msgBox:      { position:"relative", padding:"10px 36px 10px 14px", borderRadius:8,
                 border:"1px solid", marginBottom:12, fontWeight:600, fontSize:14 },
  msgClose:    { position:"absolute", right:10, top:8, background:"none", border:"none",
                 cursor:"pointer", fontSize:16, color:"inherit", opacity:0.7 },

  cycleCard:   { background:"#fff", borderRadius:14, marginBottom:16,
                 boxShadow:"0 1px 6px rgba(0,0,0,0.08)", overflow:"hidden" },
  cycleHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
                 padding:"12px 16px", background:"#1e3a5f", color:"#fff" },
  cycleLabel:  { fontWeight:800, fontSize:14, marginRight:10 },
  cycleDates:  { fontSize:13, color:"#93c5fd" },
  statusBadge: { fontSize:12, padding:"3px 10px", borderRadius:20, fontWeight:700 },
  emptyMsg:    { color:"#9ca3af", padding:"12px 16px", fontSize:13, margin:0 },

  table:       { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th:          { padding:"8px 12px", textAlign:"left", background:"#f8fafc",
                 borderBottom:"2px solid #e2e8f0", fontWeight:700, color:"#374151", whiteSpace:"nowrap" },
  tr:          { transition:"background 0.1s" },
  td:          { padding:"9px 12px", borderBottom:"1px solid #f1f5f9", whiteSpace:"nowrap" },

  glassBtn:    { background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8,
                 padding:"4px 10px", cursor:"pointer", fontSize:14 },
  markBtn:     { padding:"8px 20px", borderRadius:10, border:"none",
                 color:"#fff", fontWeight:700, fontSize:14, cursor:"pointer" },

  modalOverlay:{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)",
                 display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal:       { background:"#fff", borderRadius:16, width:420, maxWidth:"90vw",
                 maxHeight:"88vh", overflow:"auto", boxShadow:"0 20px 60px rgba(0,0,0,0.3)" },
  modalHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
                 padding:"14px 16px", background:"#1e3a5f", borderRadius:"16px 16px 0 0",
                 position:"sticky", top:0, zIndex:1 },
  closeBtn:    { background:"none", border:"none", color:"#fff", fontSize:20,
                 cursor:"pointer", lineHeight:1 },

  cycleBox:    { display:"flex", justifyContent:"space-between", alignItems:"center",
                 padding:"10px 14px", background:"#eff6ff", borderRadius:10,
                 border:"2px solid #bfdbfe", marginBottom:12 },
  calcBox:     { background:"#faf5ff", border:"1px solid #e9d5ff", borderRadius:10,
                 padding:"8px 12px", marginBottom:8 },
  divider:     { borderTop:"2px solid #f1f5f9", margin:"12px 0" },
  sectionTitle:{ margin:"4px 0 6px", fontWeight:700, fontSize:14, color:"#1e3a5f" },
  netBox:      { display:"flex", justifyContent:"space-between", alignItems:"center",
                 padding:"10px 14px", background:"#f0fdf4", borderRadius:10,
                 border:"2px solid #86efac", marginTop:8 },
};
