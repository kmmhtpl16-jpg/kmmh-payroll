// src/payrollCalc.js
// ─────────────────────────────────────────────────────────────
// คำนวณเงินเดือน KMMH — v7.8
// Logic ตาม KMMH_payroll_logic_v2.md
//
// 🔧 v7.8 เปลี่ยนจาก v7.7:
//   • [ลาป่วย/ลากิจครึ่งวัน] จ่ายเต็ม 1 วัน (ทำงานครึ่งวัน + ใช้สิทธิ์ลาครึ่งวันที่ได้จ่าย)
//        แยกป่วย/กิจเพราะโควตาสิทธิ์คนละก้อน — ตัดโควตา 0.5 ที่ leave_requests (AttendancePage) ไม่ใช่ที่นี่
//   • [ขาดงานครึ่งวัน] นับ 0.5 วัน จ่ายครึ่ง (work_days += 0.5) — ต่างจากลาครึ่งวัน
//     เดิม v7.7 จ่ายเต็มวัน — เปลี่ยนตามนโยบายใหม่: work_days += 0.5, base += dayRate*0.5
//
// 🔧 v7.7 เปลี่ยนจาก v7.6:
//   • [วันอาทิตย์] ลาออกระหว่างเดือน → ตัดวันอาทิตย์หลังวันลาออกออก (countSundays รับ toDay)
//     เดิมจ่ายอาทิตย์ทั้งเดือน แม้ลาออกไปแล้ว (เคสโด้ ลาออก 17 → ได้แค่ 7,14)
//   • [กู้คืน] commit v7.6 (อัปจากไฟล์เก่า) เผลอลบ 3 ฟีเจอร์ — เอากลับ:
//     - ขาดงานไม่จ่าย (ตัด work_days)  - ทัณฑ์บนค่าสาย 5 บ./นาที  - ลาครึ่งวันจ่ายเต็ม
//
// 🔧 v7.5 เปลี่ยนจาก v7.4:
//   • [#9] export `calcLateDeduction` ออกมาเป็น single source of truth
//     ให้ WeeklySummaryPage (หน้ารอบจ่ายเสาร์) import ไปใช้แทนสูตรหักสายแบบย่อ
//     → หักสายวันเสาร์ตรงกับยอดสิ้นเดือนเป๊ะ (เดิมหน้าเสาร์คิด >60นาที = hourlyRate+1
//       และใช้เรต=1 ตายตัว ไม่อ่าน late_tags → จ่ายเกินวันเสาร์ แล้วโป๊ะสิ้นเดือน)
//     ไม่มีการเปลี่ยน logic การคำนวณใดๆ ในไฟล์นี้ แค่เปิด export ฟังก์ชันเดิม
//
// 🔧 v7.4 เปลี่ยนจาก v7.3:
//   • [#7] เบิกอ่านที่เดียว — advance_total คิดจาก deductions (ชนิดเบิก) ที่เดียว
//     เดิม v7.3: advance_total = Σ(advance_requests ในเดือน) + เบิกใน deductions
//        ปัญหา: เบิกในแอปจริงถูกคีย์ที่ DeductionsPage → ตาราง deductions เท่านั้น
//               ส่วน advance_requests ไม่มีฟอร์มไหนเขียนลงเลย → อ่าน 2 ที่ = เสี่ยงนับซ้ำเปล่าๆ
//        แก้ v7.4: ลบ query advance_requests + ตัวแปร empAdvances ทิ้ง
//               advance_total = เบิกใน deductions (deduct_advance) อย่างเดียว
//               → ตรงกับ AdvanceSummaryCard + WeeklyPage (เบิกมาจากแหล่งเดียวทั้งระบบ)
//        หมายเหตุ: ADVANCE_DEDUCTION_TYPE_ID ยังคงไว้ (ใช้แยกเบิกออกจาก other_deduct)
//
// 🔧 v7.3 เปลี่ยนจาก v7.2:
//   • [#5] employee query รวม "คนลาออกเดือนนี้" แม้ถูกปิด is_active แล้ว
//     → กันลืมคืนประกัน/ค่าสมัคร ถ้า HR กดปิดสถานะทันทีตอนลาออก
//   • [#8] isSunday parse วันที่แบบ local ให้ตรงกับ countSundays
//     (กัน UTC shift เพี้ยนวันถ้ารันใน timezone ติดลบ)
//
// 🔧 v7.2 เปลี่ยนจาก v7.1:
//   • [กอง1-1] เพิ่ม syncInsuranceRefund — ตอนลาออก ลง ledger เป็น entry 'refund'
//     (−ยอดคืน) ผูก period_id กันซ้ำ → กระปุกเหลือ 0 ตรง spec ข้อ 2.7
//   • [กอง1-2] exclMap ตัดเฉพาะรายการอัตโนมัติของงวดนี้ (deposit/refund)
//     ไม่ตัด withdraw → ถ้าเดือนลาออกมีเบิกประกัน จะคืนเงินถูก (ไม่คืนเกิน)
//   • [กอง1-3] savePayroll บันทึก insurance_refund / app_fee_refund / app_fee_deduct
//     ลง payroll_records ด้วย (เดิมเก็บแค่ยอดรวม → สลิปย้อนหลังไม่เห็นบรรทัดคืน)
//   • [กันเหนียวปี] รับ year ได้ทั้ง พ.ศ./ค.ศ. → แปลงเป็น ค.ศ. ก่อนนับวันอาทิตย์
//     และก่อน query วันที่ (work_date จากเครื่องสแกนเป็น ค.ศ.) กันค่าแรงอาทิตย์เพี้ยน
//
// 🔧 v7.1 เปลี่ยนจาก v7:
//   • แก้ insurance_refund ให้ตรง "ตัวเลือก A" (เดือนลาออกหักประกันต่อ → คืนทั้งก้อน)
//     เดิม v7: refund = ยอด ledger ทั้งหมด ณ ตอน calc
//        ปัญหา (1) ตอนกดคำนวณ deposit งวดนี้ยังไม่ถูกสร้าง → refund ขาดไป 1 เดือน
//                 (เคสโด้ คืนแค่ 400 แทนที่จะเป็น 600)
//             (2) ถ้า re-save แล้วคำนวณใหม่ deposit งวดนี้ถูกนับเข้า → refund เพี้ยน (นับซ้ำ)
//     แก้ v7.1: refund = ยอดกระปุก "ไม่รวมงวดนี้" + job_insurance ของเดือนนี้
//        → ได้ 600 ทันทีตั้งแต่ครั้งแรก และ re-save กี่ครั้งก็ได้ 600 เท่าเดิม (idempotent)
//
// 🔧 v7 เปลี่ยนจาก v6:
//   • แก้บั๊ก insurance_level map ผิด key — เดิม level_200/level_500
//     แต่ค่าจริงใน DB คือ '200'/'500' → ทุกคนหัก 0 มาตลอด
//     แก้เป็น { none:0, "200":200, "500":500 } → หักประกันถูกต้องแล้ว
//   • เพิ่ม syncInsuranceDeposit — ตอนกด "บันทึกลง DB" จะสร้าง
//     deposit ลง insurance_ledger ให้อัตโนมัติ (กระปุกโตเอง)
//     - กันซ้ำด้วย period_id: 1 คน 1 เดือน มี deposit ได้แค่ entry เดียว
//     - เฉพาะ permanent + insurance_level ≠ none เท่านั้น
//     - ถ้ามี deposit ของงวดนี้แล้ว → ข้าม (ไม่สร้างซ้ำ)
//
// 🔧 v6 เปลี่ยนจาก v5:
//   • รายได้ "อื่นๆ" (โบนัส/ค่าพาหนะ) บวกเข้า total_income → net_pay
//   • ดึงเฉพาะ income_type='other' (ไม่ดึง OT ซ้ำ)
//
// 🔧 v5 เปลี่ยนจาก v4:
//   • OT: ตอนกด "บันทึกลง DB" สร้าง/อัปเดตรายการ OT ลง extra_income_entries
//
// 🔧 v4 (เดิม):
//   • holiday_wage — นับอาทิตย์ทั้งเดือนจากปฏิทิน เฉพาะประจำ
//
// 🔧 v3 (เดิม):
//   • หน้าเงินเดือน = ยอดรวมทั้งเดือน, สิ้นเดือน = net_pay − เสาร์ทุกรอบ
// ─────────────────────────────────────────────────────────────

import { supabase } from "./supabaseClient";

// deduction_type_id ของ "เบิกเงินสด" — แยกออกจาก other_deduct ไปอยู่ใน advance_total
// 🔧 v7.4 [#7] เบิกอ่านจาก deductions ชนิดนี้ "ที่เดียว" (เลิกอ่าน advance_requests)
const ADVANCE_DEDUCTION_TYPE_ID = "eb37bbd8-3636-4c37-a4dc-59b04a03ac61";

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function isSunday(dateStr) {
  // 🔧 v7.3 [#8] parse แบบ local ให้ตรงกับ countSundays (กัน UTC shift ใน timezone ติดลบ)
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).getDay() === 0;
}

// นับวันอาทิตย์ในเดือนจากปฏิทิน (ตั้งแต่ fromDay ถึง toDay; default = สิ้นเดือน)
// 🔧 v7.7 — เพิ่ม toDay เพื่อตัดวันอาทิตย์หลังวันลาออก (ลาออกระหว่างเดือนไม่จ่ายอาทิตย์ที่ยังไม่ถึง)
function countSundays(year, month, fromDay = 1, toDay = null) {
  const lastDay = toDay || daysInMonth(year, month);
  let count = 0;
  for (let d = fromDay; d <= lastDay; d++) {
    if (new Date(year, month - 1, d).getDay() === 0) count++;
  }
  return count;
}

// หักสายรายวัน (logic v2)
// 🔧 v7.5 [#9] export ให้ WeeklySummaryPage ใช้ร่วม → หักสายเสาร์/สิ้นเดือนตรงกัน
export function calcLateDeduction(lateMin, ratePerMin, hourlyRate) {
  if (!lateMin || lateMin <= 0) return 0;
  const rate = ratePerMin || 1;
  if (lateMin <= 40) return lateMin * rate;
  if (lateMin <= 60) return hourlyRate;
  const fullHours = Math.floor(lateMin / 60);
  const remainder = lateMin % 60;
  return hourlyRate * fullHours + remainder * rate;
}

// เบี้ยขยัน — trial ไม่ได้เลย
function calcDiligenceBonus(totalLateMin, hasLeave, empType) {
  if (empType !== "permanent") return 0;
  if (hasLeave) return 0;
  if (totalLateMin > 5) return 0;
  if (totalLateMin >= 1) return 300;
  return 500;
}

// ปกส. 5% cap 875
function calcSocialSecurity(empType, base) {
  if (empType !== "permanent") return 0;
  return Math.min(parseFloat((base * 0.05).toFixed(2)), 875);
}

// 🔧 v7 — map insurance_level ให้ตรง enum จริงใน DB ('none'/'200'/'500')
function insuranceAmount(level) {
  const map = { none: 0, "200": 200, "500": 500 };
  return map[level] || 0;
}

// ════════════════════════════════════════════════════════════
// calcPayroll — entry point หลัก
// ════════════════════════════════════════════════════════════
export async function calcPayroll(year, month) {
  // 🔧 กันเหนียวปี — รับได้ทั้ง พ.ศ.(>2400) และ ค.ศ. แล้ว normalize เป็น ค.ศ.
  //   ใช้ ce กับ "วันที่จริง" ทุกที่ (นับวันอาทิตย์ + query work_date ที่เป็น ค.ศ.)
  //   ส่วนการค้นงวด (pay_periods.year) ยังใช้ year ตามที่เก็บใน DB
  const ce = year > 2400 ? year - 543 : year;
  const days = daysInMonth(ce, month);
  const dateFrom = `${ce}-${String(month).padStart(2,"0")}-01`;
  const dateTo   = `${ce}-${String(month).padStart(2,"0")}-${String(days).padStart(2,"0")}`;

  // ── ดึงพนักงาน active + คนที่ลาออกเดือนนี้ (แม้ถูกปิด is_active แล้ว) ──
  // 🔧 v7.3 [#5] กันลืมคืนประกัน/ค่าสมัคร: ถ้า HR ปิดสถานะทันทีตอนลาออก
  //   คนนั้นจะหลุดจาก query เดิม (is_active=true) → ไม่ได้คืนเงิน
  //   จึงดึงคนลาออกเดือนนี้มา merge เพิ่ม (กันซ้ำด้วย id)
  const { data: activeEmps, error: empErr } = await supabase
    .from("employees")
    .select("*")
    .eq("is_active", true)
    .order("emp_code");
  if (empErr) throw new Error("โหลดพนักงานไม่ได้: " + empErr.message);

  const { data: resignedEmps, error: resErr } = await supabase
    .from("employees")
    .select("*")
    .gte("resigned_date", dateFrom)
    .lte("resigned_date", dateTo);
  if (resErr) throw new Error("โหลดพนักงานลาออกไม่ได้: " + resErr.message);

  const empMap = new Map();
  (activeEmps   || []).forEach(e => empMap.set(e.id, e));
  (resignedEmps || []).forEach(e => empMap.set(e.id, e));  // ทับ/เพิ่ม คนลาออก
  const employees = [...empMap.values()]
    .sort((a, b) => String(a.emp_code).localeCompare(String(b.emp_code)));

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
    .from("deductions")
    .select("*, deduction_types(name)")
    .in("employee_id", empIds)
    .gte("deduct_date", dateFrom)
    .lte("deduct_date", dateTo);

  // 🔧 v7.4 [#7] เลิกดึง advance_requests — เบิกอ่านจาก deductions ที่เดียว (ดู advance_total ด้านล่าง)

  // ── ดึงรายได้ "อื่นๆ" จาก extra_income (โบนัส/ค่าพาหนะ ฯลฯ) ──
  const otherIncomeMap = {};
  const { data: period0 } = await supabase
    .from("pay_periods").select("id").eq("year", year).eq("month", month).maybeSingle();
  if (period0) {
    const { data: extraOther } = await supabase
      .from("extra_income_entries")
      .select("employee_id, amount")
      .eq("period_id", period0.id)
      .eq("income_type", "other");
    (extraOther || []).forEach(e => {
      otherIncomeMap[e.employee_id] = (otherIncomeMap[e.employee_id] || 0) + Number(e.amount || 0);
    });
  }

  // 🔧 v7.1 — ยอดกระปุกประกัน "ไม่รวมงวดนี้" (สำหรับ insurance_refund ตอนลาออก)
  //   ตัดรายการของงวดนี้ออก (period_id = งวดนี้) เพื่อกันนับ deposit เดือนนี้ซ้ำตอน re-save
  //   แล้วค่อยบวก job_insurance ของเดือนนี้กลับเข้าไปตอนคำนวณ refund (ดูด้านล่าง)
  const curPeriodId = period0?.id || null;
  const insBalanceExclMap = {};
  const { data: insLedger } = await supabase
    .from("insurance_ledger")
    .select("employee_id, amount, period_id, entry_type")
    .in("employee_id", empIds);
  (insLedger || []).forEach(r => {
    // 🔧 v7.2 [กอง1-2] ตัดเฉพาะรายการ "อัตโนมัติ" ของงวดนี้ (deposit/refund) เพื่อกันนับซ้ำตอน re-save
    //   แต่ยังนับ withdraw (เบิก) ของงวดนี้ → ถ้าเดือนลาออกมีเบิกประกัน จะคืนเงินถูก
    if (curPeriodId && r.period_id === curPeriodId &&
        (r.entry_type === "deposit" || r.entry_type === "refund")) return;
    insBalanceExclMap[r.employee_id] =
      (insBalanceExclMap[r.employee_id] || 0) + Number(r.amount || 0);
  });

  // ── คำนวณรายคน ──
  const results = [];

  for (const emp of employees) {
    const empLogs        = (logs       || []).filter(l => l.employee_id === emp.id);
    const empDeductions  = (deductions || []).filter(d => d.employee_id === emp.id);

    // rate ตั้งต้น
    const dailyTrial = parseFloat(emp.daily_rate) || 0;
    const dailyPerm  = emp.monthly_salary ? emp.monthly_salary / days : dailyTrial;
    const isPerm     = emp.emp_type === "permanent";

    // จุดตัดเข้าประจำกลางเดือน
    const permStart = emp.permanent_start_date;
    const permStartInMonth = permStart &&
      permStart >= dateFrom && permStart <= dateTo;

    let work_days    = 0;
    let ot_hours     = 0;
    let late_minutes = 0;
    let late_deduct  = 0;
    let perm_base    = 0;
    let trial_base   = 0;
    let has_review   = false;
    let has_leave    = false;
    let leave_days   = 0;   // 🆕 จำนวนวันลาครึ่งวัน (0.5 ต่อครั้ง)
    let leave_deduct = 0;   // 🆕 หักค่าแรงครึ่งวันอัตโนมัติ

    for (const log of empLogs) {
      if (log.needs_hr_review) has_review = true;

      if (isSunday(log.work_date)) continue;

      // 🆕 ขาดงานครึ่งวัน → หักครึ่งค่าแรง (นับ 0.5 วัน) — ต้องเช็คก่อน /ขาด/ เต็มวัน
      const isHalfAbsent = log.hr_note && /ขาดงานครึ่งวัน|ขาดครึ่งวัน/.test(log.hr_note);
      // 🆕 ขาดงาน(เต็มวัน) → ไม่นับวันทำ + ไม่จ่ายค่าแรงวันนั้น (ตัดวันออกเหมือนข้ามอาทิตย์) แต่ยังตัดเบี้ยขยัน
      if (!isHalfAbsent && log.hr_note && /ขาด/.test(log.hr_note)) { has_leave = true; continue; }

      const usePerm    = isPerm && (!permStartInMonth || log.work_date >= permStart);
      const dayRate    = usePerm ? dailyPerm : dailyTrial;
      const hourlyRate = dayRate / 8;

      // ครึ่งวันที่ "หักค่าแรง" = ขาดงานครึ่งวันเท่านั้น → นับ 0.5 วัน จ่ายครึ่ง
      //   ⚠️ ลาป่วย/ลากิจครึ่งวัน = จ่ายเต็ม 1 วัน (ทำงานครึ่ง+สิทธิ์ลาครึ่ง) ไม่เข้าเงื่อนไขนี้
      const isHalfDay = isHalfAbsent;
      const dayFactor = isHalfDay ? 0.5 : 1;

      work_days += dayFactor;

      if (usePerm) perm_base  += dayRate * dayFactor;
      else         trial_base += dayRate * dayFactor;

      const lateMin = log.late_minutes || 0;
      late_minutes += lateMin;
      const rateTag = lateTagMap[`${emp.id}_${log.work_date}`] || ((emp.probation && !/แจ้งล่วงหน้า/.test(log.hr_note||'')) ? 5 : 1);
      late_deduct  += calcLateDeduction(lateMin, rateTag, hourlyRate);

      ot_hours += parseFloat(log.ot_hours || 0);

      late_deduct += parseFloat(log.hr_extra_deduct || 0);

      if (log.hr_note && /ลาครึ่งวัน/.test(log.hr_note)) leave_days += 0.5; // นับเฉพาะ "ลา" จริง (ไม่นับขาดงานครึ่งวัน)
      if (log.hr_note && /ลา|ขาด/.test(log.hr_note)) has_leave = true;
    }

    const base_wage   = parseFloat((trial_base + perm_base).toFixed(2));
    const daily_rate  = parseFloat(dailyPerm.toFixed(2));
    const hourly_rate = parseFloat((daily_rate / 8).toFixed(2));

    // ── ค่าแรงวันอาทิตย์ (v4) ──
    // 🔧 v7.7 — ลาออกระหว่างเดือน: ตัดวันอาทิตย์หลังวันลาออกออก (จ่ายเฉพาะอาทิตย์ที่ยังทำงานอยู่)
    const resignDateH = (emp.resigned_date || "").slice(0, 10);
    const isResigningThisMonthH = resignDateH >= dateFrom && resignDateH <= dateTo;
    let holiday_days = 0;
    let holiday_wage = 0;
    if (isPerm) {
      const fromDay = permStartInMonth
        ? parseInt(permStart.slice(8, 10), 10)
        : 1;
      const toDay = isResigningThisMonthH
        ? parseInt(resignDateH.slice(8, 10), 10)
        : null;
      holiday_days = countSundays(ce, month, fromDay, toDay);
      holiday_wage = parseFloat((dailyPerm * holiday_days).toFixed(2));
    }

    const ot_amount = parseFloat((hourly_rate * ot_hours).toFixed(2));

    const position_allowance = parseFloat(emp.position_allowance || 0);
    const diligence_bonus    = calcDiligenceBonus(late_minutes, has_leave, emp.emp_type);

    // app_fee (ค่าสมัคร 100 บาท)
    const trialStart = (emp.trial_start_date || "").slice(0, 10);
    const resignDate = (emp.resigned_date    || "").slice(0, 10);
    const isFirstMonth         = trialStart >= dateFrom && trialStart <= dateTo;
    const isResigningThisMonth = resignDate  >= dateFrom && resignDate  <= dateTo;
    const app_fee_deduct = (isFirstMonth && emp.app_fee_status === "none") ? 100 : 0;
    const app_fee_refund = (isResigningThisMonth && emp.app_fee_status === "held") ? 100 : 0;

    // ปกส. — ใช้ monthly_salary เป็นฐาน
    const ss_base         = permStartInMonth ? perm_base : (emp.monthly_salary || base_wage);
    const social_security = calcSocialSecurity(emp.emp_type, ss_base);

    // 🔧 v7.6 — ประกันงาน: เดือนที่ลาออก "ไม่หัก" (ไม่ฝากเข้ากระปุก)
    //   เดิม v7.1 ใช้ตัวเลือก A (เดือนลาออกหักต่อ แล้วคืนทั้งก้อน) → สุทธิเท่ากัน
    //   แต่ทำให้กระปุก/ยอดคืนโป่งขึ้น 1 เดือน (เคสโด้ โชว์ 600 แทน 400)
    //   เปลี่ยนเป็น: ลาออกเดือนนี้ → job_insurance = 0 (ไม่หัก ไม่ฝาก) → กระปุกตรง
    const job_insurance = (isPerm && !isResigningThisMonth)
      ? insuranceAmount(emp.insurance_level) : 0;

    // 🔧 v7.6 — insurance_refund: ลาออกเดือนนี้ → คืนยอดกระปุก "ไม่รวมงวดนี้"
    //   = insBalanceExclMap + job_insurance(=0 เพราะเดือนลาออกไม่หัก)
    //   → คืนเฉพาะที่สะสมจริง ไม่รวมเดือนลาออก (เคสโด้ = 400)
    //   • idempotent ผ่าน exclMap: ถ้าคืนผ่านปุ่ม (refund period_id=null) ไปแล้ว
    //     exclMap จะนับ refund นั้น → insurance_refund = 0 (กันคืนซ้ำ)
    const insurance_refund = isResigningThisMonth
      ? parseFloat(((insBalanceExclMap[emp.id] || 0) + job_insurance).toFixed(2))
      : 0;

    // รายจ่าย
    const other_deduct   = empDeductions
      .filter(d => d.deduction_type_id !== ADVANCE_DEDUCTION_TYPE_ID)
      .reduce((s, d) => s + parseFloat(d.amount || 0), 0);
    const deduct_advance = empDeductions
      .filter(d => d.deduction_type_id === ADVANCE_DEDUCTION_TYPE_ID)
      .reduce((s, d) => s + parseFloat(d.amount || 0), 0);
    const loan_deduct    = 0;
    // 🔧 v7.4 [#7] เบิกอ่านที่เดียว — มาจาก deductions ชนิดเบิก (deduct_advance) เท่านั้น
    const advance_total  = parseFloat(deduct_advance.toFixed(2));

    const other_income = parseFloat((otherIncomeMap[emp.id] || 0).toFixed(2));

    const total_income = parseFloat((
      base_wage + holiday_wage + ot_amount + position_allowance +
      diligence_bonus + other_income + app_fee_refund + insurance_refund
    ).toFixed(2));

    const total_deduct = parseFloat((
      late_deduct + leave_deduct + social_security + job_insurance +
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
      insurance_level:   emp.insurance_level,   // 🔧 v7 — ส่งต่อให้ savePayroll ใช้ sync deposit
      resigned_date:     resignDate || null,     // 🔧 v7.2 — ใช้เป็น entry_date ของ refund ประกัน
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
      other_income,
      late_minutes,
      late_deduct:       parseFloat(late_deduct.toFixed(2)),
      leave_days:        parseFloat(leave_days.toFixed(2)),
      leave_deduct:      parseFloat(leave_deduct.toFixed(2)),
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

// ════════════════════════════════════════════════════════════
// savePayrollResults — บันทึกลง payroll_records
//   + sync OT เข้า extra_income_entries (v5)
//   + sync deposit ประกันงานเข้า insurance_ledger (v7)
// คืน { ot: {...}, insurance: {...} }
// ════════════════════════════════════════════════════════════
export async function savePayrollResults(year, month, results) {
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
    other_income:       r.other_income,
    late_deduct:        r.late_deduct,
    leave_deduct:       r.leave_deduct,
    social_security:    r.social_security,
    job_insurance:      r.job_insurance,
    app_fee_deduct:     r.app_fee_deduct,    // 🔧 v7.2 [กอง1-3]
    app_fee_refund:     r.app_fee_refund,    // 🔧 v7.2 [กอง1-3]
    insurance_refund:   r.insurance_refund,  // 🔧 v7.2 [กอง1-3]
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

  // ── sync OT → extra_income_entries ──
  const ot = await syncOtExtraIncome(period.id, results);

  // 🔧 v7 — sync deposit ประกันงาน → insurance_ledger (entry_date เป็น ค.ศ.)
  const ce = year > 2400 ? year - 543 : year;
  const insuranceDeposit = await syncInsuranceDeposit(period.id, ce, month, results);

  // 🔧 v7.2 [กอง1-1] — sync refund ประกันงาน (คนลาออก) → ledger ให้กระปุกเหลือ 0
  const insuranceRefund = await syncInsuranceRefund(period.id, ce, month, results);

  return {
    ot,
    insurance: insuranceDeposit,
    insuranceRefund,
  };
}

// ════════════════════════════════════════════════════════════
// syncInsuranceDeposit (v7) — สร้าง deposit ประกันงานลง insurance_ledger
//   • เฉพาะ permanent + job_insurance > 0
//   • กันซ้ำด้วย period_id: ถ้ามี deposit ของงวดนี้แล้ว → ข้าม
//   • entry_date = วันที่ 1 ของเดือนงวดนั้น
// ════════════════════════════════════════════════════════════
async function syncInsuranceDeposit(periodId, year, month, results) {
  // โหลด deposit ที่มีอยู่แล้วในงวดนี้ (กันซ้ำ)
  const { data: existing, error: exErr } = await supabase
    .from("insurance_ledger")
    .select("employee_id")
    .eq("period_id", periodId)
    .eq("entry_type", "deposit");
  if (exErr) throw new Error("โหลด deposit ประกันงานไม่ได้: " + exErr.message);

  const alreadyHas = new Set((existing || []).map(e => e.employee_id));

  const entryDate = `${year}-${String(month).padStart(2,"0")}-01`;
  const toInsert = [];

  for (const r of results) {
    const amt = Number(r.job_insurance || 0);
    if (amt <= 0) continue;                  // ไม่หักประกัน → ข้าม
    if (alreadyHas.has(r.employee_id)) continue;  // มี deposit งวดนี้แล้ว → ข้าม

    toInsert.push({
      employee_id: r.employee_id,
      entry_date:  entryDate,
      entry_type:  "deposit",
      amount:      amt,
      period_id:   periodId,
      note:        `หักประกันงาน (อัตโนมัติจากเงินเดือน)`,
    });
  }

  if (toInsert.length) {
    const { error } = await supabase.from("insurance_ledger").insert(toInsert);
    if (error) throw new Error("สร้าง deposit ประกันงานไม่สำเร็จ: " + error.message);
  }

  return { created: toInsert.length, skipped: results.length - toInsert.length };
}

// ════════════════════════════════════════════════════════════
// syncInsuranceRefund (v7.2) — ตอนลาออก ลง ledger เป็น 'refund' (−ยอดคืน)
//   • เฉพาะคนที่มี insurance_refund > 0 (= ลาออกเดือนนี้ + มีกระปุก)
//   • กันซ้ำด้วย period_id + entry_type='refund': มีแล้ว → ข้าม
//   • amount เป็นค่าลบ (จ่ายออกจากกระปุก) → SUM(amount) ของคนนั้นเหลือ 0
//   • entry_date = วันลาออกจริง (fallback = วันที่ 1 ของเดือน, ค.ศ.)
// ════════════════════════════════════════════════════════════
async function syncInsuranceRefund(periodId, ceYear, month, results) {
  const { data: existing, error: exErr } = await supabase
    .from("insurance_ledger")
    .select("employee_id")
    .eq("period_id", periodId)
    .eq("entry_type", "refund");
  if (exErr) throw new Error("โหลด refund ประกันงานไม่ได้: " + exErr.message);

  const alreadyHas = new Set((existing || []).map(e => e.employee_id));
  const fallbackDate = `${ceYear}-${String(month).padStart(2,"0")}-01`;
  const toInsert = [];

  for (const r of results) {
    const amt = Number(r.insurance_refund || 0);
    if (amt <= 0) continue;                       // ไม่มียอดคืน → ข้าม
    if (alreadyHas.has(r.employee_id)) continue;  // มี refund งวดนี้แล้ว → ข้าม

    toInsert.push({
      employee_id: r.employee_id,
      entry_date:  r.resigned_date || fallbackDate,
      entry_type:  "refund",
      amount:      -amt,                          // ลบ = จ่ายออกจากกระปุก
      method:      "cash",
      period_id:   periodId,
      note:        "คืนประกันงานตอนลาออก (อัตโนมัติจากเงินเดือน)",
    });
  }

  if (toInsert.length) {
    const { error } = await supabase.from("insurance_ledger").insert(toInsert);
    if (error) throw new Error("สร้าง refund ประกันงานไม่สำเร็จ: " + error.message);
  }

  return { created: toInsert.length };
}

// ════════════════════════════════════════════════════════════
// syncOtExtraIncome — สร้าง/อัปเดต/ลบ รายการ OT ใน extra_income_entries
// ════════════════════════════════════════════════════════════
async function syncOtExtraIncome(periodId, results) {
  const { data: existing, error: exErr } = await supabase
    .from("extra_income_entries")
    .select("id, employee_id, is_overridden")
    .eq("period_id", periodId)
    .eq("income_type", "ot");
  if (exErr) throw new Error("โหลดรายการ OT (รายได้พิเศษ) ไม่ได้: " + exErr.message);

  const existMap = {};
  (existing || []).forEach(e => {
    if (!existMap[e.employee_id]) existMap[e.employee_id] = e;
  });

  let createdBy = null;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    createdBy = user?.id || null;
  } catch (_) { /* ไม่มี user ก็ปล่อย null */ }

  const toInsert = [];
  const toUpdate = [];
  const toDelete = [];

  for (const r of results) {
    const otAmount = Number(r.ot_amount || 0);
    const note = `${r.ot_hours} ชม.`;
    const cur = existMap[r.employee_id];

    if (otAmount > 0) {
      if (!cur) {
        toInsert.push({
          employee_id:     r.employee_id,
          period_id:       periodId,
          income_type:     "ot",
          label:           null,
          amount:          otAmount,
          amount_note:     note,
          disburse_on:     "month_end",
          cycle_id:        null,
          is_overridden:   false,
          override_reason: null,
          created_by:      createdBy,
          updated_at:      new Date().toISOString(),
        });
      } else if (!cur.is_overridden) {
        toUpdate.push({ id: cur.id, amount: otAmount, note });
      }
    } else {
      if (cur && !cur.is_overridden) toDelete.push(cur.id);
    }
  }

  if (toInsert.length) {
    const { error } = await supabase.from("extra_income_entries").insert(toInsert);
    if (error) throw new Error("สร้างรายการ OT ไม่สำเร็จ: " + error.message);
  }
  for (const u of toUpdate) {
    const { error } = await supabase
      .from("extra_income_entries")
      .update({ amount: u.amount, amount_note: u.note, updated_at: new Date().toISOString() })
      .eq("id", u.id);
    if (error) throw new Error("อัปเดตรายการ OT ไม่สำเร็จ: " + error.message);
  }
  if (toDelete.length) {
    const { error } = await supabase
      .from("extra_income_entries")
      .delete()
      .in("id", toDelete);
    if (error) throw new Error("ลบรายการ OT ที่เป็น 0 ไม่สำเร็จ: " + error.message);
  }

  return { created: toInsert.length, updated: toUpdate.length, removed: toDelete.length };
}
