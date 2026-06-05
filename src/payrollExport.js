// src/payrollExport.js
// ─────────────────────────────────────────────────────────────
// Export Excel สรุปเงินเดือน KMMH — ใช้ output จาก calcPayroll()
// ─────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";

const MONTHS_TH = ["","มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
  "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];

export async function exportPayrollExcel(payrollResult, yearBE, month) {
  const { results, summary, daysInMonth } = payrollResult;
  const monthName = MONTHS_TH[month];
  const wb = XLSX.utils.book_new();

  // ════════════════════════════════════════════════════════
  // Sheet 1: เงินเดือน (main)
  // ════════════════════════════════════════════════════════
  const wsData = [];

  wsData.push(["ปี", yearBE, "เดือน", monthName, "จำนวน", daysInMonth, "วัน",
    "รอบเงินเดือน", null, `1-${daysInMonth} ${monthName}`, null,
    "วันที่ชำระ", null, null, null, null]);

  wsData.push(["ลำดับ","ชื่อเล่น","ชื่อ-สกุล",null,
    "เงินเดือน","ค่าแรง/วัน","ค่าแรง/ชม.",
    "วันทำงาน","OT(ชม.)","เงินประจำตำแหน่ง","เบี้ยขยัน",
    "สาย(น.)","ลา/ขาด(วัน)","ลา/ขาด(บาท)","ประกันงาน","เบิกเงิน","ค่างวดต่างๆ","ปกส.",
    "ค่าแรง","OT","เงินประจำตำแหน่ง","เบี้ยขยัน",
    "รวมรายได้","รวมรายหัก","รวมค่าแรงสุทธิ","หมายเหตุ"]);

  wsData.push([null,"ชื่อเล่น",null,null,null,null,null,
    "วันทำงาน","OT(ชม.)","เงินประจำตำแหน่ง","เบี้ยขยัน",
    "สาย(น.)","ลา/ขาด(วัน)","ลา/ขาด(บาท)","ประกันงาน","เบิกเงิน","ค่างวดต่างๆ","ปกส.",
    "วันทำงาน","OT(ชม.)","เงินประจำตำแหน่ง","เบี้ยขยัน",
    "รายได้ทั้งหมด","รายจ่ายทั้งหมด",null,null]);

  results.forEach((r, i) => {
    wsData.push([
      i + 1,
      r.nickname,
      r.full_name,
      null,
      // ✅ monthly_salary ตรงๆ ไม่คำนวณใหม่
      r.emp_type === "permanent" ? r.monthly_salary : null,
      parseFloat(r.daily_rate.toFixed(2)),
      parseFloat(r.hourly_rate.toFixed(2)),
      r.work_days,
      r.ot_hours,
      r.position_allowance,
      r.diligence_bonus,
      r.late_minutes,
      r.leave_days,
      r.leave_deduct,
      r.job_insurance,
      r.advance_total,
      // ✅ other_deduct รวม loan
      parseFloat((r.loan_deduct + r.other_deduct).toFixed(2)),
      parseFloat(r.social_security.toFixed(2)),
      parseFloat(r.base_wage.toFixed(2)),
      parseFloat(r.ot_amount.toFixed(2)),
      r.position_allowance,
      r.diligence_bonus,
      parseFloat(r.total_income.toFixed(2)),
      parseFloat(r.total_deduct.toFixed(2)),
      r.net_pay,
      r.has_review ? "⚠️ ข้อมูลบันทึกเวลายังต้องตรวจ" : "",
    ]);
  });

  // ✅ summary row — ไม่ hardcode 0
  wsData.push([
    null, "รวม", null, null, null, null, null,
    results.reduce((s,r) => s + r.work_days, 0),
    parseFloat(results.reduce((s,r) => s + r.ot_hours, 0).toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.position_allowance, 0).toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.diligence_bonus, 0).toFixed(2)),
    results.reduce((s,r) => s + r.late_minutes, 0),
    results.reduce((s,r) => s + r.leave_days, 0),
    parseFloat(results.reduce((s,r) => s + r.leave_deduct, 0).toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.job_insurance, 0).toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.advance_total, 0).toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.loan_deduct + r.other_deduct, 0).toFixed(2)),
    parseFloat(summary.total_ss.toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.base_wage, 0).toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.ot_amount, 0).toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.position_allowance, 0).toFixed(2)),
    parseFloat(results.reduce((s,r) => s + r.diligence_bonus, 0).toFixed(2)),
    parseFloat(summary.total_income.toFixed(2)),
    parseFloat(summary.total_deduct.toFixed(2)),
    summary.total_net_pay,
    null,
  ]);

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = [
    {wch:6},{wch:10},{wch:20},{wch:4},
    {wch:10},{wch:10},{wch:10},
    {wch:10},{wch:8},{wch:14},{wch:10},
    {wch:10},{wch:12},{wch:12},{wch:10},{wch:10},{wch:12},{wch:10},
    {wch:12},{wch:8},{wch:14},{wch:10},
    {wch:14},{wch:14},{wch:14},{wch:30},
  ];
  XLSX.utils.book_append_sheet(wb, ws, "เงินเดือน");

  // ════════════════════════════════════════════════════════
  // Sheet 2: สรุปรายจ่ายบริษัท
  // ════════════════════════════════════════════════════════
  const ws2Data = [
    [`สรุปรายจ่ายบริษัท — ${monthName} ${yearBE}`],
    [],
    ["รายการ", "จำนวน (บาท)"],
    ["ค่าแรงสุทธิรวม (จ่ายพนักงาน)", summary.total_net_pay],
    ["ประกันสังคม (ส่วนนายจ้าง 5%)", parseFloat(summary.total_ss.toFixed(2))],
    ["รวมทั้งสิ้น", summary.total_net_pay + summary.total_ss],
    [],
    ["จำนวนพนักงาน", summary.count + " คน"],
    ["พนักงานที่มีข้อมูลต้องตรวจ", summary.has_review_count + " คน"],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(ws2Data);
  ws2["!cols"] = [{wch:35},{wch:18}];
  XLSX.utils.book_append_sheet(wb, ws2, "สรุปรายจ่ายบริษัทฯ");

  // ════════════════════════════════════════════════════════
  // Sheet 3: ปกส.
  // ════════════════════════════════════════════════════════
  const ws3Data = [
    [`สรุปเงินเดือนพนักงาน ปกส. — ${monthName} ${yearBE}`],
    [],
    ["ชื่อเล่น","ชื่อ-สกุล","ประเภท","เงินเดือน/ฐาน","ปกส.ลูกจ้าง (5%)","ปกส.นายจ้าง (5%)","รวมส่ง"],
  ];
  results
    .filter(r => r.emp_type === "permanent")
    .forEach(r => {
      ws3Data.push([
        r.nickname, r.full_name, "ประจำ",
        parseFloat(r.base_wage.toFixed(2)),
        parseFloat(r.social_security.toFixed(2)),
        parseFloat(r.social_security.toFixed(2)),
        parseFloat((r.social_security * 2).toFixed(2)),
      ]);
    });

  const ss_total = results.reduce((s,r) => s + r.social_security, 0);
  ws3Data.push(["รวม", null, null, null,
    parseFloat(ss_total.toFixed(2)),
    parseFloat(ss_total.toFixed(2)),
    parseFloat((ss_total * 2).toFixed(2)),
  ]);

  const ws3 = XLSX.utils.aoa_to_sheet(ws3Data);
  ws3["!cols"] = [{wch:10},{wch:22},{wch:10},{wch:16},{wch:18},{wch:18},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws3, "สรุปเงินเดือนพนักงาน ปกส");

  const fileName = `เงินเดือน_${monthName}_${yearBE}.xlsx`;
  XLSX.writeFile(wb, fileName);
}
