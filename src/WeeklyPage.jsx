// src/WeeklyPage.jsx
// ทาง B (v5) — รอบจากปฏิทิน + payout_vouchers + เรียง emp_code + modal อ่านง่าย
//
// 🔧 v5: ดึง OT ที่ติดป้าย "จ่ายเสาร์" (จากหน้ารายได้พิเศษ) มาบวกเข้ารอบเสาร์
//        - OT อยู่ในยอดสุทธิอยู่แล้ว → ใส่รอบเสาร์ = ก้อนสิ้นเดือนลดลงเอง
//          (สูตรสิ้นเดือน = สุทธิ − เสาร์) → ยอดรวมไม่เปลี่ยน นับครั้งเดียว
//        - OT ติดป้ายสิ้นเดือน → ปล่อยให้ตกในก้อนสิ้นเดือนตามเดิม
//        - จับคู่รอบจาก cycle_date ที่ HR เลือก; จับไม่ได้ → รอบเสาร์สุดท้าย
// 🔧 v5.1: รวม income_type='other' (disburse_on='saturday') เข้ารอบเสาร์ด้วย
//          (อยู่ใน net_pay แล้ว → สูตรสิ้นเดือน = สุทธิ − เสาร์ นับครั้งเดียว ยอดตรง)
// 🔧 v5.2: สลิปสิ้นเดือน + ป็อปอัปรายคน โชว์บรรทัด "คืนค่าประกันงาน/ค่าสมัครงาน" (เฉพาะตอนลาออก)
// 🔧 v5.3: "ลาครึ่งวัน" ตัดออกจากรอบเสาร์ด้วย → ทุกการลาจ่ายสิ้นเดือน (เดิมเฉพาะ ลาป่วย/ลากิจ/ขาด)

import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";
import AdvanceSummaryCard from "./AdvanceSummaryCard"; import { calcLateDeduction, midLeaveFactor } from "./payrollCalc";

const MONTHS_SHORT = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."]; const DOW_TH = ["อา.","จ.","อ.","พ.","พฤ.","ศ.","ส."];

// แสดงวันที่เป็น พ.ศ. วว/ดด/ปปปป (เก็บใน storage ยังเป็น ค.ศ. — แปลงเฉพาะตอนแสดงผล)
function fmtDate(d) {
  if (!d) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear() + 543}`;
}
// แปลงสตริงวันที่ "YYYY-MM-DD" (ค.ศ.) → "DD/MM/พ.ศ."
function toBE(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
const fmt    = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => Number(n || 0).toLocaleString("th-TH");

// เรียง payrolls ตาม emp_code
function sortByEmpCode(arr) {
  return [...arr].sort((a, b) => {
    const ca = a.employees?.emp_code || a.emp_code || "";
    const cb = b.employees?.emp_code || b.emp_code || "";
    return ca.localeCompare(cb, undefined, { numeric: true });
  });
}

const STATUS_LABEL = {
  draft:     { text: "📝 ร่าง",        bg: "#f1f5f9", color: "#475569" },
  submitted: { text: "📤 รออนุมัติ",   bg: "#fef3c7", color: "#92400e" },
  approved:  { text: "✅ อนุมัติแล้ว", bg: "#dcfce7", color: "#166534" },
  returned:  { text: "↩️ ตีกลับ",     bg: "#fee2e2", color: "#991b1b" },
  cancelled: { text: "🚫 ยกเลิก",     bg: "#f1f5f9", color: "#9ca3af" },
};

function buildCyclesFromCalendar(year, month, logDates) {
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
    let hasLog = false;
    for (let d = fromDay; d <= toDay; d++) {
      if (logDates.has(toLocalDateStr(new Date(year, month - 1, d)))) { hasLog = true; break; }
    }
    if (hasLog) cycles.push({ dateFrom, dateTo, fromDay, toDay });
    fromDay = toDay + 2;
  }
  const lastSat = saturdays[saturdays.length - 1] || 0;
  if (lastSat < daysInMonth) {
    cycles.push({
      dateFrom: new Date(year, month - 1, lastSat + 1),
      dateTo:   new Date(year, month - 1, daysInMonth),
      fromDay: lastSat + 1, toDay: daysInMonth, isMonthEnd: true,
    });
  }
  return cycles;
}

// 🆕 v7.10 น้ำหนักวันทำงานต่อ 1 log ให้ตรงกับ payrollCalc (กันรอบเสาร์คิดวันเต็มแล้วหักสายซ้ำ)
//   ขาดงานครึ่งวัน=0.5 · ขาดงานเต็มวัน=0 · ออกระหว่างวัน=ตามชั่วโมงจริง (midLeaveFactor) · อื่นๆ=1
function cycleDayWeight(l) {
  const note = l.hr_note || "";
  if (/ขาดงานครึ่งวัน|ขาดครึ่งวัน/.test(note)) return 0.5;
  if (/ขาด/.test(note)) return 0;
  if (/ออกระหว่างวัน/.test(note)) return midLeaveFactor(l.scan_pm_out || l.scan_am_out, l.scan_am_out);
  return 1;
}

function calcCycleWageForEmployee(record, logsInCycle, WTAG) {
  const nonSun = logsInCycle.filter(
    l => new Date(l.work_date + "T00:00:00").getDay() !== 0
  );
  const workDays = nonSun.reduce((s, l) => s + cycleDayWeight(l), 0);
  if (!workDays || !record.work_days) return { workDays: 0, wage: 0 };
  const dailyRate = record.base_wage / record.work_days;
  const hourlyRate = dailyRate / 8; const _emp = record.employees || {}; let _lateDed = 0; nonSun.forEach(l => { const _rate = (WTAG && WTAG[record.employee_id + "_" + l.work_date]) || ((_emp.probation && !/แจ้งล่วงหน้า/.test(l.hr_note || "")) ? 5 : 1); _lateDed += calcLateDeduction(l.late_minutes || 0, _rate, hourlyRate) + parseFloat(l.hr_extra_deduct || 0); }); const wage = Math.round(dailyRate * workDays - _lateDed);
  return { workDays: Math.round(workDays * 100) / 100, wage };
}

export default function WeeklyPage({ role }) {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  const [period,       setPeriod]       = useState(null);
  const [payrolls,     setPayrolls]     = useState([]);
  const [allLogs,      setAllLogs]      = useState([]);
  const [advances,     setAdvances]     = useState([]);
  const [extraIncome,  setExtraIncome]  = useState([]);
  const [cycleDateMap, setCycleDateMap] = useState({});
  const [vouchers,     setVouchers]     = useState({});
  const [cycles,       setCycles]       = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [msg,          setMsg]          = useState(null);
  const [detail,       setDetail]       = useState(null);
  const [submitting,   setSubmitting]   = useState(null);
  const [approving,    setApproving]    = useState(null);
  const [returnModal,  setReturnModal]  = useState(null);
  const [printModal,   setPrintModal]   = useState(null);   // { voucher, selected:Set<employee_id> }
  const [insBal,       setInsBal]       = useState({});     // employee_id -> ประกันงานสะสม
  const [leaveSum,     setLeaveSum]     = useState({});     // employee_id -> v_leave_balance_summary row
  const [leaveMonth,   setLeaveMonth]   = useState({});     // employee_id -> {sick:{days,dates}, personal:{days,dates}}
  const [dedByType,    setDedByType]    = useState({});     // employee_id -> [{name, amount}] (หักจริงแยกตามแท็ก, ตัดเงินออก)
  const [returnReason, setReturnReason] = useState(""); const [lateTagMap, setLateTagMap] = useState({}); const [collapsed, setCollapsed] = useState({});

  const loadAll = useCallback(async () => {
    setLoading(true); setMsg(null);
    try {
      const { data: per } = await supabase
        .from("pay_periods").select("id, year, month, is_closed")
        .eq("year", year).eq("month", month).single();
      if (!per) { setMsg({ type:"warn", text:"⚠️ ยังไม่มีงวดเดือนนี้" }); setLoading(false); return; }
      setPeriod(per);

      const { data: pr } = await supabase
        .from("payroll_records")
        .select("*, employees(nickname, full_name, emp_type, emp_code, pay_schedule, probation, monthly_salary, daily_rate)")
        .eq("period_id", per.id);
      const sorted = sortByEmpCode(pr || []);
      setPayrolls(sorted);
      if (!sorted.length) { setMsg({ type:"warn", text:"⚠️ ยังไม่มีผลคำนวณ — กด 'คำนวณเงินเดือน' ก่อน" }); setLoading(false); return; }

      const empIds   = sorted.map(r => r.employee_id);
      const monthStr = String(month).padStart(2,"0");
      const dim      = new Date(year, month, 0).getDate();
      const dateFrom = `${year}-${monthStr}-01`;
      const dateTo   = `${year}-${monthStr}-${String(dim).padStart(2,"0")}`;

      const { data: logs } = await supabase
        .from("attendance_logs").select("employee_id, work_date, hr_note, late_minutes, hr_extra_deduct, scan_am_in, scan_am_out, scan_pm_in, scan_pm_out")
        .in("employee_id", empIds).gte("work_date", dateFrom).lte("work_date", dateTo);
      setAllLogs(logs || []); const { data: _tags } = await supabase.from("late_tags").select("employee_id,tag_date,rate_per_minute").in("employee_id", empIds).gte("tag_date", dateFrom).lte("tag_date", dateTo); const _tm = {}; (_tags || []).forEach(t => { _tm[t.employee_id + "_" + t.tag_date] = t.rate_per_minute; }); setLateTagMap(_tm);

      const logDates = new Set((logs || []).map(l => l.work_date));
      setCycles(buildCyclesFromCalendar(year, month, logDates));

      const { data: adv } = await supabase
        .from("deductions").select("employee_id, amount, deduct_date, deduction_types(name)")
        .eq("deduct_cycle","saturday").in("employee_id", empIds)
        .gte("deduct_date", dateFrom).lte("deduct_date", dateTo);
      setAdvances(adv || []);

      const { data: ei } = await supabase
        .from("extra_income_entries")
        .select("employee_id, amount, disburse_on, cycle_id, income_type, label, amount_note")
        .eq("period_id", per.id);
      setExtraIncome(ei || []);

      const { data: pcs } = await supabase
        .from("pay_cycles").select("id, cycle_date").eq("period_id", per.id);
      const pcMap = {};
      (pcs || []).forEach(c => { pcMap[c.id] = c.cycle_date; });
      setCycleDateMap(pcMap);

      const { data: vList } = await supabase
        .from("payout_vouchers").select("*").eq("period_id", per.id);
      const vMap = {};
      for (const v of (vList || [])) vMap[v.cycle_date || "month_end"] = v;
      setVouchers(vMap);

      // 🔧 v7: ประกันงานสะสม + สิทธิ์ลา (สำหรับสลิปสิ้นเดือน)
      const { data: insb } = await supabase
        .from("v_insurance_balance").select("employee_id, balance").in("employee_id", empIds);
      const ibMap = {}; (insb || []).forEach(r => { ibMap[r.employee_id] = Number(r.balance || 0); });
      setInsBal(ibMap);

      const { data: lsum } = await supabase
        .from("v_leave_balance_summary").select("*").eq("year", year).in("employee_id", empIds);
      const lsMap = {}; (lsum || []).forEach(r => { lsMap[r.employee_id] = r; });
      setLeaveSum(lsMap);

      const { data: lreq } = await supabase
        .from("leave_requests").select("employee_id, leave_type, leave_date, unit")
        .in("employee_id", empIds).gte("leave_date", dateFrom).lte("leave_date", dateTo);
      const lmMap = {};
      (lreq || []).forEach(r => {
        if (!lmMap[r.employee_id]) lmMap[r.employee_id] = { sick:{days:0,dates:[]}, personal:{days:0,dates:[]} };
        const k = r.leave_type === "personal" ? "personal" : "sick";
        lmMap[r.employee_id][k].days += (r.unit === "half" ? 0.5 : 1);
        lmMap[r.employee_id][k].dates.push(r.leave_date);
      });
      setLeaveMonth(lmMap);

      // 🔧 v9: หักทั้งหมดในเดือน แยกตามแท็ก (ตัด note='เงินออก') สำหรับสลิป
      const { data: alld } = await supabase
        .from("deductions").select("employee_id, amount, note, deduction_types(name)")
        .in("employee_id", empIds).gte("deduct_date", dateFrom).lte("deduct_date", dateTo);
      const dtMap = {};
      (alld || []).forEach(d => {
        if (d.note === "เงินออก") return;
        const nm = d.deduction_types?.name || "อื่นๆ";
        if (!dtMap[d.employee_id]) dtMap[d.employee_id] = {};
        dtMap[d.employee_id][nm] = (dtMap[d.employee_id][nm] || 0) + Number(d.amount || 0);
      });
      const dtArr = {};
      Object.keys(dtMap).forEach(eid => {
        dtArr[eid] = Object.entries(dtMap[eid]).map(([name, amount]) => ({ name, amount }));
      });
      setDedByType(dtArr);
    } catch(e) {
      setMsg({ type:"error", text:"❌ " + e.message });
    } finally { setLoading(false); }
  }, [year, month]);

  useEffect(() => { loadAll(); }, [loadAll]);

  function getCycleKey(cycle) { return cycle.isMonthEnd ? "month_end" : toLocalDateStr(cycle.dateTo); }

  function getLogsInCycle(empId, cycle) {
    const f = toLocalDateStr(cycle.dateFrom), t = toLocalDateStr(cycle.dateTo);
    return allLogs.filter(l =>
      l.employee_id === empId && l.work_date >= f && l.work_date <= t &&
      new Date(l.work_date + "T00:00:00").getDay() !== 0 &&
      !(l.hr_note && /ขาด|ลาป่วย|ลากิจ|ครึ่งวัน/.test(l.hr_note))   // 🆕 ขาด/ลา/ลาครึ่งวัน → ไม่เข้ารอบเสาร์ (ทุกการลาจ่ายสิ้นเดือน)
    );
  }

  function getAdvancesInCycle(empId, cycle) {
    const f = toLocalDateStr(cycle.dateFrom), t = toLocalDateStr(cycle.dateTo);
    return advances.filter(a => a.employee_id === empId && a.deduct_date >= f && a.deduct_date <= t);
  }
  function getAdvanceInCycle(empId, cycle) {
    return getAdvancesInCycle(empId, cycle).reduce((s,a) => s + parseFloat(a.amount||0), 0);
  }

  function getExtraInCycle(empId, cycle) {
    if (cycle.isMonthEnd) return 0;
    return extraAssign[empId]?.[getCycleKey(cycle)] || 0;
  }

  function getSaturdayRows(cycle) {
    return payrolls
      .filter(r => r.employees?.pay_schedule !== "end_of_month")
      .map(r => {
        const logs   = getLogsInCycle(r.employee_id, cycle);
        const { workDays, wage } = calcCycleWageForEmployee(r, logs, lateTagMap);
        const extra  = getExtraInCycle(r.employee_id, cycle);
        const advAmt = getAdvanceInCycle(r.employee_id, cycle);
        const advItems = getAdvancesInCycle(r.employee_id, cycle);
        const toPay  = Math.max(0, Math.round(wage + extra - advAmt));
        return { record: r, workDays, wage, extra, advAmt, advItems, toPay };
      })
      .filter(row => row.workDays > 0 || row.advAmt > 0 || row.extra > 0);
  }

  function getEmpSaturdayTotal(r) {
    if (r.employees?.pay_schedule === "end_of_month") return 0;
    return cycles.filter(c => !c.isMonthEnd).reduce((sum, c) => {
      const _v = vouchers[getCycleKey(c)]; if (_v && (_v.status === "approved" || _v.status === "submitted") && _v.lines) { const _ln = _v.lines.find(x => x.employee_id === r.employee_id); return sum + (_ln ? Number(_ln.to_pay || 0) : 0); } const { wage } = calcCycleWageForEmployee(r, getLogsInCycle(r.employee_id, c), lateTagMap);
      const extra = getExtraInCycle(r.employee_id, c);
      const adv = getAdvanceInCycle(r.employee_id, c);
      return sum + Math.max(0, Math.round(wage + extra - adv));
    }, 0);
  }

  function getMonthEndPay(r) {
    const net = r.net_pay != null ? r.net_pay : (r.total_income||0)-(r.total_deduct||0);
    return parseFloat((net - getEmpSaturdayTotal(r)).toFixed(2));
  }

  // ════════════════════════════════════════════════════════════
  // v5.1: จัดสรร OT + "อื่นๆ" ติดป้าย "จ่ายเสาร์" ลงรอบเสาร์ที่ถูกต้อง
  //   - รวม income_type: 'ot' และ 'other' (disburse_on='saturday')
  //   - ตาม cycle_date ที่ HR เลือก (ถ้าจับคู่ได้)
  //   - จับไม่ได้ / ไม่มี cycle_id → รอบเสาร์สุดท้ายที่มีจริง
  // ════════════════════════════════════════════════════════════
  const saturdayCycles = cycles.filter(c => !c.isMonthEnd);
  const extraAssign = {}; // empId → { cycleKey → amount }
  for (const e of extraIncome) {
    // v5.1: รวม ot และ other (position ติดป้ายสิ้นเดือน → ตกในก้อนสิ้นเดือนเอง)
    if (e.income_type !== "ot" && e.income_type !== "other") continue;
    if (e.disburse_on !== "saturday") continue;
    const targetDate = e.cycle_id ? cycleDateMap[e.cycle_id] : null;
    let target = null;
    if (targetDate) {
      target = saturdayCycles.find(c =>
        toLocalDateStr(c.dateFrom) <= targetDate && targetDate <= toLocalDateStr(c.dateTo));
    }
    if (!target) target = saturdayCycles[saturdayCycles.length - 1];
    if (!target) continue;
    const key = getCycleKey(target);
    if (!extraAssign[e.employee_id]) extraAssign[e.employee_id] = {};
    extraAssign[e.employee_id][key] = (extraAssign[e.employee_id][key] || 0) + Number(e.amount || 0);
  }

  // รายการรายได้พิเศษ "อื่นๆ" รายบรรทัด (เช่น ค่าเที่ยว + ช่วงเวลา) — โชว์เป็นมินิเซกชันในสลิป
  const otherItemsByEmp = {}; // empId → [{label, amount, disburse_on}]
  for (const e of extraIncome) {
    if (e.income_type !== "other") continue;
    if (!otherItemsByEmp[e.employee_id]) otherItemsByEmp[e.employee_id] = [];
    otherItemsByEmp[e.employee_id].push({
      label: e.label || "รายได้อื่นๆ",
      amount: Number(e.amount || 0),
      disburse_on: e.disburse_on || "month_end",
    });
  }

  const allNetTotal      = payrolls.reduce((s,r) => s + (r.net_pay ?? (r.total_income||0)-(r.total_deduct||0)), 0);
  const allSaturdayTotal = payrolls.reduce((s,r) => s + getEmpSaturdayTotal(r), 0);
  const monthEndTotal    = payrolls.reduce((s,r) => s + getMonthEndPay(r), 0);
  const grandTotal       = allSaturdayTotal + monthEndTotal;
  const isBalanced       = Math.abs(grandTotal - allNetTotal) < 1;

  function buildLines(rows) {
    return rows.map(row => ({
      employee_id: row.record.employee_id,
      emp_code:    row.record.employees?.emp_code,
      nickname:    row.record.employees?.nickname,
      full_name:   row.record.employees?.full_name,
      work_days:   row.workDays, wage: row.wage,
      ot:          row.extra || 0,
      advance:     row.advAmt,  to_pay: row.toPay,
      income_items: row.income_items || [],
    }));
  }
  function genVoucherNo(cycleKey, existingCount) {
    return `V${year}-${String(month).padStart(2,"0")}-${String(existingCount+1).padStart(3,"0")}`;
  }

  async function submitVoucher(cycle, rows, isMonthEnd) {
    // 🔒 งวดปิดแล้ว = ห้ามสร้าง/สร้างใบเบิกใหม่ (ทับ to_pay ที่ปรับมือไว้)
    if (period?.is_closed) { setMsg({ type:"error", text:"🔒 งวดนี้ปิดแล้ว — สร้าง/สร้างใบเบิกใหม่ไม่ได้ (เปิดงวดที่หน้า 💰 เงินเดือน ก่อน)" }); return; }
    const cycleKey = getCycleKey(cycle);
    const existing = vouchers[cycleKey];
    if (existing && existing.status !== "returned") { setMsg({ type:"warn", text:"⚠️ รอบนี้มีใบเบิกแล้ว" }); return; }
    const totalAmount = rows.reduce((s,r) => s + r.toPay, 0);
    setSubmitting(cycleKey);
    try {
      const payload = {
        period_id: period.id,
        cycle_date: isMonthEnd ? null : toLocalDateStr(cycle.dateTo),
        voucher_no: existing?.voucher_no || genVoucherNo(cycleKey, Object.keys(vouchers).length),
        status: "submitted", total_amount: totalAmount,
        employee_count: rows.length, lines: buildLines(rows),
        submitted_at: new Date().toISOString(),
      };
      let error;
      if (existing) {
        ({ error } = await supabase.from("payout_vouchers")
          .update({ ...payload, returned_at: null, return_reason: null }).eq("id", existing.id));
      } else {
        ({ error } = await supabase.from("payout_vouchers").insert(payload));
      }
      if (error) throw error;
      setMsg({ type:"ok", text:`✅ ยื่นใบเบิกรอบ ${fmtDate(cycle.dateFrom)}–${fmtDate(cycle.dateTo)} แล้ว` });
      await loadAll();
    } catch(e) { setMsg({ type:"error", text:"❌ "+e.message }); }
    finally { setSubmitting(null); }
  }

  async function approveVoucher(cycleKey) {
    const v = vouchers[cycleKey]; if (!v) return;
    setApproving(cycleKey);
    try {
      const { error } = await supabase.from("payout_vouchers")
        .update({ status:"approved", approved_at: new Date().toISOString() }).eq("id", v.id);
      if (error) throw error;
      setMsg({ type:"ok", text:"✅ อนุมัติใบเบิกแล้ว" });
      await loadAll();
    } catch(e) { setMsg({ type:"error", text:"❌ "+e.message }); }
    finally { setApproving(null); }
  }

  async function returnVoucher() {
    if (!returnModal) return;
    const v = vouchers[returnModal.cycleKey]; if (!v) return;
    try {
      const { error } = await supabase.from("payout_vouchers")
        .update({ status:"returned", returned_at: new Date().toISOString(), return_reason: returnReason||"ตีกลับ" })
        .eq("id", v.id);
      if (error) throw error;
      setMsg({ type:"warn", text:"↩️ ตีกลับแล้ว — HR แก้ไขและยื่นใหม่" });
      setReturnModal(null); setReturnReason(""); await loadAll();
    } catch(e) { setMsg({ type:"error", text:"❌ "+e.message }); }
  }

  // ════════════════════════════════════════════════════════════
  // พิมพ์ slip (A4 · 2 คน/แผ่น) — ดึงจาก voucher.lines (snapshot)
  //   - รอบเสาร์ : ค่าแรงรอบนี้ / OT-อื่นๆ / เบิกในรอบ / จ่ายจริง
  //   - สิ้นเดือน : สุทธิทั้งเดือน / จ่ายเสาร์แล้ว / จ่ายสิ้นเดือน
  // ════════════════════════════════════════════════════════════
  function openPrintModal(voucher) {
    if (!voucher || !(voucher.lines || []).length) {
      setMsg({ type:"warn", text:"⚠️ ไม่มีข้อมูลใบเบิกให้พิมพ์" });
      return;
    }
    setPrintModal({ voucher, selected: new Set(voucher.lines.map(l => l.employee_id)) });
  }

  function printVoucherSlips(voucher, selectedIds) {
    if (!voucher || !(voucher.lines || []).length) {
      setMsg({ type:"warn", text:"⚠️ ไม่มีข้อมูลใบเบิกให้พิมพ์" });
      return;
    }
    const isMonthEnd = !voucher.cycle_date;
    const beYear     = period.year < 2500 ? period.year + 543 : period.year;
    const monthLabel = `${MONTHS_SHORT[month]} ${beYear}`;
    const cycleLabel = isMonthEnd
      ? "จ่ายสิ้นเดือน"
      : `รอบเสาร์ · ถึง ${fmtDate(new Date(voucher.cycle_date + "T00:00:00"))}`;

    const lines = [...voucher.lines]
      .filter(l => !selectedIds || selectedIds.has(l.employee_id))
      .sort((a,b) => (a.emp_code||"").localeCompare(b.emp_code||"", undefined, { numeric:true }));
    if (!lines.length) { setMsg({ type:"warn", text:"⚠️ ยังไม่ได้เลือกพนักงานที่จะพิมพ์" }); return; }

    // ชื่อจริง: ใช้จาก snapshot ก่อน; ถ้า voucher เก่าไม่มี → ดึงสดจากพนักงานปัจจุบัน
    const nameMap = {};
    payrolls.forEach(r => { nameMap[r.employee_id] = r.employees?.full_name; });
    const fullNameOf = (l) => l.full_name || nameMap[l.employee_id] || "";

    // 🔧 v5.2: ยอดคืน (ประกันงาน/ค่าสมัคร) ตอนลาออก — ดึงสดจาก payroll_records เพื่อโชว์เป็นหมายเหตุใต้สุทธิ
    const refundMap = {};
    payrolls.forEach(r => { refundMap[r.employee_id] = {
      ins: Number(r.insurance_refund || 0), app: Number(r.app_fee_refund || 0) }; });

    const prMap = {};
    payrolls.forEach(r => { prMap[r.employee_id] = r; });

    const money = (n) => Number(n||0).toLocaleString("th-TH",{ minimumFractionDigits:2, maximumFractionDigits:2 });
    const esc   = (str) => String(str==null?"":str).replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));

    function slipRows(l) {
      const incItems = (l.income_items || []).filter(it => Number(it.amount) > 0);
      const extraSection = incItems.length
        ? `<div class="line"></div>
           <div class="mini-h">รายได้พิเศษเดือนนี้ (รวมในยอดสุทธิแล้ว)</div>
           ${incItems.map(it => `<div class="row mini"><span>${esc(it.label)}</span><span class="green">${money(it.amount)}</span></div>`).join("")}`
        : "";
      if (isMonthEnd) {
        const sat = Number(l.advance||0);                       // ค่าแรงเสาร์รวม (จ่ายไปแล้ว)
        const mEnd = Math.round(Number(l.to_pay||0));           // รับสิ้นเดือน (จ่ายจริง)
        const m0 = (v) => Math.round(Number(v||0)).toLocaleString("th-TH");
        const R  = (v) => Math.round(Number(v||0));
        const row = (label, val, cls) => '<div class="row col-row"><span>' + label + '</span><span class="' + (cls||"") + '">' + m0(val) + '</span></div>';
        const pr  = prMap[l.employee_id] || {};
        const emp = pr.employees || {};
        const rf  = refundMap[l.employee_id] || { ins:0, app:0 };
        const num = (v) => Number(v||0);
        const dRow = (label, val, cls) =>
          num(val) > 0 ? `<div class="row col-row"><span>${label}</span><span class="${cls||""}">${money(val)}</span></div>` : "";

        // ── รายได้: เงินเดือน(permanent)=เต็มเดือน / ค่าแรง(trial)=ตามวัน — ยอดสะอาด ──
        const isPerm   = (emp.emp_type === 'permanent');
        const dRate    = num(emp.daily_rate);
        const mSalary  = num(emp.monthly_salary);
        const fullDays = (isPerm && dRate > 0) ? Math.round(mSalary / dRate) : num(pr.work_days);
        const absenceAmt  = isPerm ? Math.max(0, mSalary - num(pr.base_wage) - num(pr.holiday_wage)) : 0;
        const absenceDays = (absenceAmt > 0.5 && dRate > 0) ? (Math.round(absenceAmt / dRate * 10) / 10) : 0;
        const wageAmt   = isPerm ? R(mSalary) : R(num(pr.base_wage) + num(pr.holiday_wage));
        const wageLabel = isPerm ? ('เงินเดือน (' + fullDays + ' วัน)') : ('ค่าแรง (' + num(pr.work_days) + ' วัน)');
        const otherInc = [];
        if (num(pr.ot_amount) > 0)          otherInc.push(['OT (' + num(pr.ot_hours) + ' ชม.)', R(pr.ot_amount), 'green']);
        if (num(pr.diligence_bonus) > 0)    otherInc.push(['เบี้ยขยัน', R(pr.diligence_bonus), 'green']);
        if (num(pr.position_allowance) > 0) otherInc.push(['เงินประจำตำแหน่ง', R(pr.position_allowance), 'green']);
        const incItems2 = (l.income_items || []).filter(it => Number(it.amount) > 0);
        if (incItems2.length) incItems2.forEach(it => otherInc.push([esc(it.label), R(it.amount), 'green']));
        else if (num(pr.other_income) > 0) otherInc.push(['รายได้พิเศษ', R(pr.other_income), 'green']);
        const incTotal = wageAmt + otherInc.reduce((sm, x) => sm + x[1], 0);
        const incHtml = row(wageLabel, wageAmt) + otherInc.map(x => row(x[0], x[1], x[2])).join("");

        // ── รายการหัก: เพิ่ม "ขาดงาน" (permanent) + รวมค่าแรงเสาร์เข้า "เบิกเงินสด" (รับเศษ) ──
        const expTotal = incTotal - mEnd;
        const DED_ORDER = ["ค่าแม็กโคร","เงินกู้ยืม","เงินกู้ กยศ.","ค่าสินค้าชำรุด","อื่นๆ"];
        const tagDeds = (dedByType[l.employee_id] || [])
          .filter(t => num(t.amount) > 0 && t.name !== "เบิกเงินสด")
          .sort((a,b) => ((DED_ORDER.indexOf(a.name)+1) || 99) - ((DED_ORDER.indexOf(b.name)+1) || 99));
        const fixedDed = [];
        if (num(pr.job_insurance) > 0)   fixedDed.push(['ประกันงาน', R(pr.job_insurance)]);
        if (num(pr.social_security) > 0) fixedDed.push(['ประกันสังคม', R(pr.social_security)]);
        if (absenceAmt > 0.5)            fixedDed.push(['ขาดงาน ' + absenceDays + ' วัน', R(absenceAmt)]);
        if (num(pr.late_deduct) > 0)     fixedDed.push(['หักสาย', R(pr.late_deduct)]);
        if (num(pr.leave_deduct) > 0)    fixedDed.push(['ลา/ขาด', R(pr.leave_deduct)]);
        const otherDedSum = fixedDed.reduce((sm, x) => sm + x[1], 0) + tagDeds.reduce((sm, t) => sm + R(t.amount), 0);
        const cashShow = expTotal - otherDedSum;
        const dedHtml =
          fixedDed.map(x => row(x[0], x[1], "red")).join("") +
          (cashShow > 0 ? row('เบิกเงินสด', cashShow, "red") : "") +
          tagDeds.map(t => row(t.name, R(t.amount), "red")).join("");
        const baseInfo = (num(emp.monthly_salary) > 0 || num(emp.daily_rate) > 0)
          ? `<div class="baseinfo">ฐานเงินเดือน ${money(emp.monthly_salary)} · วันละ ${money(emp.daily_rate)} บ.</div>` : "";
        const rfParts = [];
        if (rf.ins > 0) rfParts.push(`คืนประกัน ${money(rf.ins)}`);
        if (rf.app > 0) rfParts.push(`คืนค่าสมัคร ${money(rf.app)}`);
        const rfNote = rfParts.length
          ? `<div class="row note"><span>(รวม${rfParts.join(" + ")})</span><span></span></div>`
          : "";
        // v7: ประกันงานสะสม + สิทธิ์ลา (ใช้ string concat เลี่ยง template ซ้อน)
        const insB = insBal[l.employee_id] || 0;
        const lm   = leaveMonth[l.employee_id] || { sick:{days:0,dates:[]}, personal:{days:0,dates:[]} };
        const lsm  = leaveSum[l.employee_id] || {};
        const fmtLeaveDates = (dates) => {
          const days = (dates || []).map(d => parseInt(String(d).slice(8,10), 10)).sort((a,b) => a - b);
          return days.length ? days.join(", ") + " " + MONTHS_SHORT[month] : "";
        };
        const dnum = (v) => (v == null) ? "\u2014" : Number(v).toLocaleString("th-TH");
        const leaveLine = (label, used, dates, remain) => {
          const dtxt = (dates && dates.length) ? " (" + fmtLeaveDates(dates) + ")" : "";
          return '<div class="row mini2"><span>' + label + ' \u00b7 \u0e43\u0e0a\u0e49\u0e40\u0e14\u0e37\u0e2d\u0e19\u0e19\u0e35\u0e49 ' + dnum(used) + ' \u0e27\u0e31\u0e19' + dtxt +
                 '</span><span>\u0e04\u0e07\u0e40\u0e2b\u0e25\u0e37\u0e2d ' + dnum(remain) + ' \u0e27\u0e31\u0e19</span></div>';
        };
        const accSection =
          '<div class="line"></div>' +
          '<div class="row mini2"><span>\u0e1b\u0e23\u0e30\u0e01\u0e31\u0e19\u0e07\u0e32\u0e19\u0e2a\u0e30\u0e2a\u0e21 (\u0e23\u0e27\u0e21\u0e40\u0e14\u0e37\u0e2d\u0e19\u0e19\u0e35\u0e49\u0e41\u0e25\u0e49\u0e27)</span><span>' + money(insB) + ' \u0e1a\u0e32\u0e17</span></div>' +
          '<div class="leave-h">\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c\u0e01\u0e32\u0e23\u0e25\u0e32</div>' +
          leaveLine('\u0e25\u0e32\u0e1b\u0e48\u0e27\u0e22', lm.sick.days, lm.sick.dates, lsm.sick_remaining) +
          ((lsm.personal_quota == null || Number(lsm.personal_quota) === 0)
            ? '<div class="row mini2"><span>\u0e25\u0e32\u0e01\u0e34\u0e08 \u2014 \u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e44\u0e14\u0e49\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c (\u0e17\u0e14\u0e25\u0e2d\u0e07\u0e07\u0e32\u0e19)</span><span></span></div>'
            : leaveLine('\u0e25\u0e32\u0e01\u0e34\u0e08', lm.personal.days, lm.personal.dates, lsm.personal_remaining));
        return `
          ${baseInfo}
          <div class="cols">
            <div class="col">
              <div class="col-h">รายได้</div>
              ${incHtml}
              <div class="line"></div>
              <div class="row col-row sub"><span>รวมรายได้</span><span>${m0(incTotal)}</span></div>
            </div>
            <div class="col">
              <div class="col-h">รายการหัก</div>
              ${dedHtml}
              <div class="line"></div>
              <div class="row col-row sub"><span>รวมรายการหัก</span><span>${m0(expTotal)}</span></div>
            </div>
          </div>
          <div class="line"></div>
          ${rfNote}
          <div class="row total"><span>รับสิ้นเดือน</span><span>${m0(mEnd)}</span></div>
          ${accSection}`;
      }
      const ot  = Number(l.ot||0);
      const adv = Number(l.advance||0);
      return `
        <div class="row"><span>ค่าแรงรอบนี้ (${l.work_days||0} วัน)</span><span>${money(l.wage)}</span></div>
        ${ot  > 0 ? `<div class="row"><span>OT / รายได้อื่นๆ</span><span class="green">${money(ot)}</span></div>` : ""}
        ${adv > 0 ? `<div class="row"><span>เบิกในรอบ</span><span class="red">(${money(adv)})</span></div>` : ""}
        <div class="line"></div>
        <div class="row total"><span>จ่ายจริง</span><span>${money(l.to_pay)}</span></div>
        ${extraSection}`;
    }

    function slipHtml(l) {
      const fname = esc(fullNameOf(l));
      return `
        <div class="slip">
          <div class="head">
            <div class="co">KMMH · กิจมั่งมีโฮม</div>
            <div class="sub">สลิปเงินเดือน ${esc(monthLabel)}</div>
          </div>
          <div class="who">
            <div class="who-l">
              <div class="name">${esc(l.emp_code)} · ${esc(l.nickname)}</div>
              ${fname ? `<div class="fullname">${fname}</div>` : ""}
            </div>
            <span class="cyc">${esc(cycleLabel)}</span>
          </div>
          <div class="body">${slipRows(l)}</div>
          <div class="sign">
            <div class="sigline"></div>
            <div class="siglabel">ลายเซ็นผู้รับเงิน</div>
            <div class="sigdate">วันที่ ........./........./.........</div>
          </div>
        </div>`;
    }

    // จัด 2 ใบ/แผ่น A4 แนวนอน — ครึ่งแผ่นต่อคน (ขนาดเท่ากันทุกใบ)
    const sheets = [];
    for (let i = 0; i < lines.length; i += 2) {
      const left  = `<div class="half">${slipHtml(lines[i])}</div>`;
      const right = lines[i+1]
        ? `<div class="half">${slipHtml(lines[i+1])}</div>`
        : `<div class="half"></div>`;
      sheets.push(`<div class="sheet">${left}<div class="cut-v"></div>${right}</div>`);
    }

    const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">
      <title>สลิป ${esc(cycleLabel)}</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Sarabun','Tahoma',sans-serif; color:#1e293b; }
        @page { size:A4 landscape; margin:0; }
        .sheet { width:297mm; height:210mm; padding:8mm 7mm; page-break-after:always; display:flex; flex-direction:row; align-items:stretch; }
        .sheet:last-child { page-break-after:auto; }
        .half { flex:1 1 50%; width:50%; height:100%; padding:0 6mm; display:flex; }
        .cut-v { border-left:1px dashed #94a3b8; align-self:stretch; position:relative; }
        .cut-v::after { content:"✂"; position:absolute; left:-3mm; top:50%; font-size:10px; color:#94a3b8; }
        .slip { flex:1; height:100%; border:1px solid #cbd5e1; border-radius:6px; padding:6mm 7mm; display:flex; flex-direction:column; page-break-inside:avoid; }
        .head { text-align:center; border-bottom:1.5px solid #1e3a5f; padding-bottom:2mm; margin-bottom:2.5mm; }
        .co { font-size:15px; font-weight:800; color:#1e3a5f; }
        .sub { font-size:11px; color:#64748b; margin-top:1px; }
        .who { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:2.5mm; }
        .name { font-size:14px; font-weight:700; }
        .fullname { font-size:11px; color:#475569; margin-top:0.5mm; }
        .cyc { font-size:11px; color:#64748b; white-space:nowrap; }
        .body { font-size:12.5px; }
        .row { display:flex; justify-content:space-between; padding:1.3mm 0; }
        .row span:last-child { font-variant-numeric:tabular-nums; }
        .note { font-size:10px; color:#64748b; padding:0 0 1mm; }
        .green { color:#166534; }
        .red { color:#b91c1c; }
        .line { border-top:1px solid #e2e8f0; margin:1mm 0; }
        .total { font-size:14.5px; font-weight:800; color:#1e3a5f; padding-top:1.2mm; }
        .mini-h { font-size:10px; color:#64748b; font-weight:700; margin:1mm 0 0.5mm; }
        .row.mini { font-size:11px; padding:1mm 0; }
        .baseinfo { font-size:10px; color:#64748b; margin-bottom:1mm; }
        .cols { display:flex; gap:8mm; margin:0.5mm 0 1mm; }
        .col { flex:1; min-width:0; }
        .col-h { font-size:11px; font-weight:700; color:#1e3a5f; border-bottom:1px solid #cbd5e1; padding-bottom:0.7mm; margin-bottom:0.7mm; }
        .row.col-row { font-size:11.5px; padding:0.9mm 0; }
        .row.sub { font-weight:700; color:#1e3a5f; }
        .row.mini2 { font-size:11px; padding:0.7mm 0; color:#475569; }
        .leave-h { font-size:11px; font-weight:700; color:#1e3a5f; margin:1.5mm 0 0.3mm; }
        .sign { margin-top:auto; padding-top:5mm; text-align:right; }
        .sigline { border-bottom:1px solid #1e293b; width:55mm; margin-left:auto; }
        .siglabel { font-size:10px; color:#64748b; margin-top:1mm; }
        .sigdate { font-size:10px; color:#64748b; margin-top:1.2mm; }
      </style></head><body>${sheets.join("")}</body></html>`;

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0"; iframe.style.bottom = "0";
    iframe.style.width = "0"; iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch(e) {
        setMsg({ type:"error", text:"❌ พิมพ์ไม่สำเร็จ: " + e.message });
      }
      setTimeout(() => { document.body.removeChild(iframe); }, 1000);
    };
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h2 style={s.title}>💸 รายจ่ายบริษัท</h2>
        <button onClick={loadAll} style={s.refreshBtn}>🔄 โหลดใหม่</button>
      </div>

      {/* 🔒 งวดปิดแล้ว — ห้ามสร้าง/สร้างใบเบิกใหม่ */}
      {period?.is_closed && (
        <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap",
          padding:"10px 14px", borderRadius:8, border:"1px solid #fca5a5",
          background:"#fef2f2", color:"#991b1b", marginBottom:12, fontSize:14 }}>
          <span style={{ fontWeight:800 }}>🔒 งวดนี้ปิดแล้ว</span>
          <span style={{ fontSize:13 }}>ยื่น/สร้างใบเบิกใหม่ไม่ได้ — ถ้าต้องแก้จริง ให้เปิดงวดที่หน้า 💰 เงินเดือน ก่อน</span>
        </div>
      )}

      {/* การ์ดสรุป "เบิกได้อีกเท่าไหร่" — อ่านอย่างเดียว, โหลดข้อมูลเอง ไม่ผูกกับการคำนวณเงินเดือน */}
      <AdvanceSummaryCard />

      {msg && (
        <div style={{ ...s.msgBox,
          background:  msg.type==="ok"?"#f0fdf4":msg.type==="warn"?"#fffbeb":"#fef2f2",
          borderColor: msg.type==="ok"?"#86efac":msg.type==="warn"?"#fde68a":"#fca5a5",
          color:       msg.type==="ok"?"#166534":msg.type==="warn"?"#92400e":"#991b1b",
        }}>
          {msg.text}
          <button onClick={() => setMsg(null)} style={s.msgClose}>✕</button>
        </div>
      )}

      {loading && <p style={{ color:"#6b7280", textAlign:"center", padding:32 }}>⏳ กำลังโหลด...</p>}

      {/* แถบตรวจยอด */}
      {!loading && payrolls.length > 0 && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          flexWrap:"wrap", gap:8, padding:"10px 16px", borderRadius:10, marginBottom:14,
          background: isBalanced?"#f0fdf4":"#fef2f2",
          border: `1px solid ${isBalanced?"#86efac":"#fca5a5"}` }}>
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

      {/* รอบเสาร์ */}
      {!loading && cycles.filter(c => !c.isMonthEnd).map((cycle, ci) => {
        const cycleKey   = getCycleKey(cycle);
        const rows       = getSaturdayRows(cycle);
        const voucher    = vouchers[cycleKey];
        const totalPay   = rows.reduce((s,r) => s + r.toPay, 0);
        const statusInfo = voucher ? STATUS_LABEL[voucher.status] : null; const isCollapsed = collapsed[cycleKey] !== undefined ? collapsed[cycleKey] : (voucher?.status === "approved");

        return (
          <div key={cycleKey} style={s.cycleCard}>
            <div style={{ ...s.cycleHeader, cursor:"pointer" }} onClick={() => setCollapsed(p => ({ ...p, [cycleKey]: !isCollapsed }))}>
              <div>
                <span style={s.cycleLabel}>{isCollapsed ? "▶" : "▼"} รอบที่ {ci+1}</span>
                <span style={s.cycleDates}>{DOW_TH[cycle.dateFrom.getDay()]} {fmtDate(cycle.dateFrom)} – {DOW_TH[cycle.dateTo.getDay()]} {fmtDate(cycle.dateTo)}</span>
              </div>
              <span style={{ ...s.statusBadge,
                background: statusInfo?.bg || "#f1f5f9",
                color: statusInfo?.color || "#94a3b8" }}>
                {statusInfo?.text || "📋 ยังไม่มีใบเบิก"}
              </span>
            </div>

            <div style={{ display: isCollapsed ? "none" : "block" }}>{rows.length === 0
              ? <p style={s.emptyMsg}>ยังไม่มีข้อมูลการทำงานในรอบนี้</p>
              : <div style={{ overflowX:"auto" }}>
                  <table style={s.table}>
                    <thead><tr>
                      {["รหัส","ชื่อ","ประเภท","วันทำ","ค่าแรงรอบนี้","OT/อื่นๆ","เบิกในรอบ","จ่ายเสาร์",""].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {rows.map(({ record:r, workDays, wage, extra, advAmt, advItems, toPay }) => (
                        <tr key={r.employee_id} style={s.tr}>
                          <td style={{ ...s.td, color:"#94a3b8", fontSize:12 }}>{r.employees?.emp_code}</td>
                          <td style={{ ...s.td, fontWeight:700 }}>
                            {r.employees?.nickname}
                            {r.has_review && <span style={{ marginLeft:4, fontSize:11 }}>⚠️</span>}
                          </td>
                          <td style={{ ...s.td, color:"#64748b" }}>
                            {r.employees?.emp_type === "permanent" ? "ประจำ" : "ทดลอง"}
                          </td>
                          <td style={{ ...s.td, textAlign:"right" }}>{workDays} วัน</td>
                          <td style={{ ...s.td, textAlign:"right" }}>{fmt(wage)}</td>
                          <td style={{ ...s.td, textAlign:"right", color: extra>0?"#16a34a":"#9ca3af" }}>
                            {extra > 0 ? fmt(extra) : "—"}
                          </td>
                          <td style={{ ...s.td, textAlign:"right", color: advAmt>0?"#dc2626":"#9ca3af" }}>
                            {advAmt > 0 ? `(${fmt(advAmt)})` : "—"}
                          </td>
                          <td style={{ ...s.td, textAlign:"right", fontWeight:700, fontSize:15, color:"#1e3a5f" }}>
                            {fmtInt(toPay)}
                          </td>
                          <td style={{ ...s.td, textAlign:"center" }}>
                            <button
                              onClick={() => setDetail({ record:r, workDays, wage, extra, advAmt, advItems, toPay, cycleLabel:`รอบที่ ${ci+1}`, cycleFrom: cycle.dateFrom, cycleTo: cycle.dateTo })}
                              style={s.glassBtn}>🔍</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background:"#f0f4f8" }}>
                        <td style={s.td} colSpan={7}><span style={{ fontWeight:700 }}>รวม</span></td>
                        <td style={{ ...s.td, textAlign:"right", fontWeight:800, fontSize:17, color:"#1e3a5f" }}>{fmtInt(totalPay)}</td>
                        <td style={s.td} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
            }

            {voucher && <VoucherInfo voucher={voucher} />}
            <VoucherActions role={role} cycleKey={cycleKey} voucher={voucher} rows={rows} locked={period?.is_closed}
              totalPay={totalPay} submitting={submitting} approving={approving}
              onSubmit={() => submitVoucher(cycle, rows, false)}
              onApprove={() => approveVoucher(cycleKey)}
              onReturn={() => setReturnModal({ cycleKey })}
              onPrint={() => openPrintModal(voucher)} /></div>
          </div>
        );
      })}

      {/* สิ้นเดือน */}
      {!loading && payrolls.length > 0 && (() => {
        const meRows    = sortByEmpCode(payrolls).map(r => ({
          record: r, workDays:0, wage:0, extra:0,
          advAmt: getEmpSaturdayTotal(r), advItems: [],
          income_items: (otherItemsByEmp[r.employee_id] || []).filter(it => it.disburse_on !== "saturday"),
          toPay:  getMonthEndPay(r),
        }));
        const voucherMe  = vouchers["month_end"];
        const statusInfo = voucherMe ? STATUS_LABEL[voucherMe.status] : null; const meCollapsed = collapsed["month_end"] !== undefined ? collapsed["month_end"] : (voucherMe?.status === "approved");

        return (
          <div style={{ ...s.cycleCard, border:"2px solid #7c3aed" }}>
            <div style={{ ...s.cycleHeader, background:"#4c1d95", cursor:"pointer" }} onClick={() => setCollapsed(p => ({ ...p, month_end: !meCollapsed }))}>
              <div>
                <span style={s.cycleLabel}>{meCollapsed ? "▶" : "▼"} 💜 จ่ายสิ้นเดือน</span>
                <span style={s.cycleDates}>ส่วนที่เหลือ = สุทธิทั้งเดือน − จ่ายเสาร์แล้ว</span>
              </div>
              <span style={{ ...s.statusBadge,
                background: statusInfo?.bg || "#f1f5f9",
                color: statusInfo?.color || "#94a3b8" }}>
                {statusInfo?.text || "📋 ยังไม่มีใบเบิก"}
              </span>
            </div>

            <div style={{ display: meCollapsed ? "none" : "block" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={s.table}>
                <thead><tr>
                  {["รหัส","ชื่อ","รอบจ่าย","สุทธิทั้งเดือน","จ่ายเสาร์แล้ว","จ่ายสิ้นเดือน",""].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {meRows.map(({ record:r, toPay }) => {
                    const isME     = r.employees?.pay_schedule === "end_of_month";
                    const net      = r.net_pay ?? (r.total_income||0)-(r.total_deduct||0);
                    const satTotal = getEmpSaturdayTotal(r);
                    return (
                      <tr key={r.employee_id} style={s.tr}>
                        <td style={{ ...s.td, color:"#94a3b8", fontSize:12 }}>{r.employees?.emp_code}</td>
                        <td style={{ ...s.td, fontWeight:700 }}>{r.employees?.nickname}</td>
                        <td style={{ ...s.td, textAlign:"center" }}>
                          <span style={{ fontSize:12, padding:"3px 10px", borderRadius:20, fontWeight:700,
                            background: isME?"#7c3aed":"#0ea5e9", color:"#fff" }}>
                            {isME ? "💜 สิ้นเดือน" : "🔵 รายเสาร์"}
                          </span>
                        </td>
                        <td style={{ ...s.td, textAlign:"right" }}>{fmtInt(net)}</td>
                        <td style={{ ...s.td, textAlign:"right", color: satTotal>0?"#0ea5e9":"#9ca3af" }}>
                          {satTotal > 0 ? `(${fmtInt(satTotal)})` : "—"}
                        </td>
                        <td style={{ ...s.td, textAlign:"right", fontWeight:700, fontSize:15, color:"#4c1d95" }}>
                          {fmtInt(toPay)}
                        </td>
                        <td style={{ ...s.td, textAlign:"center" }}>
                          <button onClick={() => setDetail({ record:r, toPay, satTotal, isMonthEnd:true })}
                            style={s.glassBtn}>🔍</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background:"#f5f3ff" }}>
                    <td style={s.td} colSpan={3}><span style={{ fontWeight:700, color:"#4c1d95" }}>รวม</span></td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:700 }}>{fmtInt(allNetTotal)}</td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:700, color:"#0ea5e9" }}>({fmtInt(allSaturdayTotal)})</td>
                    <td style={{ ...s.td, textAlign:"right", fontWeight:800, fontSize:17, color:"#4c1d95" }}>{fmtInt(monthEndTotal)}</td>
                    <td style={s.td} />
                  </tr>
                </tfoot>
              </table>
            </div>

            </div>{!meCollapsed && voucherMe && <VoucherInfo voucher={voucherMe} />}
            {!meCollapsed && <VoucherActions role={role} cycleKey="month_end" voucher={voucherMe} rows={meRows} locked={period?.is_closed}
              totalPay={monthEndTotal} submitting={submitting} approving={approving}
              onSubmit={() => submitVoucher({ dateFrom:new Date(year,month-1,1), dateTo:new Date(year,month,0), isMonthEnd:true }, meRows, true)}
              onApprove={() => approveVoucher("month_end")}
              onReturn={() => setReturnModal({ cycleKey:"month_end" })}
              onPrint={() => openPrintModal(voucherMe)}
              purple />}
          </div>
        );
      })()}

      {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} />}

      {printModal && (() => {
        const plines = [...(printModal.voucher.lines || [])]
          .sort((a,b) => (a.emp_code||"").localeCompare(b.emp_code||"", undefined, { numeric:true }));
        const toggle = (id) => {
          const next = new Set(printModal.selected);
          next.has(id) ? next.delete(id) : next.add(id);
          setPrintModal({ ...printModal, selected: next });
        };
        const setAll = (on) => setPrintModal({ ...printModal,
          selected: on ? new Set(plines.map(l => l.employee_id)) : new Set() });
        const nSel = printModal.selected.size;
        return (
          <div style={s.modalOverlay} onClick={() => setPrintModal(null)}>
            <div style={{ ...s.modal, width:420 }} onClick={e => e.stopPropagation()}>
              <div style={s.modalHeader}>
                <span style={{ fontWeight:700, color:"#fff" }}>🖨️ เลือกพนักงานที่จะพิมพ์สลิป</span>
                <button onClick={() => setPrintModal(null)} style={s.closeBtn}>✕</button>
              </div>
              <div style={{ padding:16 }}>
                <div style={{ display:"flex", gap:8, marginBottom:10 }}>
                  <button onClick={() => setAll(true)} style={{ ...s.markBtn, background:"#0369a1", flex:1 }}>เลือกทั้งหมด</button>
                  <button onClick={() => setAll(false)} style={{ ...s.markBtn, background:"#94a3b8", flex:1 }}>ไม่เลือก</button>
                </div>
                <div style={{ maxHeight:320, overflow:"auto", border:"1px solid #e2e8f0", borderRadius:8 }}>
                  {plines.map(l => {
                    const on = printModal.selected.has(l.employee_id);
                    return (
                      <label key={l.employee_id} style={{ display:"flex", alignItems:"center", gap:10,
                        padding:"9px 12px", borderBottom:"1px solid #f1f5f9", cursor:"pointer",
                        background: on ? "#eff6ff" : "#fff" }}>
                        <input type="checkbox" checked={on} onChange={() => toggle(l.employee_id)}
                          style={{ width:17, height:17, cursor:"pointer" }} />
                        <span style={{ fontWeight:700, color:"#1e293b", minWidth:46 }}>{l.emp_code}</span>
                        <span style={{ color:"#334155" }}>{l.nickname}</span>
                        <span style={{ marginLeft:"auto", fontVariantNumeric:"tabular-nums", color:"#0369a1", fontWeight:600 }}>
                          {Number(l.to_pay||0).toLocaleString("th-TH")}</span>
                      </label>
                    );
                  })}
                </div>
                <div style={{ display:"flex", gap:8, marginTop:12 }}>
                  <button disabled={!nSel}
                    onClick={() => { printVoucherSlips(printModal.voucher, printModal.selected); setPrintModal(null); }}
                    style={{ ...s.markBtn, background: nSel ? "#0369a1" : "#cbd5e1", flex:2 }}>
                    🖨️ พิมพ์ ({nSel} คน)
                  </button>
                  <button onClick={() => setPrintModal(null)} style={{ ...s.markBtn, background:"#94a3b8", flex:1 }}>ยกเลิก</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {returnModal && (
        <div style={s.modalOverlay} onClick={() => setReturnModal(null)}>
          <div style={{ ...s.modal, width:380 }} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={{ fontWeight:700, color:"#fff" }}>↩️ ตีกลับใบเบิก</span>
              <button onClick={() => setReturnModal(null)} style={s.closeBtn}>✕</button>
            </div>
            <div style={{ padding:16 }}>
              <p style={{ fontSize:14, color:"#475569", marginTop:0 }}>ระบุเหตุผล (ไม่บังคับ)</p>
              <textarea value={returnReason} onChange={e => setReturnReason(e.target.value)}
                placeholder="เช่น ยอดไม่ตรง, ข้อมูลผิด" rows={3}
                style={{ width:"100%", borderRadius:8, border:"1px solid #e2e8f0",
                  padding:"8px 10px", fontSize:13, resize:"vertical", boxSizing:"border-box" }} />
              <div style={{ display:"flex", gap:8, marginTop:12 }}>
                <button onClick={returnVoucher} style={{ ...s.markBtn, background:"#dc2626", flex:1 }}>↩️ ยืนยันตีกลับ</button>
                <button onClick={() => setReturnModal(null)} style={{ ...s.markBtn, background:"#94a3b8", flex:1 }}>ยกเลิก</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function VoucherInfo({ voucher }) {
  const [showLines, setShowLines] = useState(false);
  if (!voucher) return null;
  const lines = voucher.lines || [];
  return (
    <div style={{ margin:"8px 12px 0", padding:"10px 12px", background:"#f8fafc",
      borderRadius:10, border:"1px solid #e2e8f0", fontSize:13 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontWeight:700, color:"#374151" }}>ใบเบิก {voucher.voucher_no}</span>
        <button onClick={() => setShowLines(v => !v)}
          style={{ fontSize:12, padding:"2px 8px", borderRadius:6, border:"1px solid #e2e8f0",
            background:"#fff", cursor:"pointer", color:"#64748b" }}>
          {showLines ? "ซ่อน" : "ดู snapshot"}
        </button>
      </div>
      {voucher.return_reason && (
        <p style={{ margin:"6px 0 0", color:"#991b1b", fontSize:12 }}>⚠️ เหตุผล: {voucher.return_reason}</p>
      )}
      {showLines && lines.length > 0 && (
        <div style={{ marginTop:8, overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead><tr>
              {["รหัส","ชื่อ","วันทำ","ค่าแรง","OT/อื่นๆ","เบิก","จ่าย"].map(h => (
                <th key={h} style={{ padding:"4px 8px", textAlign:h==="รหัส"||h==="ชื่อ"?"left":"right",
                  background:"#f1f5f9", borderBottom:"1px solid #e2e8f0" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {[...lines].sort((a,b) => (a.emp_code||"").localeCompare(b.emp_code||"", undefined, {numeric:true})).map((l,i) => (
                <tr key={i}>
                  <td style={{ padding:"4px 8px", color:"#94a3b8", fontSize:11 }}>{l.emp_code}</td>
                  <td style={{ padding:"4px 8px" }}>{l.nickname}</td>
                  <td style={{ padding:"4px 8px", textAlign:"right" }}>{l.work_days} วัน</td>
                  <td style={{ padding:"4px 8px", textAlign:"right" }}>{Number(l.wage||0).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  <td style={{ padding:"4px 8px", textAlign:"right", color:l.ot>0?"#16a34a":"#9ca3af" }}>
                    {l.ot > 0 ? Number(l.ot).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2}) : "—"}
                  </td>
                  <td style={{ padding:"4px 8px", textAlign:"right", color:l.advance>0?"#dc2626":"#9ca3af" }}>
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

function VoucherActions({ role, cycleKey, voucher, rows, totalPay, submitting, approving, onSubmit, onApprove, onReturn, onPrint, purple, locked }) {
  const status   = voucher?.status;
  const btnColor = purple ? "#7c3aed" : "#1e3a5f";
  return (
    <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:10,
      padding:"12px 16px", borderTop:"1px solid #f1f5f9" }}>
      {locked && (
        <span style={{ fontSize:12, color:"#991b1b", fontWeight:700 }}>🔒 งวดปิดแล้ว — แก้ไขใบเบิกไม่ได้</span>
      )}
      {!locked && role === "hr" && (!voucher || status === "returned") && rows.length > 0 && (
        <button onClick={onSubmit} disabled={submitting===cycleKey}
          style={{ ...s.markBtn, background:btnColor, opacity:submitting===cycleKey?0.6:1 }}>
          {submitting===cycleKey ? "⏳..." : "📤 ยื่นเบิกเงิน"}
        </button>
      )}
      {role === "owner" && status === "submitted" && (
        <>
          <button onClick={onApprove} disabled={approving===cycleKey}
            style={{ ...s.markBtn, background:"#16a34a", opacity:approving===cycleKey?0.6:1 }}>
            {approving===cycleKey ? "⏳..." : "✅ อนุมัติ"}
          </button>
          {!locked && <button onClick={onReturn} style={{ ...s.markBtn, background:"#dc2626" }}>↩️ ตีกลับ</button>}
        </>
      )}
      {status === "approved" && (
        <>
          <span style={{ fontSize:12, color:"#16a34a", fontWeight:700 }}>
            ✅ อนุมัติแล้ว • {new Date(voucher.approved_at).toLocaleString("th-TH")}
          </span>
          <button onClick={onPrint} style={{ ...s.markBtn, background:"#0369a1" }}>🖨️ พิมพ์ slip</button>
        </>
      )}
      <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>รวม {fmtInt(totalPay)} บาท</span>
    </div>
  );
}

function DetailModal({ detail, onClose }) {
  const r   = detail.record;
  const net = r.net_pay ?? (r.total_income||0)-(r.total_deduct||0);

  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={{ ...s.modal, width:460 }} onClick={e => e.stopPropagation()}>
        {/* header */}
        <div style={s.modalHeader}>
          <div>
            <span style={{ fontWeight:700, fontSize:14, color:"#fff" }}>
              {r.employees?.emp_code} · {r.employees?.nickname}
            </span>
            <span style={{ fontSize:12, color:"#93c5fd", marginLeft:8 }}>{r.employees?.full_name}</span>
          </div>
          <button onClick={onClose} style={s.closeBtn}>✕</button>
        </div>

        <div style={{ padding:16 }}>

          {/* ── ยอดที่จ่ายรอบนี้ ── */}
          <div style={{
            padding:"12px 16px", borderRadius:12, marginBottom:14,
            background: detail.isMonthEnd ? "#f5f3ff" : "#eff6ff",
            border: `2px solid ${detail.isMonthEnd ? "#c4b5fd" : "#bfdbfe"}`,
          }}>
            <div style={{ fontSize:12, color: detail.isMonthEnd?"#6d28d9":"#1d4ed8", fontWeight:600, marginBottom:4 }}>
              {detail.isMonthEnd ? "💜 จ่ายสิ้นเดือน" : `🔵 ${detail.cycleLabel} · ${DOW_TH[detail.cycleFrom.getDay()]} ${fmtDate(detail.cycleFrom)} – ${DOW_TH[detail.cycleTo.getDay()]} ${fmtDate(detail.cycleTo)}`}
            </div>
            <div style={{ fontSize:26, fontWeight:800, color: detail.isMonthEnd?"#4c1d95":"#1e3a5f" }}>
              {fmtInt(detail.toPay)} <span style={{ fontSize:14, fontWeight:400 }}>บาท</span>
            </div>
          </div>

          {/* ── สูตรคำนวณรอบเสาร์ ── */}
          {!detail.isMonthEnd && (
            <div style={{ background:"#f8fafc", borderRadius:10, padding:"10px 14px", marginBottom:14,
              border:"1px solid #e2e8f0", fontSize:13 }}>
              <div style={{ fontWeight:700, color:"#374151", marginBottom:8 }}>📐 วิธีคิดรอบนี้</div>
              <CalcRow label="ค่าแรงปกติทั้งเดือน" value={fmtInt(r.base_wage)} unit="บาท" />
              <CalcRow label={`÷ วันทำงาน (${r.work_days} วัน)`} value={fmt(r.base_wage / r.work_days)} unit="บาท/วัน" />
              <CalcRow label={`× วันทำในรอบนี้ (${detail.workDays} วัน)`} value={fmt(detail.wage)} unit="บาท" highlight />
              {(detail.extra > 0 || detail.advAmt > 0) && (
                <>
                  <div style={{ borderTop:"1px dashed #e2e8f0", margin:"6px 0" }} />
                  {detail.extra > 0 && (
                    <CalcRow label="+ OT / รายได้อื่นๆ (จ่ายรอบนี้)" value={`+${fmt(detail.extra)}`} green />
                  )}
                  {detail.advAmt > 0 && (
                    <>
                      <div style={{ fontWeight:600, color:"#374151", fontSize:12, margin:"4px 0" }}>รายการเบิกในรอบนี้</div>
                      {(detail.advItems || []).map((a, i) => (
                        <CalcRow key={i}
                          label={`− ${a.deduction_types?.name || "เบิก"} (${toBE(a.deduct_date)})`}
                          value={`(${fmt(a.amount)})`} red />
                      ))}
                    </>
                  )}
                  <CalcRow label="= จ่ายจริงวันเสาร์" value={fmtInt(detail.toPay)} unit="บาท" bold green />
                </>
              )}
            </div>
          )}

          {/* ── สูตรสิ้นเดือน ── */}
          {detail.isMonthEnd && (
            <div style={{ background:"#faf5ff", borderRadius:10, padding:"10px 14px", marginBottom:14,
              border:"1px solid #e9d5ff", fontSize:13 }}>
              <div style={{ fontWeight:700, color:"#6d28d9", marginBottom:8 }}>📐 วิธีคิดสิ้นเดือน</div>
              <CalcRow label="สุทธิทั้งเดือน" value={fmtInt(net)} unit="บาท" />
              <CalcRow label="− จ่ายเสาร์ไปแล้ว" value={`(${fmtInt(detail.satTotal)})`} red />
              <CalcRow label="= ส่วนเหลือสิ้นเดือน" value={fmtInt(detail.toPay)} unit="บาท" bold green />
            </div>
          )}

          {/* ── รายได้ทั้งเดือน ── */}
          <Section title="💰 รายได้ทั้งเดือน">
            <MiniRow label="ค่าแรงปกติ"          value={fmt(r.base_wage)} />
            <MiniRow label="ค่าแรงวันอาทิตย์"    value={fmt(r.holiday_wage)} />
            <MiniRow label={`OT (${r.ot_hours||0} ชม.)`} value={fmt(r.ot_amount)} />
            <MiniRow label="เงินประจำตำแหน่ง"    value={fmt(r.position_allowance)} />
            <MiniRow label="เบี้ยขยัน"            value={fmt(r.diligence_bonus)} />
            {Number(r.other_income) > 0 && <MiniRow label="รายได้อื่นๆ" value={fmt(r.other_income)} green />}
            {Number(r.insurance_refund) > 0 && <MiniRow label="คืนค่าประกันงาน" value={fmt(r.insurance_refund)} green />}
            {Number(r.app_fee_refund) > 0 && <MiniRow label="คืนค่าสมัครงาน" value={fmt(r.app_fee_refund)} green />}
            <MiniRow label="รวมรายได้" value={fmt(r.total_income)} bold green />
          </Section>

          {/* ── รายหักทั้งเดือน ── */}
          <Section title="📉 รายหักทั้งเดือน">
            <MiniRow label={`สาย (${r.late_minutes||0} น.)`} value={fmt(r.late_deduct)} />
            <MiniRow label="ประกันสังคม"          value={fmt(r.social_security)} />
            <MiniRow label="ประกันงาน"            value={fmt(r.job_insurance)} />
            <MiniRow label="รายจ่ายพนักงาน"       value={fmt(r.other_deduct)} />
            <MiniRow label="เบิกล่วงหน้า"         value={fmt(r.advance_total)} />
            <MiniRow label="รวมรายหัก" value={fmt(r.total_deduct)} bold red />
          </Section>

          {/* สุทธิ */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"10px 14px", background:"#f0fdf4", borderRadius:10,
            border:"2px solid #86efac", marginTop:4 }}>
            <span style={{ fontWeight:600, color:"#475569" }}>💵 สุทธิทั้งเดือน</span>
            <span style={{ fontWeight:800, fontSize:20, color:"#1e3a5f" }}>{fmtInt(net)} บาท</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontWeight:700, fontSize:13, color:"#1e3a5f", margin:"10px 0 4px" }}>{title}</div>
      <div style={{ background:"#f8fafc", borderRadius:8, padding:"4px 10px", border:"1px solid #e2e8f0" }}>
        {children}
      </div>
    </div>
  );
}

function CalcRow({ label, value, unit, bold, green, red, highlight }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
      borderBottom:"1px solid #f1f5f9",
      background: highlight ? "#eff6ff" : "transparent",
      borderRadius: highlight ? 6 : 0, padding: highlight ? "4px 6px" : "4px 0",
    }}>
      <span style={{ color:"#64748b", fontSize:12 }}>{label}</span>
      <span style={{ fontWeight: bold?700:400, fontSize:13,
        color: green?"#166534":red?"#dc2626":highlight?"#1d4ed8":"#1e293b" }}>
        {value} {unit && <span style={{ fontSize:11, color:"#94a3b8" }}>{unit}</span>}
      </span>
    </div>
  );
}

function MiniRow({ label, value, bold, green, red }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"4px 0", borderBottom:"1px solid #f1f5f9" }}>
      <span style={{ color:"#64748b", fontSize:12 }}>{label}</span>
      <span style={{ fontWeight:bold?700:400, fontSize:12,
        color:green?"#166534":red?"#991b1b":"#1e293b" }}>{value}</span>
    </div>
  );
}

const s = {
  page:        { maxWidth:960, margin:"0 auto" },
  header:      { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 },
  title:       { margin:0, fontSize:18, fontWeight:800, color:"#1e3a5f" },
  refreshBtn:  { padding:"6px 14px", borderRadius:8, border:"1px solid #e2e8f0", background:"#f8fafc", cursor:"pointer", fontSize:13 },
  msgBox:      { position:"relative", padding:"10px 36px 10px 14px", borderRadius:8, border:"1px solid", marginBottom:12, fontWeight:600, fontSize:14 },
  msgClose:    { position:"absolute", right:10, top:8, background:"none", border:"none", cursor:"pointer", fontSize:16, color:"inherit", opacity:0.7 },
  cycleCard:   { background:"#fff", borderRadius:14, marginBottom:16, boxShadow:"0 1px 6px rgba(0,0,0,0.08)", overflow:"hidden" },
  cycleHeader: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", background:"#1e3a5f", color:"#fff" },
  cycleLabel:  { fontWeight:800, fontSize:14, marginRight:10 },
  cycleDates:  { fontSize:13, color:"#93c5fd" },
  statusBadge: { fontSize:12, padding:"3px 10px", borderRadius:20, fontWeight:700 },
  emptyMsg:    { color:"#9ca3af", padding:"12px 16px", fontSize:13, margin:0 },
  table:       { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th:          { padding:"8px 12px", textAlign:"left", background:"#f8fafc", borderBottom:"2px solid #e2e8f0", fontWeight:700, color:"#374151", whiteSpace:"nowrap" },
  tr:          { transition:"background 0.1s" },
  td:          { padding:"9px 12px", borderBottom:"1px solid #f1f5f9", whiteSpace:"nowrap" },
  glassBtn:    { background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8, padding:"4px 10px", cursor:"pointer", fontSize:14 },
  markBtn:     { padding:"8px 20px", borderRadius:10, border:"none", color:"#fff", fontWeight:700, fontSize:14, cursor:"pointer" },
  modalOverlay:{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal:       { background:"#fff", borderRadius:16, width:420, maxWidth:"90vw", maxHeight:"88vh", overflow:"auto", boxShadow:"0 20px 60px rgba(0,0,0,0.3)" },
  modalHeader: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 16px", background:"#1e3a5f", borderRadius:"16px 16px 0 0", position:"sticky", top:0, zIndex:1 },
  closeBtn:    { background:"none", border:"none", color:"#fff", fontSize:20, cursor:"pointer", lineHeight:1 },
};
