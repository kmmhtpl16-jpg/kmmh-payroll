// src/payrollCalc.js
// ─────────────────────────────────────────────────────────────
// Logic คำนวณเงินเดือน KMMH
// กฎที่ lock แล้ว (มิ.ย. 2569):
//   - ทาง A: work_days = วันมาจริง (ลา/ขาด ไม่นับ → ตัดออกจาก work_days)
//   - เบี้ยขยัน: 500 = ไม่สาย + ไม่ลาทุกชนิด / 300 = สาย 1-5 น. + ไม่ลา / 0 = อื่นๆ
//   - ปกส. 5% เฉพาะประจำ
//   - OT/สาย: ใช้ผลจาก attendance_logs (late_minutes, ot_hours)
// ─────────────────────────────────────────────────────────────

import { supabase } from "./supabaseClient";

// ════════════════════════════════════════════════════════════
// 1. ดึงข้อมูลที่จำเป็นทั้งหมดสำหรับงวด
// ════════════════════════════════════════════════════════════
export async function fetchPayrollInputs(year, month) {
  const dateFrom = `${year}-${String(month).padStart(2,"0")}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dateTo = `${year}-${String(month).padStart(2,"0")}-${String(daysInMonth).padStart(2,"0")}`;

  // พนักงานทั้งหมด
  const { data: employees, error: empErr } = await supabase
    .from("employees")
    .select("*")
    .eq("is_active", true)
    .order("emp_code");
  if (empErr) throw new Error("โหลดพนักงานไม่สำเร็จ: " + empErr.message);

  // attendance_logs ในงวด
  const { data: logs, error: logErr } = await supabase
    .from("attendance_logs")
    .select("employee_id, work_date, late_minutes, ot_hours, needs_hr_review")
    .gte("work_date", dateFrom)
    .lte("work_date", dateTo);
  if (logErr) throw new Error("โหลดบันทึกเวลาไม่สำเร็จ: " + logErr.message);

  // leave_requests ในงวด (ถ้ามีตาราง — ถ้ายังไม่มีให้ return [])
  let leaves = [];
  try {
    const { data } = await supabase
      .from("leave_requests")
      .select("employee_id, leave_date, unit, hours, is_within_quota")
      .gte("leave_date", dateFrom)
      .lte("leave_date", dateTo);
    if (data) leaves = data;
  } catch (_) { /* ตารางยังไม่มี ข้ามไป */ }

  return { employees, logs: logs || [], leaves, daysInMonth, dateFrom, dateTo };
}

// ════════════════════════════════════════════════════════════
// 2. get_daily_rate — เหมือน SQL function ใน Supabase
// ════════════════════════════════════════════════════════════
export function getDailyRate(emp, daysInMonth) {
  if (emp.emp_type === "permanent") {
    return emp.monthly_salary / daysInMonth;
  }
  return emp.daily_rate || 0;
}

// ════════════════════════════════════════════════════════════
// 3. calcLateDeduct — หักสายรายเดือน (cap ต่อวัน)
//    late_minutes มาจาก attendance_logs (รวมแต่ละวันแยกไว้แล้ว)
//    แต่เราต้องรู้ per-day เพื่อ cap → logs แต่ละ row = 1 วัน
// ════════════════════════════════════════════════════════════
export function calcLateDeduct(dayLogs, hourlyRate, lateTagRate = 1) {
  // dayLogs = array ของ {work_date, late_minutes, ...}
  // lateTagRate = 1 ปกติ / 5 ถ้าถูกแท็ก (per day — ใช้ค่า default 1 ก่อน)
  let total = 0;
  for (const log of dayLogs) {
    const m = log.late_minutes || 0;
    if (m <= 0) continue;
    let deduct;
    if (m <= 40) {
      deduct = m * lateTagRate;
    } else if (m <= 60) {
      deduct = hourlyRate; // = 1 ชั่วโมง
    } else {
      deduct = hourlyRate + 1; // เกิน 60 น. = ชั่วโมง + 1 บาท (cap สูงสุด)
    }
    total += deduct;
  }
  return Math.round(total * 100) / 100;
}

// ════════════════════════════════════════════════════════════
// 4. calcDiligenceBonus — เบี้ยขยัน
// ════════════════════════════════════════════════════════════
export function calcDiligenceBonus(totalLateMin, hasLeave) {
  if (hasLeave) return 0;                 // ลาทุกชนิด → 0
  if (totalLateMin === 0) return 500;     // ไม่สายเลย → 500
  if (totalLateMin <= 5) return 300;      // สาย 1-5 น. → 300
  return 0;                               // สายเกิน 5 น. → 0
}

// ════════════════════════════════════════════════════════════
// 5. calcSocialSecurity — ประกันสังคม
// ════════════════════════════════════════════════════════════
export function calcSocialSecurity(emp, baseWage) {
  if (emp.emp_type !== "permanent") return 0;
  return Math.round(baseWage * 0.05);
}

// ════════════════════════════════════════════════════════════
// 6. calcOneEmployee — คำนวณรายคน
// ════════════════════════════════════════════════════════════
export function calcOneEmployee(emp, empLogs, empLeaves, daysInMonth) {
  const dailyRate  = getDailyRate(emp, daysInMonth);
  const hourlyRate = dailyRate / 8;

  // ── work_days (ทาง A) ────────────────────────────────────
  // นับ log ที่มา (needs_hr_review=false หรือ confirmed)
  // วันอาทิตย์แยกออกเพื่อคำนวณ holiday_wage
  const workLogs    = empLogs.filter(l => !l.needs_hr_review || l.late_minutes >= 0);
  const sundayLogs  = workLogs.filter(l => {
    const d = new Date(l.work_date);
    return d.getDay() === 0; // 0 = อาทิตย์
  });
  const normalLogs  = workLogs.filter(l => {
    const d = new Date(l.work_date);
    return d.getDay() !== 0;
  });

  const work_days   = normalLogs.length;
  const holiday_days = sundayLogs.length;

  // ── รายได้ ────────────────────────────────────────────────
  const base_wage         = Math.round(dailyRate * work_days * 100) / 100;
  const holiday_wage      = Math.round(dailyRate * holiday_days * 100) / 100;
  const ot_hours          = empLogs.reduce((s, l) => s + (l.ot_hours || 0), 0);
  const ot_amount         = Math.round(hourlyRate * ot_hours * 100) / 100;
  const position_allowance = emp.position_allowance || 0;

  const totalLateMin      = empLogs.reduce((s, l) => s + (l.late_minutes || 0), 0);
  const hasLeave          = empLeaves.length > 0;
  const diligence_bonus   = calcDiligenceBonus(totalLateMin, hasLeave);

  const total_income = Math.round(
    (base_wage + holiday_wage + ot_amount + position_allowance + diligence_bonus) * 100
  ) / 100;

  // ── รายหัก ────────────────────────────────────────────────
  const late_deduct       = calcLateDeduct(empLogs, hourlyRate);
  const social_security   = calcSocialSecurity(emp, base_wage);

  // job_insurance จาก insurance_level enum ('none','200','500')
  const job_insurance = emp.insurance_level === "200" ? 200
    : emp.insurance_level === "500" ? 500 : 0;

  // leave_deduct = 0 (ทาง A — หักผ่าน work_days แล้ว)
  const leave_deduct = 0;

  // advance_total, loan_deduct, other_deduct — กรอกมือทีหลัง (0 ตอนคำนวณ auto)
  const advance_total = 0;
  const loan_deduct   = 0;
  const other_deduct  = 0;

  const total_deduct = Math.round(
    (late_deduct + leave_deduct + social_security + job_insurance
     + advance_total + loan_deduct + other_deduct) * 100
  ) / 100;

  const net_pay = Math.floor(total_income - total_deduct); // ROUNDDOWN ตาม Excel

  return {
    employee_id:      emp.id,
    emp_code:         emp.emp_code,
    nickname:         emp.nickname,
    full_name:        emp.full_name,
    emp_type:         emp.emp_type,
    daily_rate:       Math.round(dailyRate * 100) / 100,
    hourly_rate:      Math.round(hourlyRate * 100) / 100,
    // รายได้
    work_days,
    holiday_days,
    ot_hours:         Math.round(ot_hours * 100) / 100,
    base_wage,
    holiday_wage,
    ot_amount,
    position_allowance,
    diligence_bonus,
    total_income,
    // รายหัก
    late_minutes:     totalLateMin,
    late_deduct,
    leave_days:       empLeaves.filter(l => l.unit === "day").length,
    leave_deduct,
    social_security,
    job_insurance,
    advance_total,
    loan_deduct,
    other_deduct,
    total_deduct,
    net_pay,
    // meta
    has_review:       empLogs.some(l => l.needs_hr_review),
  };
}

// ════════════════════════════════════════════════════════════
// 7. calcPayroll — คำนวณทุกคนในงวด (main function)
// ════════════════════════════════════════════════════════════
export async function calcPayroll(year, month) {
  const { employees, logs, leaves, daysInMonth } = await fetchPayrollInputs(year, month);

  const results = employees.map(emp => {
    const empLogs   = logs.filter(l => l.employee_id === emp.id);
    const empLeaves = leaves.filter(l => l.employee_id === emp.id);
    return calcOneEmployee(emp, empLogs, empLeaves, daysInMonth);
  });

  return {
    year,
    month,
    daysInMonth,
    results,
    summary: {
      total_net_pay:    results.reduce((s, r) => s + r.net_pay, 0),
      total_income:     results.reduce((s, r) => s + r.total_income, 0),
      total_deduct:     results.reduce((s, r) => s + r.total_deduct, 0),
      total_ss:         results.reduce((s, r) => s + r.social_security, 0),
      count:            results.length,
      has_review_count: results.filter(r => r.has_review).length,
    },
  };
}

// ════════════════════════════════════════════════════════════
// 8. savePayrollResults — บันทึกผลลง payroll_records
// ════════════════════════════════════════════════════════════
export async function savePayrollResults(year, month, results) {
  // หา period_id
  const { data: period } = await supabase
    .from("pay_periods")
    .select("id")
    .eq("year", year)
    .eq("month", month)
    .single();

  const period_id = period?.id || null;

  const records = results.map(r => ({
    period_id,
    employee_id:       r.employee_id,
    work_days:         r.work_days,
    base_wage:         r.base_wage,
    ot_hours:          r.ot_hours,
    ot_amount:         r.ot_amount,
    position_allowance: r.position_allowance,
    diligence_bonus:   r.diligence_bonus,
    holiday_wage:      r.holiday_wage,
    total_income:      r.total_income,
    late_deduct:       r.late_deduct,
    leave_deduct:      r.leave_deduct,
    social_security:   r.social_security,
    job_insurance:     r.job_insurance,
    advance_total:     r.advance_total,
    loan_deduct:       r.loan_deduct,
    other_deduct:      r.other_deduct,
    total_deduct:      r.total_deduct,
    net_pay:           r.net_pay,
    is_finalized:      false,
    updated_at:        new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("payroll_records")
    .upsert(records, { onConflict: "period_id,employee_id" });

  if (error) throw new Error("บันทึก payroll_records ไม่สำเร็จ: " + error.message);
  return true;
}
