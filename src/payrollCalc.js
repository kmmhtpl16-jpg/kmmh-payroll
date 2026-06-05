// src/payrollCalc.js
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

  // ✅ deductions ที่ยังไม่ได้หัก (is_paid = false) ในงวดนี้
  const { data: deductions, error: dedErr } = await supabase
    .from("deductions")
    .select("employee_id, amount, deduction_type_id, deduction_types(name), deduct_date")
    .eq("is_paid", false)
    .gte("deduct_date", dateFrom)
    .lte("deduct_date", dateTo);
  if (dedErr) throw new Error("โหลดรายจ่ายไม่สำเร็จ: " + dedErr.message);

  // leave_requests (ถ้ายังไม่มีตาราง ข้ามไป)
  let leaves = [];
  try {
    const { data } = await supabase
      .from("leave_requests")
      .select("employee_id, leave_date, unit, hours, is_within_quota")
      .gte("leave_date", dateFrom)
      .lte("leave_date", dateTo);
    if (data) leaves = data;
  } catch (_) {}

  return { employees, logs: logs || [], leaves, deductions: deductions || [], daysInMonth, dateFrom, dateTo };
}

// ════════════════════════════════════════════════════════════
// 2. getDailyRate
// ════════════════════════════════════════════════════════════
export function getDailyRate(emp, daysInMonth) {
  if (emp.emp_type === "permanent") return emp.monthly_salary / daysInMonth;
  return emp.daily_rate || 0;
}

// ════════════════════════════════════════════════════════════
// 3. calcLateDeduct
// ════════════════════════════════════════════════════════════
export function calcLateDeduct(dayLogs, hourlyRate) {
  let total = 0;
  for (const log of dayLogs) {
    const m = log.late_minutes || 0;
    if (m <= 0) continue;
    let deduct;
    if (m <= 40)      deduct = m * 1;
    else if (m <= 60) deduct = hourlyRate;
    else              deduct = hourlyRate + 1;
    total += deduct;
  }
  return Math.round(total * 100) / 100;
}

// ════════════════════════════════════════════════════════════
// 4. calcDiligenceBonus
// ════════════════════════════════════════════════════════════
export function calcDiligenceBonus(totalLateMin, hasLeave) {
  if (hasLeave)          return 0;
  if (totalLateMin === 0) return 500;
  if (totalLateMin <= 5)  return 300;
  return 0;
}

// ════════════════════════════════════════════════════════════
// 5. calcSocialSecurity
// ════════════════════════════════════════════════════════════
export function calcSocialSecurity(emp, baseWage) {
  if (emp.emp_type !== "permanent") return 0;
  return Math.round(baseWage * 0.05);
}

// ════════════════════════════════════════════════════════════
// 6. calcOneEmployee
// ════════════════════════════════════════════════════════════
export function calcOneEmployee(emp, empLogs, empLeaves, empDeductions, daysInMonth) {
  const dailyRate  = getDailyRate(emp, daysInMonth);
  const hourlyRate = dailyRate / 8;

  const workLogs     = empLogs.filter(l => !l.needs_hr_review || l.late_minutes >= 0);
  const sundayLogs   = workLogs.filter(l => new Date(l.work_date).getDay() === 0);
  const normalLogs   = workLogs.filter(l => new Date(l.work_date).getDay() !== 0);

  const work_days    = normalLogs.length;
  const holiday_days = sundayLogs.length;

  const base_wage          = Math.round(dailyRate * work_days * 100) / 100;
  const holiday_wage       = Math.round(dailyRate * holiday_days * 100) / 100;
  const ot_hours           = empLogs.reduce((s, l) => s + (l.ot_hours || 0), 0);
  const ot_amount          = Math.round(hourlyRate * ot_hours * 100) / 100;
  const position_allowance = emp.position_allowance || 0;
  const totalLateMin       = empLogs.reduce((s, l) => s + (l.late_minutes || 0), 0);
  const hasLeave           = empLeaves.length > 0;
  const diligence_bonus    = calcDiligenceBonus(totalLateMin, hasLeave);

  const total_income = Math.round(
    (base_wage + holiday_wage + ot_amount + position_allowance + diligence_bonus) * 100
  ) / 100;

  const late_deduct      = calcLateDeduct(empLogs, hourlyRate);
  const social_security  = calcSocialSecurity(emp, base_wage);
  const job_insurance    = emp.insurance_level === "200" ? 200
    : emp.insurance_level === "500" ? 500 : 0;
  const leave_deduct     = 0;

  // ✅ รวม deductions จาก DB แยกตามประเภท
  const deductByType = (keyword) =>
    empDeductions
      .filter(d => d.deduction_types?.name?.includes(keyword))
      .reduce((s, d) => s + Number(d.amount), 0);

  const advance_total = Math.round(deductByType("แม็กโคร") * 100) / 100;
  const loan_deduct   = Math.round(
    (deductByType("กู้ยืม") + deductByType("กศน")) * 100
  ) / 100;
  const other_deduct  = Math.round(
    empDeductions
      .filter(d => !d.deduction_types?.name?.includes("แม็กโคร")
                && !d.deduction_types?.name?.includes("กู้ยืม")
                && !d.deduction_types?.name?.includes("กศน"))
      .reduce((s, d) => s + Number(d.amount), 0) * 100
  ) / 100;

  const total_deduct = Math.round(
    (late_deduct + leave_deduct + social_security + job_insurance
     + advance_total + loan_deduct + other_deduct) * 100
  ) / 100;

  const net_pay = Math.floor(total_income - total_deduct);

  return {
    employee_id: emp.id, emp_code: emp.emp_code,
    nickname: emp.nickname, full_name: emp.full_name, emp_type: emp.emp_type,
    daily_rate: Math.round(dailyRate * 100) / 100,
    hourly_rate: Math.round(hourlyRate * 100) / 100,
    work_days, holiday_days,
    ot_hours: Math.round(ot_hours * 100) / 100,
    base_wage, holiday_wage, ot_amount, position_allowance, diligence_bonus, total_income,
    late_minutes: totalLateMin, late_deduct,
    leave_days: empLeaves.filter(l => l.unit === "day").length, leave_deduct,
    social_security, job_insurance,
    advance_total, loan_deduct, other_deduct,
    total_deduct, net_pay,
    has_review: empLogs.some(l => l.needs_hr_review),
    // ✅ เก็บรายการ deductions ดิบไว้แสดงใน modal
    deduction_items: empDeductions,
  };
}

// ════════════════════════════════════════════════════════════
// 7. calcPayroll
// ════════════════════════════════════════════════════════════
export async function calcPayroll(year, month) {
  const { employees, logs, leaves, deductions, daysInMonth } = await fetchPayrollInputs(year, month);

  const results = employees.map(emp => {
    const empLogs        = logs.filter(l => l.employee_id === emp.id);
    const empLeaves      = leaves.filter(l => l.employee_id === emp.id);
    const empDeductions  = deductions.filter(d => d.employee_id === emp.id);
    return calcOneEmployee(emp, empLogs, empLeaves, empDeductions, daysInMonth);
  });

  return {
    year, month, daysInMonth, results,
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
// 8. savePayrollResults
// ════════════════════════════════════════════════════════════
export async function savePayrollResults(year, month, results) {
  const { data: period } = await supabase
    .from("pay_periods").select("id")
    .eq("year", year).eq("month", month).single();

  const period_id = period?.id || null;

  const records = results.map(r => ({
    period_id, employee_id: r.employee_id,
    work_days: r.work_days, base_wage: r.base_wage,
    ot_hours: r.ot_hours, ot_amount: r.ot_amount,
    position_allowance: r.position_allowance, diligence_bonus: r.diligence_bonus,
    holiday_wage: r.holiday_wage, total_income: r.total_income,
    late_deduct: r.late_deduct, leave_deduct: r.leave_deduct,
    social_security: r.social_security, job_insurance: r.job_insurance,
    advance_total: r.advance_total, loan_deduct: r.loan_deduct,
    other_deduct: r.other_deduct, total_deduct: r.total_deduct,
    net_pay: r.net_pay, is_finalized: false,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("payroll_records")
    .upsert(records, { onConflict: "period_id,employee_id" });

  if (error) throw new Error("บันทึก payroll_records ไม่สำเร็จ: " + error.message);

  // ✅ mark deductions ที่ถูกหักแล้ว → is_paid = true
  const allDeductionIds = results.flatMap(r => r.deduction_items?.map(d => d.id) || []);
  if (allDeductionIds.length > 0) {
    await supabase.from("deductions")
      .update({ is_paid: true })
      .in("id", allDeductionIds);
  }

  return true;
}
