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

// ════════════════════════════════════════════════════════════════
// คำนวณสาย/OT จาก 4 จุดสแกน
//   คืน { lateMin, otHours, breakdown[] }
//   ถ้าจุดไหน null → ข้ามการคำนวณส่วนนั้น (ยังไม่ครบ ให้ HR เติม)
// ════════════════════════════════════════════════════════════════
export function calcDay({ checkIn, lunchOut, lunchIn, checkOut, empCode }) {
  const R = RULES;
  const isPerm = PERMANENT_CODES.has(empCode);
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
    } else if (isPerm && ci >= R.OT_MORNING_EARLY_MIN && ci <= R.OT_MORNING_MID_MIN) {
      otHours += 2;
      breakdown.push({ type: "ot", label: "เข้าก่อน 06:30 → OT +2" });
    } else if (isPerm && ci > R.OT_MORNING_MID_MIN && ci < R.OT_MORNING_LATE_MIN) {
      otHours += 1;
      breakdown.push({ type: "ot", label: "เข้าก่อน 07:00 → OT +1" });
    }
  }

  // ── พักเที่ยง ── (ต้องมีทั้งออกและกลับ)
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

  // ── เย็น ──
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
// แยกเวลาหลายตัวในช่องเดียว ("07:53 13:49") + ลบตัวซ้ำ
//
// ⚠️ ไม่ sort() — เวลาต้องเรียงตามลำดับที่สแกนจริง
//    (ZKTeco export ลำดับสแกน ไม่ใช่เรียงตัวอักษร)
//    การ sort จะเกิดก็ต่อเมื่อ dedupe กรณี 5+ punch เท่านั้น
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
  // ❌ ไม่ sort() ที่นี่ — ลำดับสแกนสำคัญ
  return out;
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
//   4 punches (ins=2, outs=2) → ปกติ assign ตรง
//   < 4                       → ใส่เท่าที่จับได้ + needsReview
//   5+ punches                → ZKTeco export ผิด (สแกนซ้ำ/เครื่องพัง)
//     1. dedupe + sort เวลา
//     2. ถ้าเหลือ 4 → assign ปกติ + needsReview ให้ HR ยืนยัน
//     3. ถ้ายังเกิน 4 → เลือก [0][1][-2][-1] + needsReview
// ════════════════════════════════════════════════════════════════
function assignPunches(ins, outs) {
  const all = [...ins, ...outs];

  // เคสปกติ
  if (all.length === 4 && ins.length === 2 && outs.length === 2) {
    return {
      checkIn:  ins[0],
      lunchIn:  ins[1],
      lunchOut: outs[0],
      checkOut: outs[1],
      needsReview: false,
      reason: "",
    };
  }

  // ไม่มีข้อมูลเลย
  if (all.length === 0) {
    return {
      checkIn: null, lunchOut: null, lunchIn: null, checkOut: null,
      needsReview: true,
      reason: "ไม่สแกนเลย (ขาด/ลา?)",
    };
  }

  // 5+ punch → ZKTeco export ผิด
  if (all.length >= 5) {
    // dedupe ก่อน (12:01 อาจซ้ำระหว่าง ins กับ outs)
    // sort ได้ตรงนี้ เพราะเราไม่รู้ลำดับที่แน่นอนแล้ว
    const clean = [...new Set(all)].sort();

    if (clean.length === 4) {
      // หลัง dedupe เหลือพอดี 4 → assign ปกติ แต่ยัง flag ให้ HR ตรวจ
      return {
        checkIn:  clean[0],
        lunchIn:  clean[1],
        lunchOut: clean[2],
        checkOut: clean[3],
        needsReview: true,
        reason: `ZKTime export ${all.length} punches (มี duplicate) — ระบบ dedupe เหลือ 4 กรุณาตรวจ`,
      };
    }

    // ยังเกิน 4 แม้ dedupe → เลือก [0][1][-2][-1]
    return {
      checkIn:  clean[0],
      lunchIn:  clean[1],
      lunchOut: clean[clean.length - 2],
      checkOut: clean[clean.length - 1],
      needsReview: true,
      reason: `ZKTime export ${all.length} punches (${clean.length} unique) — ระบบเลือกอัตโนมัติ กรุณาตรวจ`,
    };
  }

  // < 4 punch — ใส่เท่าที่มี
  const result = {
    checkIn: null, lunchOut: null, lunchIn: null, checkOut: null,
    needsReview: true,
    reason: "",
  };

  if (ins.length === 2 && outs.length === 1) {
    result.checkIn = ins[0]; result.lunchIn = ins[1]; result.lunchOut = outs[0];
    result.reason = "ยังไม่สแกนออกเย็น";
  } else if (ins.length === 1 && outs.length === 1) {
    result.checkIn = ins[0]; result.lunchOut = outs[0];
    result.reason = "มีแค่เข้าเช้า + ออกเที่ยง";
  } else if (ins.length === 1 && outs.length === 0) {
    result.checkIn = ins[0];
    result.reason = "มีแค่เข้าเช้า";
  } else {
    if (ins[0])  result.checkIn  = ins[0];
    if (ins.length > 1) result.lunchIn = ins[ins.length - 1];
    if (outs[0]) result.lunchOut = outs[0];
    if (outs.length > 1) result.checkOut = outs[outs.length - 1];
    result.reason = `สแกนผิดปกติ (เข้า ${ins.length}, ออก ${outs.length})`;
  }

  return result;
}

// ════════════════════════════════════════════════════════════════
// Parse CSV จากเครื่อง (รูปแบบ 3.csv)
//   header: รหัสพนักงาน,ชื่อ,วันที่,เวลาเข้างาน,เวลาออกงาน
//   คืน array ของ { date, deviceUid, deviceName, empCode,
//                   checkIn, lunchOut, lunchIn, checkOut,
//                   needsReview, reason }
// ════════════════════════════════════════════════════════════════
export function parseZKTecoCSV(text) {
  // ลบ BOM
  text = text.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { rows: [], skipped: [] };

  const rows = [];
  const skipped = [];   // เลขเครื่องที่ไม่มีใน map (คนลาออก/PC) → ข้าม

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

    const assigned = assignPunches(ins, outs);

    rows.push({
      date,
      deviceUid: devUid,
      deviceName: devName,
      empCode,
      ...assigned,
    });
  }

  return { rows, skipped };
}
