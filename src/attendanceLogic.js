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
  // • เติมเที่ยง/เย็นทีหลังได้ → คิดสาย/OT บ่ายเหมือนวันธรรมดา หักสิ้นเดือน (เงินเสาร์จ่ายเช้าไปก่อน)
  //   • ค่าแรง → จ่ายเต็มวันเสมอ (จัดการในฝั่ง payrollCalc)
  SATURDAY_MORNING_OT: true,   // วันเสาร์ให้ OT เข้าก่อนเวลา (เข้าก่อน 07:00 ได้ OT) — OT จ่ายสิ้นเดือน

  // ── 🆕 วันครึ่งวัน (ขาดงานครึ่งวัน / ลาป่วย-ลากิจครึ่งวัน) ──
  //   ครึ่งเช้า = 08:00–12:00 · ครึ่งบ่าย = 13:00–17:00
  //   คิดสายเฉพาะ "ครึ่งที่มาทำงานจริง" (ครึ่งที่ขาด/ลา ไม่คิดสาย)
  HALF_AM_OUT_MIN: 12 * 60,   // ครึ่งเช้าเลิก 12:00 (ออกก่อน = หักเหมือนสาย)
  HALF_PM_IN_MIN:  13 * 60,   // ครึ่งบ่ายเริ่ม 13:00 (เข้าหลัง = สาย)
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
  "14":"K001","15":"K002","16":"K010","17":"K006","19":"K019","21":"K012","23":"K015",
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
// ════════════════════════════════════════════════════════════════
// 🆕 29 ส.ค.69 — OT เย็น (เจ้าของเคาะ)
//   เดิม: 17:30 = 1 · 18:00 = 2 แล้ว **ตันที่ 2 ตลอดกาล**
//         → คนกลับ 22:00 ได้เท่าคนกลับ 18:00 (เคสจ๋า+แป๋ง 28 ส.ค. กลับ 19:40 ได้แค่ 2)
//   ใหม่: 17:30–17:59 = 1 (คงของเดิม ไม่มีใครเสียสิทธิ์)
//         ตั้งแต่ 18:00 = (เวลาที่เกิน 17:00 ปัดลงครึ่งชั่วโมง) + 1
//           18:00 → 1.0+1 = 2   (เท่าเดิม)
//           18:30 → 1.5+1 = 2.5
//           19:00 → 2.0+1 = 3
//           19:40 → 2.5+1 = 3.5  ← ยอดที่เจ้าของเคาะไว้
//           20:00 → 3.0+1 = 4
//           21:00 → 4.0+1 = 5
//   🔑 หน่วย OT = เท่าของค่าแรงรายชั่วโมงปกติ ไม่ใช่จำนวนชั่วโมงที่อยู่จริง
function eveningOtHours(co) {
  const R = RULES;
  if (co === null || co < R.OT_EVENING_1_MIN) return 0;
  if (co < R.OT_EVENING_2_MIN) return 1;                 // 17:30–17:59
  const over = (co - R.STD_OUT_MIN) / 60;                // ชม.ที่เกิน 17:00
  return Math.floor(over * 2) / 2 + 1;                   // ปัดลงครึ่งชั่วโมง + 1
}

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

  // 🆕 วันเสาร์: ไม่ตัดจบที่นี่แล้ว — falls through ไปคิดสาย/OT เที่ยง+เย็น เหมือนวันธรรมดา (สายบ่ายหักสิ้นเดือน)

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
    const _evOt = eveningOtHours(co);
    if (_evOt > 0) {
      otHours += _evOt;
      breakdown.push({ type: "ot", label: `เลิกงานเย็น → OT +${_evOt}` });
    } else if (co < R.STD_OUT_MIN) {
      const m = R.STD_OUT_MIN - co;
      lateMin += m;
      breakdown.push({ type: "late", label: `เลิกก่อน 17:00 (${m} น.)` });
    }
  }

  return { lateMin, otHours, breakdown };
}

// ════════════════════════════════════════════════════════════════
// 🆕 calcHalfDay — คิดสาย/OT ของวัน "ครึ่งวัน"
//   ใช้กับ ขาดงานครึ่งวัน / ลาป่วยครึ่งวัน / ลากิจครึ่งวัน
//   หลักการ: คิดสายเฉพาะ "ครึ่งที่มาทำงานจริง" — ครึ่งที่ขาด/ลา ไม่คิดสาย
//     • ครึ่งเช้า (มีเวลาในช่องเช้า) : เข้าหลัง 08:00 = สาย · ออกก่อน 12:00 = สาย
//     • ครึ่งบ่าย (มีเวลาในช่องบ่าย) : เข้าหลัง 13:00 = สาย · ออกก่อน 17:00 = สาย
//   ถ้ากรอกครบ 4 จุด = ทำงานเต็มวัน → ส่งต่อให้ calcDay คิดตามกฎเดิม
//   ⚠️ กฎเดิม (calcDay) ใช้ช่อง "พักออก" เป็นเวลาพักเที่ยง จึงไม่เคยหักคนที่
//      ออกก่อน 12:00 แล้วไม่กลับมาบ่าย — เคสดรีม 8 ส.ค.69 (ออก 11:46)
// ════════════════════════════════════════════════════════════════
export function calcHalfDay({ checkIn, lunchOut, lunchIn, checkOut, empCode, date }) {
  const R = RULES;

  const ci = timeToMins(checkIn);
  const lo = timeToMins(lunchOut);
  const li = timeToMins(lunchIn);
  const co = timeToMins(checkOut);

  // ครบ 4 จุด = มาทำงานเต็มวัน → ใช้กฎเดิม
  if (ci !== null && lo !== null && li !== null && co !== null) {
    return calcDay({ checkIn, lunchOut, lunchIn, checkOut, empCode, date });
  }

  const isPerm = PERMANENT_CODES.has(empCode);
  let lateMin = 0, otHours = 0;
  const breakdown = [];

  // ── ครึ่งเช้า 08:00–12:00 ──
  if (ci !== null || lo !== null) {
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
    if (lo !== null && lo < R.HALF_AM_OUT_MIN) {
      const m = R.HALF_AM_OUT_MIN - lo;
      lateMin += m;
      breakdown.push({ type: "late", label: `เลิกก่อน 12:00 (${m} น.)` });
    }
  }

  // ── ครึ่งบ่าย 13:00–17:00 ──
  if (li !== null || co !== null) {
    if (li !== null && li > R.HALF_PM_IN_MIN) {
      const m = li - R.HALF_PM_IN_MIN;
      lateMin += m;
      breakdown.push({ type: "late", label: `เข้าบ่ายสาย ${m} น.` });
    }
    if (co !== null) {
      const _evOt = eveningOtHours(co);
      if (_evOt > 0) {
        otHours += _evOt;
        breakdown.push({ type: "ot", label: `เลิกงานเย็น → OT +${_evOt}` });
      } else if (co < R.STD_OUT_MIN) {
        const m = R.STD_OUT_MIN - co;
        lateMin += m;
        breakdown.push({ type: "late", label: `เลิกก่อน 17:00 (${m} น.)` });
      }
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

  // 🆕 วันเสาร์: เติมเที่ยง/เย็นทีหลังได้ → ครบ 4 จุดคิดสาย/OT เหมือนวันธรรมดา (สายบ่ายหักสิ้นเดือน)
  if (isSat) {
    if (ins.length === 2 && outs.length === 2) {
      return { checkIn: ins[0], lunchOut: outs[0], lunchIn: ins[1], checkOut: outs[1], needsReview: false, reason: "" };
    }
    if (all.length > 0) {
      const satMorning = [...new Set(all)].sort();
      return { checkIn: satMorning[0], lunchOut: null, lunchIn: null, checkOut: null, needsReview: false, reason: "เสาร์ — รอเติมเที่ยง/เย็น" };
    }
    return { checkIn: null, lunchOut: null, lunchIn: null, checkOut: null, needsReview: true, reason: "วันเสาร์ — ไม่สแกนเลย (ขาด/ลา?)" };
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
//   🆕 dbMap = ตารางจับคู่จากฐานข้อมูล (device_user_map) — ใส่มาแล้วจะทับตารางในโค้ด
//        พนักงานใหม่เพิ่มใน DB ได้เลย ไม่ต้องแก้โค้ด
export function parseZKTecoCSV(text, dbMap) {
  const MAP = { ...DEVICE_MAP, ...(dbMap || {}) };
  text = text.replace(/^\uFEFF/, ""); // ลบ BOM
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { rows: [], skipped: [] };

  const rows = [];
  const skipped = []; // เลขเครื่องที่ไม่มีใน map (คนลาออก/PC) → ข้าม

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const [devUid, devName, dateRaw, inS, outS] = cols.map(c => c.trim());

    const empCode = MAP[devUid];
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

// ════════════════════════════════════════════════════════════════
// 🆕 punchesToRows — แปลงเวลาสแกนดิบ (attendance_punches) → rows แบบเดียวกับ parseZKTecoCSV
//   ใช้กับปุ่ม "📡 ดึงจากเครื่องสแกน" แทนการเลือกไฟล์ CSV (16 ก.ย. 69)
//
//   punches   = [[device_uid, "YYYY-MM-DD HH:MM:SS"], ...]  (จาก RPC get_scanner_punches)
//   dbMap     = { device_uid: emp_code }  (device_user_map)
//   dates     = ["YYYY-MM-DD", ...] วันที่เลือก
//   activeCodes = Set(emp_code) ของพนักงานที่ยังทำงาน → ใส่แถว "ไม่สแกนเลย" ให้เหมือน CSV
//
//   กติกา (เทียบกับ CSV จริง มิ.ย.–ก.ย. 69 ตรงทุกแถวที่ไฟล์ดึงหลังเลิกงาน):
//   • ข้ามเลขเครื่องที่ไม่มีใน map (4 = PC ของเยสโมลดิ้ง · 18 = ผู้ดูแลเครื่อง) → skipped
//   • กดซ้ำห่างจากครั้งก่อน ≤ 2 นาที = ครั้งเดียว (เคส 20 ส.ค. ห่าง 73 วิ ZKTime.Net นับครั้งเดียว)
//   • ตัดวินาทีทิ้ง (07:39:38 → 07:39) เหมือน ZKTime.Net
//   • 4 ครั้ง → ins=[เข้าเช้า, กลับพัก] outs=[ออกพัก, เลิกงาน] ป้อน assignPunches ตัวเดิม
//   • วันเสาร์ → assignPunches ตัวเดิม (มีแต่เช้า = คิดสายเช้า · ครบ 4 = คิดบ่ายด้วย)
//   • วันธรรมดาไม่ครบ 4 ครั้ง → วางตามช่วงเวลา + ขึ้น "ต้องตรวจ" ให้ HR จัดเอง
//   • วันอาทิตย์ → ไม่นำเข้า (CSV ไม่มีวันอาทิตย์) นับไว้ใน sundays
// ════════════════════════════════════════════════════════════════
export const PUNCH_MERGE_SEC = 120;
// เลขในเครื่องที่ไม่ใช่พนักงานร้าน — ข้ามเงียบๆ ไม่ต้องขึ้นกล่องเตือนแดงทุกครั้ง
//   4 = "PC YES" (เอ PC ของเยสโมลดิ้ง) · 18 = Lhing ผู้ดูแลเครื่อง
export const SCANNER_IGNORE_UIDS = new Set(["4", "18"]);

export function punchesToRows(punches, dbMap, dates, activeCodes) {
  const MAP = { ...DEVICE_MAP, ...(dbMap || {}) };
  const byKey = {};            // "uid|date" → [Date-sec...]
  const skippedCount = {};     // uid → count
  let sundays = 0;
  const dateSet = new Set(dates || []);

  for (const [uidRaw, ts] of punches || []) {
    const uid = String(uidRaw).trim();
    const date = String(ts).slice(0, 10);
    if (!dateSet.has(date)) continue;
    if (SCANNER_IGNORE_UIDS.has(uid)) continue;
    if (!MAP[uid]) { skippedCount[uid] = (skippedCount[uid] || 0) + 1; continue; }
    const hh = +ts.slice(11, 13), mi = +ts.slice(14, 16), ss = +ts.slice(17, 19);
    (byKey[`${uid}|${date}`] ||= []).push(hh * 3600 + mi * 60 + ss);
  }

  const pad = (n) => String(n).padStart(2, "0");
  const toHHMM = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}`;

  const rows = [];
  const uids = Object.keys(MAP).sort((a, b) => Number(a) - Number(b));
  for (const date of [...dateSet].sort()) {
    const isSun = new Date(date).getDay() === 0;
    for (const uid of uids) {
      const empCode = MAP[uid];
      const secs = (byKey[`${uid}|${date}`] || []).sort((a, b) => a - b);
      if (isSun) { if (secs.length) sundays++; continue; }
      if (!secs.length && !(activeCodes && activeCodes.has(empCode))) continue;

      // รวมกดซ้ำ: ห่างจากสแกนก่อนหน้า ≤ 2 นาที = ครั้งเดียว (เก็บครั้งแรก)
      const kept = [];
      let prev = null;
      for (const s of secs) {
        if (prev === null || s - prev > PUNCH_MERGE_SEC) kept.push(s);
        prev = s;
      }
      const pts = [...new Set(kept.map(toHHMM))];
      const sat = isSaturday(date);

      let res;
      if (pts.length === 4) {
        res = assignPunches([pts[0], pts[2]], [pts[1], pts[3]], sat);
      } else if (sat || pts.length === 0 || pts.length >= 5) {
        res = assignPunches(pts, [], sat);   // เสาร์/ไม่สแกน/5+ ครั้ง ใช้ตรรกะเดิม (เรียงเวลาเอง)
      } else {
        // วันธรรมดา 1–3 ครั้ง → วางตามช่วงเวลา ให้ HR ตรวจ
        res = { checkIn: null, lunchOut: null, lunchIn: null, checkOut: null, needsReview: true, reason: "" };
        const mids = [];
        for (const t of pts) {
          const m = timeToMins(t);
          if (m < 10 * 60 && !res.checkIn) res.checkIn = t;
          else if (m >= 15 * 60 && !res.checkOut) res.checkOut = t;
          else mids.push(t);
        }
        if (mids[0]) res.lunchOut = mids[0];
        if (mids[1]) res.lunchIn = mids[1];
        res.reason = `สแกน ${pts.length} ครั้ง (${pts.join(", ")}) — ไม่ครบ 4 จุด กรุณาตรวจ`;
      }

      rows.push({ date, deviceUid: uid, deviceName: "", empCode, ...res });
    }
  }

  const skipped = Object.entries(skippedCount).map(([devUid, count]) => ({ devUid, devName: "—", count }));
  return { rows, skipped, sundays };
}
