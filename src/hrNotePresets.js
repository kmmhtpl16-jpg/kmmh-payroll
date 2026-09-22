import { calcDay, calcHalfDay } from "./attendanceLogic";

// src/hrNotePresets.js
// ── ปุ่ม preset หมายเหตุ HR (ย้ายออกจาก AttendancePage 22 ก.ย.69) ──
// ใช้ร่วมกัน 2 ที่: ฟอร์มแก้ไขของ HR + ฟอร์ม "ขอแก้ไข" / แถบอนุมัติของเจ้าของ
// fullDay: true = ไม่มาทำงานทั้งวัน (ลา/ขาด/วันหยุด) → กดแล้วบันทึกจบ ไม่ต้องกรอกเวลา
// fullDay: false = ยังมาทำงานจริง (ครึ่งวัน/ออกระหว่างวัน) → ต้องกรอกเวลาตามจริง
export const HR_NOTE_PRESETS = [
  // 🟢 จ่ายเต็มวัน — กดแล้วบันทึกได้เลย ไม่ต้องกรอกเวลา
  { label: "ลาป่วย", value: "ลาป่วย", fullDay: true, leaveType: "sick", cat: "paid" },
  { label: "ลากิจ", value: "ลากิจ", fullDay: true, leaveType: "personal", cat: "paid" },
  { label: "วันหยุด", value: "วันหยุดบริษัท", fullDay: true, cat: "paid" },
  // 🔵 ลาครึ่งวัน — กรอกครึ่งที่มาทำงาน แล้วบันทึก
  { label: "ลาป่วยครึ่งวัน", value: "ลาป่วยครึ่งวัน", fullDay: false, leaveType: "sick", half: true, cat: "half" },
  { label: "ลากิจครึ่งวัน", value: "ลากิจครึ่งวัน", fullDay: false, leaveType: "personal", half: true, cat: "half" },
  // 🔴 หักเงิน
  { label: "ขาดงาน", value: "ขาดงาน", fullDay: true, cat: "deduct" },
  { label: "ขาดงานครึ่งวัน", value: "ขาดงานครึ่งวัน", halfAbsent: true, cat: "deduct" },
  { label: "ออกระหว่างวัน", value: "ออกระหว่างวัน", fullDay: false, cat: "deduct" },
  // 🟠 อื่นๆ
  { label: "แจ้งสายล่วงหน้า", value: "แจ้งล่วงหน้า", fullDay: false, cat: "other" },
  { label: "ติดส่งสินค้า", value: "ติดส่งสินค้า", fullDay: false, deliveryDuty: true, cat: "other" },
  // 🔵 มาเช้า-กลับเช้า/เลื่อนกะทั้งวัน ทำครบวัน แต่ไม่อนุมัติ OT → คงเวลาสแกน บังคับ สาย=0 OT=0
  { label: "ทำงาน 1 วัน ไม่เอา OT/สาย", value: "ทำงาน 1 วัน (ไม่เอา OT/สาย)", fullDay: false, noOt: true, cat: "other" },
];

// กลุ่มปุ่ม (เรียงเป็นแถว/คอลัมน์ให้อ่านง่าย — สีเดียวกัน = ผลต่อเงินเหมือนกัน)
export const PRESET_GROUPS = [
  { key: "paid",   title: "🟢 ลา–จ่ายเต็มวัน",  hint: "กดแล้วกดบันทึกได้เลย ไม่ต้องกรอกเวลา" },
  { key: "half",   title: "🔵 ลาครึ่งวัน",       hint: "กรอกครึ่งที่มาทำงาน แล้วกดบันทึก (เช้า 08:00–12:00 · บ่าย 13:00–17:00 คิดสายให้)" },
  { key: "deduct", title: "🔴 หักเงิน",          hint: "ขาดงาน=หักเต็มวัน · ครึ่งวัน=หักครึ่ง + กรอกเวลาครึ่งที่มา (คิดสายให้) · ออกระหว่างวัน=ใส่ช่องหักเพิ่ม" },
  { key: "other",  title: "🟠 อื่นๆ",            hint: "" },
];

export const presetOf = (note) => HR_NOTE_PRESETS.find((p) => p.value === note) || null;

// ── น้ำหนักค่าแรงของวันนั้น (ตรงกับ payrollCalc v7.11) ──
//   ขาดงานเต็มวัน = ไม่นับวัน (0) · ขาดครึ่งวัน = 0.5 · ลาทุกชนิด/วันหยุด/วันทำงานปกติ = 1
//   ⚠️ "ออกระหว่างวัน" คิดตามชั่วโมงจริง — ประมาณไม่ได้จากโน้ตอย่างเดียว จึงคืน null (ไม่เดา)
export function dayWeightOfNote(note) {
  const n = String(note || "");
  if (/ออกระหว่างวัน/.test(n)) return null;
  if (/ขาดงานครึ่งวัน|ขาดครึ่งวัน/.test(n)) return 0.5;
  if (/ขาดงาน/.test(n)) return 0;
  return 1;
}

// เรตหักสายต่อนาที — ทัณฑ์บน (employees.probation) = 5 บ./นาที ยกเว้นวันที่โน้ต "แจ้งล่วงหน้า"
export const lateRateOf = (emp, note) =>
  (emp?.probation && !/แจ้งล่วงหน้า/.test(String(note || ""))) ? 5 : 1;

// ค่าแรง 1 วันของพนักงานคนนี้ (ประจำ = เงินเดือน ÷ วันในเดือนของวันที่นั้น · ทดลองงาน = ค่าแรงรายวัน)
export function dayRateOf(emp, workDate) {
  if (!emp) return 0;
  const monthly = Number(emp.monthly_salary) || 0;
  const daily = Number(emp.daily_rate) || 0;
  if (emp.emp_type === "permanent" && monthly > 0) {
    const [y, m] = String(workDate).split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate() || 30;
    return monthly / days;
  }
  return daily;
}

const baht = (n) =>
  (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString("th-TH", { maximumFractionDigits: 2 });

// ── ข้อความ "ผลกระทบต่อเงิน" ให้เจ้าของดูก่อนกดอนุมัติ ──
//   นับเฉพาะ 2 อย่างที่คำนวณตรงได้: ค่าแรงของวันนั้น + ค่าปรับสาย
//   เบี้ยขยัน/ปกส. ไม่รวม เพราะขึ้นกับทั้งเดือน — บอกไว้ในข้อความว่ายังไม่รวม
export function impactOf({ emp, workDate, oldNote, newNote, oldLate, newLate }) {
  const rate = dayRateOf(emp, workDate);
  const wOld = dayWeightOfNote(oldNote);
  const wNew = dayWeightOfNote(newNote);
  const parts = [];
  let total = 0;
  let unsure = false;

  if (wOld == null || wNew == null) {
    unsure = true;
  } else if (wOld !== wNew) {
    const d = (wNew - wOld) * rate;
    total += d;
    parts.push(`ค่าแรงวันนั้น ${wOld === 0 ? "ไม่จ่าย" : wOld === 0.5 ? "ครึ่งวัน" : "เต็มวัน"} → ${wNew === 0 ? "ไม่จ่าย" : wNew === 0.5 ? "ครึ่งวัน" : "เต็มวัน"} (${baht(d)} บ.)`);
  }

  const lo = Number(oldLate) || 0, ln = Number(newLate) || 0;
  if (lo !== ln) {
    const r = lateRateOf(emp, newNote);
    const d = (lo - ln) * r;
    total += d;
    parts.push(`ค่าปรับสาย ${lo} → ${ln} นาที (${baht(d)} บ.)`);
  }

  const hadLeaveOld = /ลาป่วย|ลากิจ|ขาดงาน/.test(String(oldNote || ""));
  const hadLeaveNew = /ลาป่วย|ลากิจ|ขาดงาน/.test(String(newNote || ""));
  if (hadLeaveOld && !hadLeaveNew) parts.push("ได้เบี้ยขยันคืน (ถ้าทั้งเดือนไม่มีวันลา/ขาดอื่น)");
  if (!hadLeaveOld && hadLeaveNew) parts.push("เบี้ยขยันเดือนนี้ถูกตัด");

  if (parts.length === 0) return "ไม่กระทบยอดเงิน";
  const head = unsure
    ? "⚠️ มี “ออกระหว่างวัน” — ค่าแรงคิดตามชั่วโมงจริง ประเมินล่วงหน้าไม่ได้"
    : `รวมประมาณ ${baht(total)} บาท`;
  return `${head} · ${parts.join(" · ")}`;
}

const TH_MONTHS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
export const dayLabelTH = (iso) => {
  if (!iso) return "-";
  const [, m, d] = String(iso).split("-");
  return `${Number(d)} ${TH_MONTHS[Number(m)]}`;
};


const to24h = (val) => {
  if (!val) return "";
  if (/^\d{2}:\d{2}$/.test(val)) return val;
  const [time, period] = String(val).split(" ");
  if (!period) return val;
  let [h, m] = time.split(":").map(Number);
  if (period.toUpperCase() === "PM" && h !== 12) h += 12;
  if (period.toUpperCase() === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};


// ── คำนวณค่าที่จะเขียนลง DB จาก "โน้ตใหม่ + เวลาที่กรอก" (กติกาเดียวกับปุ่มแก้ไขของ HR) ──
export function deriveFromNote({ note, times, empCode, workDate }) {
  const p = presetOf(note);
  const isFullDayAbsence = !!(p && p.fullDay);
  const isHalfAbsent = !!(p && p.halfAbsent);
  const isHalfDayLeave = !!(p && p.leaveType && p.half);
  const isDeliveryDuty = !!(p && p.deliveryDuty);
  const isNormalNoOt = !!(p && p.noOt);
  const isMidLeave = /ออกระหว่างวัน/.test(String(note || ""));

  const am_in = to24h(times.scan_am_in), am_out = to24h(times.scan_am_out);
  const pm_in = to24h(times.scan_pm_in), pm_out = to24h(times.scan_pm_out);

  const timeArgs = {
    checkIn: am_in || null, lunchOut: am_out || null,
    lunchIn: pm_in || null, checkOut: pm_out || null,
    empCode: empCode || "", date: workDate,
  };
  const isHalfDayAny = isHalfAbsent || isHalfDayLeave;
  const { lateMin, otHours } = isHalfDayAny ? calcHalfDay(timeArgs) : calcDay(timeArgs);

  const amInMin = (() => { const m = String(am_in || "").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1] * 60 + +m[2]) : null; })();
  const midLeaveLate = (isMidLeave && amInMin != null) ? Math.max(0, amInMin - 480) : 0;

  const amFilled = !!am_in && !!am_out;
  const pmFilled = !!pm_in && !!pm_out;
  const isDone = (amFilled && pmFilled) || isFullDayAbsence || isHalfAbsent ||
    (isHalfDayLeave && (amFilled || pmFilled)) || isDeliveryDuty || isNormalNoOt;

  return {
    clearTimes: isFullDayAbsence,
    lateMinutes: isFullDayAbsence ? 0 : (isNormalNoOt ? 0 : (isMidLeave ? midLeaveLate : lateMin)),
    otHours: isFullDayAbsence ? 0 : ((isNormalNoOt || isMidLeave) ? 0 : otHours),
    isDone,
    leaveType: p?.leaveType || null,
    leaveHalf: !!(p && p.half),
    needTimes: !isFullDayAbsence,
    times: { scan_am_in: am_in, scan_am_out: am_out, scan_pm_in: pm_in, scan_pm_out: pm_out },
  };
}

