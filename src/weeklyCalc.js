// src/weeklyCalc.js
// ─────────────────────────────────────────────────────────────
// ตัวคิดค่าแรงรอบเสาร์ (แยกออกจาก WeeklyPage.jsx 20 ต.ค. 69 เพื่อให้ทดสอบได้ — ผลเหมือนเดิมทุกบาท)
//
// 🆕 20 ต.ค. 69 หักคืนค่าแรงรอบก่อน
//   ใบรอบเสาร์ทำตอนสาย ๆ ของวันเสาร์ (ก่อนเลิกงาน) → วันเสาร์นั้นถูกจ่ายเต็มวันไปแล้ว
//   ถ้าบ่ายวันนั้นออกก่อน/ลา/สายหลังพักเที่ยง (HR แก้ทีหลัง) หรือ HR แก้วันอื่นในรอบนั้นย้อนหลัง
//   → คิดรอบนั้นใหม่ด้วยเวลาปัจจุบัน ถ้าได้น้อยกว่าที่จ่ายไป ส่วนต่างหักในรอบเสาร์ถัดไป
//   (เคสแรก: รอบ 17 ต.ค. 69 · โต้ง ออกกลางวัน · เนเน่ สายหลังพักเที่ยง 49 น.)
//   สิ้นเดือน = สุทธิ − ยอดที่จ่ายจริงทุกรอบเสาร์ จึงไม่หักซ้ำ
//   รอบสุดท้ายของเดือนไม่มีรอบเสาร์ถัดไป → สิ้นเดือนเก็บให้เอง (เหมือนเดิม)
//   ถ้าคิดใหม่แล้วได้มากกว่าที่จ่าย (จ่ายขาด) ไม่จ่ายเพิ่มที่นี่ → สิ้นเดือนจ่ายให้เอง (เหมือนเดิม)
// ─────────────────────────────────────────────────────────────
import { calcLateDeduction, midLeaveFactor } from "./payrollCalc";

// 🆕 v7.10 น้ำหนักวันทำงานต่อ 1 log ให้ตรงกับ payrollCalc (กันรอบเสาร์คิดวันเต็มแล้วหักสายซ้ำ)
//   ครึ่งวันทุกชนิด (ขาด/ลาป่วย/ลากิจครึ่งวัน) = มาทำงานจริงครึ่งวัน → จ่ายครึ่งที่มา 0.5
//   ขาดงานเต็มวัน=0 · ออกระหว่างวัน=ตามชั่วโมงจริง (midLeaveFactor) · อื่นๆ=1
//   หมายเหตุ: ครึ่งที่ใช้สิทธิ์ลา จ่ายที่สิ้นเดือนเอง (net − satTotal): ลาป่วย/ลากิจครึ่งวัน net=เต็มวัน
//   → เสาร์จ่าย 0.5 (ครึ่งที่มา) สิ้นเดือนจ่ายอีก 0.5 (ครึ่งสิทธิ์); ขาดงานครึ่งวัน net=0.5 → สิ้นเดือน 0
export function cycleDayWeight(l) {
  const note = l.hr_note || "";
  // 🔧 9 ต.ค. 69 วันหยุดบริษัท → รอบเสาร์ไม่จ่ายใครเลย (เจ้าของกำหนด: เงินวันหยุดจ่ายสิ้นเดือนเท่านั้น)
  //   ประจำ: payrollCalc นับเป็นวันจ่าย → สิ้นเดือน (สุทธิ − ยอดเสาร์) จ่ายให้เอง · ทดลองงาน: ไม่จ่ายทั้งเดือน (v7.16)
  if (/วันหยุดบริษัท/.test(note)) return 0;
  // 🆕 15 ต.ค.69 ลาครึ่งวันแต่ไม่ได้มาเลย ("… + ขาดครึ่งวัน") → ไม่มีครึ่งที่มาทำงาน รอบเสาร์ไม่จ่าย
  //   ครึ่งที่ใช้สิทธิ์ลา จ่ายสิ้นเดือนเอง (payrollCalc นับ 0.5 · สิ้นเดือน = สุทธิ − เสาร์)
  if (/ครึ่งวัน \+ ขาดครึ่งวัน/.test(note)) return 0;
  if (/ครึ่งวัน/.test(note)) return 0.5;   // ครึ่งวันทุกชนิด → จ่ายครึ่งที่มาทำงาน
  if (/ขาด/.test(note)) return 0;
  if (/ออกระหว่างวัน/.test(note)) return midLeaveFactor(l.scan_pm_out || l.scan_am_out, l.scan_am_out);
  return 1;
}

// log ไหนนับเป็นวันลงงานของรอบเสาร์ (เดิมอยู่ใน getLogsInCycle)
export function isCycleWorkLog(l) {
  if (new Date(l.work_date + "T00:00:00").getDay() === 0) return false;
  const n = l.hr_note || "";
  // 🆕 v5.5: "ครึ่งวัน" ทุกชนิด (ขาด/ลาป่วย/ลากิจครึ่งวัน) = มาทำงานจริงครึ่งวัน
  //   → ครึ่งที่มา จ่ายตามรอบรับ (cycleDayWeight คืน 0.5); ครึ่งสิทธิ์ลา จ่ายสิ้นเดือนเอง (net − satTotal)
  if (/ครึ่งวัน \+ ขาดครึ่งวัน/.test(n)) return false; // 🆕 15 ต.ค.69 ไม่ได้มาเลย → ไปคิดสิ้นเดือน
  if (/ครึ่งวัน/.test(n)) return true;
  // ขาด/ลาป่วย/ลากิจ (เต็มวัน) = ไม่มีวันลงงาน → ยกไปคิดรวมสิ้นเดือน
  return !/ขาด|ลาป่วย|ลากิจ/.test(n);
}

export function calcCycleWageForEmployee(record, logsInCycle, WTAG) {
  const nonSun = logsInCycle.filter(
    l => new Date(l.work_date + "T00:00:00").getDay() !== 0
  );
  const workDays = nonSun.reduce((s, l) => s + cycleDayWeight(l), 0);
  if (!workDays || !record.work_days) return { workDays: 0, wage: 0 };
  const dailyRate = record.base_wage / record.work_days;
  const hourlyRate = dailyRate / 8; const _emp = record.employees || {}; let _lateDed = 0; nonSun.forEach(l => { const _rate = (WTAG && WTAG[record.employee_id + "_" + l.work_date]) || ((_emp.probation && !/แจ้งล่วงหน้า/.test(l.hr_note || "")) ? 5 : 1); _lateDed += calcLateDeduction(l.late_minutes || 0, _rate, hourlyRate) + parseFloat(l.hr_extra_deduct || 0); }); const wage = Math.round(dailyRate * workDays - _lateDed);
  return { workDays: Math.round(workDays * 100) / 100, wage };
}

// 🆕 20 ต.ค. 69 ส่วนที่รอบเสาร์ก่อนจ่ายเกิน (คิดใหม่ด้วยเวลาปัจจุบัน เทียบกับใบที่อนุมัติแล้ว)
//   prevVoucher = ใบรอบเสาร์ก่อนหน้า (ต้องอนุมัติแล้ว = จ่ายเงินไปแล้ว) · คืน 0 ถ้าไม่ได้จ่ายเกิน
export function prevCycleOverpay(record, prevVoucher, prevLogs, WTAG) {
  if (!prevVoucher || prevVoucher.status !== "approved" || !Array.isArray(prevVoucher.lines)) return 0;
  const ln = prevVoucher.lines.find(x => x.employee_id === record.employee_id);
  if (!ln) return 0;
  const paidWage = Number(ln.wage || 0);
  const { wage } = calcCycleWageForEmployee(record, prevLogs.filter(isCycleWorkLog), WTAG);
  return Math.max(0, Math.round(paidWage - wage));
}
