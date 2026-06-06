// attendanceLogic.js
// ── ตรรกะคำนวณเวลา + parse CSV จากเครื่อง ZKTeco — KMMH Payroll ──
// วางที่ src/lib/attendanceLogic.js
//
// ⚠️⚠️ กฎเวลาทั้งหมดอยู่ในไฟล์นี้ที่เดียว — แก้ตัวเลขตรงนี้ ระบบคำนวณใหม่ทั้งหมด
//        (ข้อมูลเวลาดิบที่ HR กรอก/import ไม่เปลี่ยน เก็บแยกใน DB)

// ════════════════════════════════════════════════════════════════
// กฎเวลา KMMH  ⚠️ รอ HR ยืนยันตัวเลขพักเที่ยงอีกที (4 มิ.ย.69)
// ════════════════════════════════════════════════════════════════
export const RULES = {
  STD_IN_MIN: 8 * 60,        // 08:00 เข้ามาตรฐาน (สาย = เข้าหลังเวลานี้)
  STD_OUT_MIN: 17 * 60,      // 17:00 เลิกงาน (ออกก่อน = หักเหมือนสาย)

  // เช้า — OT เข้าก่อนเวลา (เฉพาะพนักงานประจำ)
  OT_MORNING_EARLY_MIN: 6 * 60,        // 06:00
  OT_MORNING_MID_MIN:   6 * 60 + 30,   // 06:30
  OT_MORNING_LATE_MIN:  7 * 60,        // 07:00
  //   06:00-06:30 → +2 ชม. | 06:31-06:59 → +1 ชม. | 07:00-08:00 = ปกติ

  // พักเที่ยง — นับระยะจากออกจริงถึงกลับจริง
  LUNCH_LIMIT_MIN: 60,       // พักได้ 60 นาที (เกินจากนี้ = สาย)
  LUNCH_SHORT_MIN: 30,       // พัก < 30 นาที → OT +1 ชม. (รีบกลับมาทำงาน)

  // เย็น — OT เลิกช้า (ทุกคน)
  OT_EVENING_1_MIN: 17 * 60 + 30,  // 17:30 → +1 ชม.
  OT_EVENING_2_MIN: 18 * 60,       // 18:00 → +2 ชม.

  // ── 🆕 วันเสาร์ ──
  //   เสาร์ทำครึ่งวัน มีแค่สแกนเข้าเช้าจุดเดียว
  //   • สายเช้า → หักปกติ (1 บ/นาที)
  //   • เที่ยง + เลิกงาน → ไม่นับสาย / ไม่หัก (ข้ามทั้งหมด)
  //   • ค่าแรง → จ่ายเต็มวันเสมอ (จัดการในฝั่ง payrollCalc)
  SATURDAY_MORNING_OT: false,  // วันเสาร์ให้ OT เข้าก่อนเวลาไหม? (default ปิด)
};

// รายชื่อ emp_code ที่เป็นพนักงานประจำ (ได้ OT เช้า) — ที่เหลือ trial
// NOTE: ของจริงดึงจาก employees.emp_type — ตรงนี้ fallback เฉยๆ
export const PERMANENT_CODES = new Set([
  "K001","K002","K003","K004","K005","K006","K007",
  "K008","K009","K010","K011","K012","K013","K014",
]);

// ── ตารางจับคู่เลขเครื่อง → emp_code ──
// NOTE: ของจริง query จาก device_user_map — ตรงนี้ใช้ตอน parse ฝั่ง client
export const DEVICE_MAP = {
  "1":"K003","2":"K004","3":"K011","5":"K013","6":"K007","7":"K014",
  "8":"K008","9":"K018","10":"K017","11":"K016","12":"K009","13":"K005",
  "14":"K001","15":"K002","16":"K010","17":"K006","21":"K012","23":"K015",
};

// ════════════════════════════════════════════════════════════════
// Helpers เวลา
// ════════════════════════════════════════════════════════════════
export function timeToMins(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function minsToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fmtLate(mins) {
  if (!mins || mins <= 0) return null;
  if (mins < 60) return `${mins} น.`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}ชม.${m}น.` : `${h} ชม.`;
}

// เช็ควันเสาร์ จาก date string "YYYY-MM-DD"
export function isSaturday(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr).getDay() === 6;
}

// ════════════════════════════════════════════════════════════════
// คำนวณสาย/OT จาก 4 จุดสแกน
//   รับ { checkIn, lunchOut, lunchIn, checkOut, empCode, date }
//   คืน { lateMin, otHours, breakdown[] }
//   ถ้าจุดไหน null → ข้ามการคำนวณส่วนนั้น (ยังไม่ครบ ให้ HR เติม)
//
//   🆕 ถ้า date เป็นวันเสาร์ → คิดเฉพาะสายเช้า ข้ามเที่ยง+เย็นทั้งหมด
//      (จุดเรียก เช่น AttendancePage ต้องส่ง date ของวันนั้นเข้ามาด้วย)
// ════════════════════════════════════════════════════════════════
export function calcDay({ checkIn, lunchOut, lunchIn, checkOut, empCode, date }) {
  const R = RULES;
  const isPerm = PERMANENT_CODES.has(empCode);
  const isSat  = isSaturday(date);
  let lateMin = 0, otHours = 0;
  const breakdown = [];

  const ci = timeToMins(checkIn);
  const lo = timeToMins(lunchOut);
  const li = timeToMins(lunchIn);
  const co = timeToMins(checkOut);

  // ── เช้า ──
  if (ci !== null) {
    if (ci > R.STD_IN_MIN) {
      const m = ci - R.STD_IN_MIN;
      lateMin += m;
      breakdown.push({ type: "late", label: `เข้าสาย ${m} น.` });
    } else if ((!isSat || R.SATURDAY_MORNING_OT) && isPerm &&
               ci >= R.OT_MORNING_EARLY_MIN && ci <= R.OT_MORNING_MID_MIN) {
      otHours += 2;
      breakdown.push({ type: "ot", label: "เข้าก่อน 06:30 → OT +2" });
    } else if ((!isSat || R.SATURDAY_MORNING_OT) && isPerm &&
               ci > R.OT_MORNING_MID_MIN && ci < R.OT_MORNING_LATE_MIN) {
      otHours += 1;
      breakdown.push({ type: "ot", label: "เข้าก่อน 07:00 → OT +1" });
    }
  }

  // ── 🆕 วันเสาร์: หยุดแค่นี้ — คิดเฉพาะสายเช้า ไม่แตะเที่ยง/เย็น ──
  if (isSat) {
    if (ci !== null) breakdown.push({ type: "info", label: "วันเสาร์ — คิดเฉพาะสายเช้า" });
    return { lateMin, otHours, breakdown };
  }

  // ── พักเที่ยง ── (วันธรรมดา, ต้องมีทั้งออกและกลับ)
  if (lo !== null && li !== null) {
    const lunch = li - lo;
    if (lunch < R.LUNCH_SHORT_MIN) {
      otHours += 1;
      breakdown.push({ type: "ot", label: `พักสั้น ${lunch} น. → OT +1` });
    } else if (lunch > R.LUNCH_LIMIT_MIN) {
      const m = lunch - R.LUNCH_LIMIT_MIN;
      lateMin += m;
      breakdown.push({ type: "late", label: `พักเกิน ${m} น.` });
    }
  }

  // ── เย็น ── (วันธรรมดา)
  if (co !== null) {
    if (co >= R.OT_EVENING_2_MIN) {
      otHours += 2;
      breakdown.push({ type: "ot", label: "เลิก ≥ 18:00 → OT +2" });
    } else if (co >= R.OT_EVENING_1_MIN) {
      otHours += 1;
      breakdown.push({ type: "ot", label: "เลิก ≥ 17:30 → OT +1" });
    } else if (co < R.STD_OUT_MIN) {
      const m = R.STD_OUT_MIN - co;
      lateMin += m;
      breakdown.push({ type: "late", label: `เลิกก่อน 17:00 (${m} น.)` });
    }
  }

  return { lateMin, otHours, breakdown };
}

// ════════════════════════════════════════════════════════════════
// splitTimes — แยกเวลาหลายตัวในช่องเดียว + ลบตัวซ้ำ
//
// ⚠️ ไม่ sort() ที่นี่ — เก็บลำดับ export จาก ZKTeco ไว้
//    การ sort จะทำเฉพาะใน assignPunches กรณี 5+ punch เท่านั้น
// ════════════════════════════════════════════════════════════════
function splitTimes(s) {
  if (!s || !s.trim()) return [];
  const seen = new Set(), out = [];
  for (const p of s.trim().split(/\s+/)) {
    if (/^\d{1,2}:\d{2}$/.test(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out; // ❌ ไม่ sort — ลำดับสแกนสำคัญ
}

// แปลงวันที่ MM/DD/YYYY (ค.ศ.) → YYYY-MM-DD
function parseDate(s) {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

// ════════════════════════════════════════════════════════════════
// assignPunches — แปลง punches ดิบ → 4 จุดมาตรฐาน
//
// กลยุทธ์:
//   🆕 วันเสาร์ → สนใจแค่ "เข้าเช้า" (เวลาน้อยสุด) เป็นปกติ ไม่ flag
//   4 punches (ins=2, outs=2) → ปกติ assign ตรง ไม่ต้อง review
//   5+ punches (ZKTeco สแกนซ้ำ/เครื่องพัง) → dedupe+sort
//   < 4 punches → ใส่เท่าที่มี + flag 🟡
// ════════════════════════════════════════════════════════════════
function assignPunches(ins, outs, isSat = false) {
  const all = [...ins, ...outs];

  // ── 🆕 วันเสาร์: ครึ่งวัน มีแค่เข้าเช้า ──
  if (isSat) {
    if (all.length === 0) {
      return {
        checkIn: null, lunchOut: null, lunchIn: null, checkOut: null,
        needsReview: true,
        reason: "วันเสาร์ — ไม่สแกนเลย (ขาด/ลา?)",
      };
    }
    // เลือกเวลาน้อยสุด = เข้าเช้า ที่เหลือทิ้ง (เสาร์ไม่คิดเที่ยง/เย็น)
    const sorted = [...new Set(all)].sort();
    return {
      checkIn:  sorted[0],
      lunchOut: null, lunchIn: null, checkOut: null,
      needsReview: false,
      reason: "",
    };
  }

  // ── เคสปกติ: ins=2, outs=2 ──
  if (ins.length === 2 && outs.length === 2) {
    // ZKTeco format: เวลาเข้างาน = [เข้าเช้า, กลับพัก]
    //                เวลาออกงาน  = [ออกพัก,   เลิกงาน]
    return {
      checkIn:  ins[0],
      lunchOut: outs[0],
      lunchIn:  ins[1],
      checkOut: outs[1],
      needsReview: false,
      reason: "",
    };
  }

  // ── ไม่มีข้อมูลเลย ──
  if (all.length === 0) {
    return {
      checkIn: null, lunchOut: null, lunchIn: null, checkOut: null,
      needsReview: true,
      reason: "ไม่สแกนเลย (ขาด/ลา?)",
    };
  }

  // ── 5+ punch: ZKTeco export ผิด (สแกนซ้ำ/เครื่องค้าง) ──
  if (all.length >= 5) {
    const clean = [...new Set(all)].sort();

    if (clean.length === 4) {
      return {
        checkIn:  clean[0],
        lunchOut: clean[1],
        lunchIn:  clean[2],
        checkOut: clean[3],
        needsReview: true,
        reason: `ZKTime export ${all.length} punches (มี duplicate) — ระบบ dedupe+เรียงเวลาอัตโนมัติ กรุณายืนยัน`,
      };
    }

    return {
      checkIn:  clean[0],
      lunchOut: clean[1],
      lunchIn:  clean[clean.length - 2],
      checkOut: clean[clean.length - 1],
      needsReview: true,
      reason: `ZKTime export ${all.length} punches (${clean.length} unique) — ระบบเลือกอัตโนมัติ กรุณาตรวจ`,
    };
  }

  // ── < 4 punch: ใส่เท่าที่มี ──
  const result = {
    checkIn: null, lunchOut: null, lunchIn: null, checkOut: null,
    needsReview: true,
    reason: "",
  };

  if (ins.length === 2 && outs.length === 1) {
    result.checkIn = ins[0]; result.lunchOut = ins[1]; result.lunchIn = outs[0];
    result.reason = "ยังไม่สแกนออกเย็น";
  } else if (ins.length === 1 && outs.length === 1) {
    result.checkIn = ins[0]; result.lunchOut = outs[0];
    result.reason = "มีแค่เข้าเช้า + ออกเที่ยง";
  } else if (ins.length === 1 && outs.length === 0) {
    result.checkIn = ins[0];
    result.reason = "มีแค่เข้าเช้า";
  } else {
    if (ins[0])  result.checkIn  = ins[0];
    if (ins.length > 1) result.lunchOut = ins[ins.length - 1];
    if (outs[0]) result.lunchIn  = outs[0];
    if (outs.length > 1) result.checkOut = outs[outs.length - 1];
    result.reason = `สแกนผิดปกติ (เข้า ${ins.length}, ออก ${outs.length})`;
  }

  return result;
}

// ════════════════════════════════════════════════════════════════
// parseZKTecoCSV — Parse CSV จากเครื่อง ZKTeco
//   header: รหัสพนักงาน,ชื่อ,วันที่,เวลาเข้างาน,เวลาออกงาน
//   คืน { rows[], skipped[] }
//   rows: { date, deviceUid, deviceName, empCode,
//           checkIn, lunchOut, lunchIn, checkOut,
//           needsReview, reason }
// ════════════════════════════════════════════════════════════════
export function parseZKTecoCSV(text) {
  text = text.replace(/^\uFEFF/, ""); // ลบ BOM
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { rows: [], skipped: [] };

  const rows = [];
  const skipped = []; // เลขเครื่องที่ไม่มีใน map (คนลาออก/PC) → ข้าม

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const [devUid, devName, dateRaw, inS, outS] = cols.map(c => c.trim());

    const empCode = DEVICE_MAP[devUid];
    if (!empCode) {
      skipped.push({ devUid, devName });
      continue;
    }

    const date = parseDate(dateRaw);
    if (!date) continue;

    const ins  = splitTimes(inS);
    const outs = splitTimes(outS);
    const sat  = isSaturday(date);

    rows.push({
      date,
      deviceUid: devUid,
      deviceName: devName,
      empCode,
      ...assignPunches(ins, outs, sat),
    });
  }

  return { rows, skipped };
}
