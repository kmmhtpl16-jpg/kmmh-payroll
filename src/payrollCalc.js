// src/payrollCalc.js
// ─────────────────────────────────────────────────────────────
// คำนวณเงินเดือน KMMH — v2
// Logic ตาม KMMH_payroll_logic_v2.md
// ─────────────────────────────────────────────────────────────

import { supabase } from "./supabaseClient";

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function isSunday(dateStr) {
  return new Date(dateStr).getDay() === 0;
}

// หักสายรายวัน (logic v2)
// 1-40 น. → นาที × rate
// 41-60 น. → hourly_rate × 1
// 61+ น.  → hourly_rate × floor(นาที/60) + ส่วนปลีก × rate
function calcLateDeduction(lateMin, ratePerMin, hourlyRate) {
  if (!lateMin || lateMin <= 0) return 0;
  const rate = ratePerMin || 1;
  if (lateMin <= 40) return lateMin * rate;
  if (lateMin <= 60) return hourlyRate;
  const fullHours = Math.floor(lateMin / 60);
  const remainder = lateMin % 60;
  return hourlyRate * fullHours + remainder * rate;
}

// เบี้ยขยัน
function calcDiligenceBonus(totalLateMin, hasLeave, empType) {
  if (hasLeave) return 0;
  if (totalLateMin > 5) return 0;
  if (totalLateMin >= 1) return empType === "permanent" ? 300 : 300;
  return empType === "permanent" ? 500 : 500;
}

// ปกส. 5% cap 875
function calcSocialSecurity(empType, base) {
  if (empType !== "permanent") return 0;
  return Math.min(parseFloat((base * 0.05).toFixed(2)), 875);
}

// ════════════════════════════════════════════════════════════
// calcPayroll — entry point หลัก
// รับ year (ค.ศ.), month (1-12)
// คืน { results[], summary }
// ════════════════════════════════════════════════════════════
export async function calcPayroll(year, month) {
  const days = daysInMonth(year, month);
  const dateFrom = `${year}-${String(month).padStart(2,"0")}-01`;
  const dateTo   = `${year}-${String(month).padStart(2,"0")}-${String(days).padStart(2,"0")}`;

  // ── ดึงพนักงาน active ──
  const { data: employees, error: empErr } = await supabase
    .from("employees")
    .select("*")
    .eq("is_active", true)
    .order("emp_code");
  if (empErr) throw new Error("โหลดพนักงานไม่ได้: " + empErr.message);

  // ── ดึง attendance_logs ทั้งเดือน ──
  const empIds = employees.map(e => e.id);
  const { data: logs, error: logErr } = await supabase
    .from("attendance_logs")
    .select("*")
    .in("employee_id", empIds)
    .gte("work_date", dateFrom)
    .lte("work_date", dateTo)
    .order("work_date");
  if (logErr) throw new Error("โหลด attendance ไม่ได้: " + logErr.message);

  // ── ดึง late_tags ──
  const { data: lateTags } = await supabase
    .from("late_tags")
    .select("employee_id, tag_date, rate_per_minute")
    .in("employee_id", empIds)
    .gte("tag_date", dateFrom)
    .lte("tag_date", dateTo);

  const lateTagMap = {};
  (lateTags || []).forEach(t => {
    lateTagMap[`${t.employee_id}_${t.tag_date}`] = t.rate_per_minute;
  });

  // ── ดึง deductions (รายจ่ายพนักงาน) ──
  const { data: deductions } = await supabase
    .from("employee_deductions")
    .select("*, deduction_types(name)")
    .in("employee_id", empIds)
    .gte("deduct_date", dateFrom)
    .lte("deduct_date", dateTo);

  // ── ดึง advance_requests ──
  const { data: advances } = await supabase
    .from("advance_requests")
    .select("employee_id, amount")
    .in("employee_id", empIds);
  // NOTE: กรองตาม cycle ที่อยู่ในเดือนนี้ — ตอนนี้ดึงทั้งหมดก่อน รอ cycle table

  // ── คำนวณรายคน ──
  const results = [];

  for (const emp of employees) {
    const empLogs = (logs || []).filter(l => l.employee_id === emp.id);
    const empDeductions = (deductions || []).filter(d => d.employee_id === emp.id);
    const empAdvances = (advances || []).filter(a => a.employee_id === emp.id);

    // rate ตั้งต้น
    const dailyTrial = parseFloat(emp.daily_rate) || 0;
    const dailyPerm  = emp.monthly_salary ? emp.monthly_salary / days : dailyTrial;
    const isPerm     = emp.emp_type === "permanent";

    // จุดตัดเข้าประจำกลางเดือน
    const permStart = emp.permanent_start_date;
    const permStartInMonth = permStart &&
      permStart >= dateFrom && permStart <= dateTo;

    let work_days = 0;
    let holiday_days = 0;
    let ot_hours = 0;
    let late_minutes = 0;
    let late_deduct = 0;
    let perm_base = 0;
    let trial_base = 0;
    let has_review = false;
    let has_leave = false;

    for (const log of empLogs) {
      // ถ้ายังต้องตรวจ → flag แต่ยังคำนวณต่อด้วยข้อมูลที่มี
      if (log.needs_hr_review) has_review = true;

      const isHoliday = isSunday(log.work_date);

      if (isHoliday) {
        holiday_days += 1;
        continue;
      }

      // เลือก daily rate ของวันนี้
      const usePerm = isPerm && (!permStartInMonth || log.work_date >= permStart);
      const dayRate = usePerm ? dailyPerm : dailyTrial;
      const hourlyRate = dayRate / 8;

      work_days += 1;

      // base_wage แยกช่วง
      if (usePerm) perm_base += dayRate;
      else trial_base += dayRate;

      // late
      const lateMin = log.late_minutes || 0;
      late_minutes += lateMin;
      const rateTag = lateTagMap[`${emp.id}_${log.work_date}`] || 1;
      late_deduct += calcLateDeduction(lateMin, rateTag, hourlyRate);

      // OT
      ot_hours += parseFloat(log.ot_hours || 0);

      // hr_extra_deduct (ออกระหว่างวัน)
      late_deduct += parseFloat(log.hr_extra_deduct || 0);

      // ลา — ถ้า hr_note มีคำว่าลา → ตัดเบี้ยขยัน
      if (log.hr_note && /ลา|ขาด/.test(log.hr_note)) has_leave = true;
    }

    const base_wage    = parseFloat((trial_base + perm_base).toFixed(2));
    const daily_rate   = parseFloat(dailyPerm.toFixed(2));
    const hourly_rate  = parseFloat((daily_rate / 8).toFixed(2));
    const holiday_wage = parseFloat((
      (usePermRate(emp, permStart, dateFrom) ? dailyPerm : dailyTrial) * holiday_days
    ).toFixed(2));
    const ot_amount    = parseFloat((hourly_rate * ot_hours).toFixed(2));

    // position_allowance และ diligence_bonus จาก employees table
    const position_allowance = parseFloat(emp.position_allowance || 0);
    const diligence_bonus    = calcDiligenceBonus(late_minutes, has_leave, emp.emp_type);

    // app_fee (ค่าสมัคร 100 บาท)
    const isFirstMonth = emp.trial_start_date >= dateFrom && emp.trial_start_date <= dateTo;
    const isResigningThisMonth = emp.resigned_date &&
      emp.resigned_date >= dateFrom && emp.resigned_date <= dateTo;
    const app_fee_deduct = (isFirstMonth && emp.app_fee_status === "none") ? 100 : 0;
    const app_fee_refund = (isResigningThisMonth && emp.app_fee_status === "held") ? 100 : 0;

    // insurance_refund (ยังไม่ implement get_insurance_balance — ใส่ 0 ก่อน)
    const insurance_refund = 0;

    // ปกส.
    const ss_base = permStartInMonth ? perm_base : base_wage;
    const social_security = calcSocialSecurity(emp.emp_type, ss_base);

    // ประกันงาน
    const insuranceLevelMap = { none: 0, level_200: 200, level_500: 500 };
    const job_insurance = isPerm ? (insuranceLevelMap[emp.insurance_level] || 0) : 0;

    // รายจ่ายพนักงาน (other_deduct)
    const other_deduct = empDeductions.reduce((s, d) => s + parseFloat(d.amount || 0), 0);
    const loan_deduct  = 0; // ยังไม่มี loan table
    const advance_total = empAdvances.reduce((s, a) => s + parseFloat(a.amount || 0), 0);

    const total_income = parseFloat((
      base_wage + holiday_wage + ot_amount + position_allowance +
      diligence_bonus + app_fee_refund + insurance_refund
    ).toFixed(2));

    const total_deduct = parseFloat((
      late_deduct + social_security + job_insurance +
      app_fee_deduct + advance_total + loan_deduct + other_deduct
    ).toFixed(2));

    const net_pay = Math.round(total_income - total_deduct);

    results.push({
      employee_id:       emp.id,
      emp_code:          emp.emp_code,
      nickname:          emp.nickname,
      full_name:         emp.full_name,
      emp_type:          emp.emp_type,
      monthly_salary:    emp.monthly_salary || null,
      daily_rate,
      hourly_rate,
      work_days,
      holiday_days,
      ot_hours:          parseFloat(ot_hours.toFixed(2)),
      ot_amount,
      base_wage,
      holiday_wage,
      position_allowance,
      diligence_bonus,
      late_minutes,
      late_deduct:       parseFloat(late_deduct.toFixed(2)),
      leave_days:        0,        // ทาง A — ไม่ใช้
      leave_deduct:      0,        // ทาง A — ไม่ใช้
      social_security,
      job_insurance,
      app_fee_deduct,
      app_fee_refund,
      insurance_refund,
      advance_total:     parseFloat(advance_total.toFixed(2)),
      loan_deduct,
      other_deduct:      parseFloat(other_deduct.toFixed(2)),
      deduction_items:   empDeductions,
      total_income,
      total_deduct,
      net_pay,
      has_review,
    });
  }

  // ── summary ──
  const summary = {
    count:            results.length,
    total_income:     parseFloat(results.reduce((s,r) => s + r.total_income, 0).toFixed(2)),
    total_deduct:     parseFloat(results.reduce((s,r) => s + r.total_deduct, 0).toFixed(2)),
    total_net_pay:    results.reduce((s,r) => s + r.net_pay, 0),
    total_ss:         parseFloat(results.reduce((s,r) => s + r.social_security, 0).toFixed(2)),
    has_review_count: results.filter(r => r.has_review).length,
    daysInMonth:      days,
  };

  return { results, summary, daysInMonth: days };
}

// helper: เลือก rate สำหรับ holiday_wage
function usePermRate(emp, permStart, dateFrom) {
  if (emp.emp_type !== "permanent") return false;
  if (!permStart) return true;
  return permStart <= dateFrom; // เข้าประจำก่อนต้นเดือน = ใช้ perm rate ทั้งเดือน
}

// ════════════════════════════════════════════════════════════
// savePayrollResults — บันทึกลง payroll_records
// ════════════════════════════════════════════════════════════
export async function savePayrollResults(year, month, results) {
  // ดึง period_id
  const { data: period, error: pErr } = await supabase
    .from("pay_periods")
    .select("id")
    .eq("year", year)
    .eq("month", month)
    .single();

  if (pErr || !period) throw new Error("ไม่พบ pay_period สำหรับเดือนนี้ — กรุณาสร้างก่อน");

  const records = results.map(r => ({
    period_id:          period.id,
    employee_id:        r.employee_id,
    work_days:          r.work_days,
    base_wage:          r.base_wage,
    holiday_wage:       r.holiday_wage,
    ot_hours:           r.ot_hours,
    ot_amount:          r.ot_amount,
    position_allowance: r.position_allowance,
    diligence_bonus:    r.diligence_bonus,
    late_minutes:       r.late_minutes,
    late_deduct:        r.late_deduct,
    leave_deduct:       r.leave_deduct,
    social_security:    r.social_security,
    job_insurance:      r.job_insurance,
    advance_total:      r.advance_total,
    loan_deduct:        r.loan_deduct,
    other_deduct:       r.other_deduct,
    total_income:       r.total_income,
    total_deduct:       r.total_deduct,
    net_pay:            r.net_pay,
    is_finalized:       false,
  }));

  const { error } = await supabase
    .from("payroll_records")
    .upsert(records, { onConflict: "period_id,employee_id" });

  if (error) throw new Error("บันทึกไม่สำเร็จ: " + error.message);
}
