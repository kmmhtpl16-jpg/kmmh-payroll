// src/supabaseAttendance.js
// ─────────────────────────────────────────────────────────────
// ฟังก์ชันสำหรับบันทึกข้อมูลบันทึกเวลาลง Supabase
//
// Flow:
//   1. INSERT attendance_imports (1 row = 1 ไฟล์ CSV)
//   2. UPSERT attendance_logs (หลาย rows = รายวันรายคน)
//   3. อัพเดต total_rows / has_errors กลับที่ imports
//
// Export:
//   saveAttendanceToSupabase(parsedRows, fileName, dateFrom, dateTo)
//   loadAttendanceByDate(date)        ← ดึง log รายวัน
//   loadRecentImports(limit)          ← ดึงคลังไฟล์
//   deleteImport(importId)            ← ลบทั้ง batch + cascade logs
// ─────────────────────────────────────────────────────────────

import { supabase } from "./supabaseClient";

// ─────────────────────────────────────────────────────────────
// saveAttendanceToSupabase
//
// @param rows        - array จาก attendanceLogic.js (หลัง calculate)
//   รูปแบบแต่ละ row:
//   {
//     employee_id   : uuid (ผูกแล้ว),
//     work_date     : 'YYYY-MM-DD',
//     scan_am_in    : 'HH:mm' | null,
//     scan_am_out   : 'HH:mm' | null,
//     scan_pm_in    : 'HH:mm' | null,
//     scan_pm_out   : 'HH:mm' | null,
//     late_minutes  : number,
//     ot_hours      : number,
//     lunch_ot      : boolean,
//     needs_hr_review : boolean,
//     hr_note       : string | null,
//   }
// @param fileName    - ชื่อไฟล์ CSV ต้นฉบับ
// @param dateFrom    - 'YYYY-MM-DD' วันแรกในไฟล์
// @param dateTo      - 'YYYY-MM-DD' วันสุดท้ายในไฟล์
// @param role        - 'hr' | 'owner' (สำหรับ uploaded_by_role)
//
// @returns { importId, saved, errors }
// ─────────────────────────────────────────────────────────────
export async function saveAttendanceToSupabase(
  rows,
  fileName,
  dateFrom,
  dateTo,
  role = "hr"
) {
  if (!rows || rows.length === 0) {
    throw new Error("ไม่มีข้อมูลที่จะบันทึก");
  }

  // ── Step 1: สร้าง import record ───────────────────────────
  const { data: importData, error: importErr } = await supabase
    .from("attendance_imports")
    .insert({
      file_name: fileName,
      date_from: dateFrom,
      date_to: dateTo,
      total_rows: rows.length,
      has_errors: rows.some((r) => r.needs_hr_review),
      uploaded_by_role: role,
    })
    .select("id")
    .single();

  if (importErr) {
    throw new Error(`สร้าง import record ไม่สำเร็จ: ${importErr.message}`);
  }

  const importId = importData.id;

  // ── Step 2: UPSERT attendance_logs ────────────────────────
  // ใช้ upsert เพราะถ้า import ซ้ำวันเดิม → อัพเดตข้อมูล
  // (UNIQUE constraint: employee_id + work_date)
  const logsToUpsert = rows.map((r) => ({
    import_id:        importId,
    employee_id:      r.employee_id,
    work_date:        r.work_date,
    scan_am_in:       r.scan_am_in   || null,
    scan_am_out:      r.scan_am_out  || null,
    scan_pm_in:       r.scan_pm_in   || null,
    scan_pm_out:      r.scan_pm_out  || null,
    late_minutes:     r.late_minutes  || 0,
    ot_hours:         r.ot_hours      || 0,
    lunch_ot:         r.lunch_ot      || false,
    needs_hr_review:  r.needs_hr_review || false,
    hr_note:          r.hr_note       || null,
    is_confirmed:     false,
    updated_at:       new Date().toISOString(),
  }));

  const { data: logData, error: logErr } = await supabase
    .from("attendance_logs")
    .upsert(logsToUpsert, {
      onConflict: "employee_id,work_date",
      ignoreDuplicates: false, // อัพเดตถ้าซ้ำ
    })
    .select("id");

  if (logErr) {
    // พยายาม rollback import record
    await supabase.from("attendance_imports").delete().eq("id", importId);
    throw new Error(`บันทึก logs ไม่สำเร็จ: ${logErr.message}`);
  }

  const savedCount = logData?.length || 0;
  const errorCount = rows.filter((r) => r.needs_hr_review).length;

  return {
    importId,
    saved: savedCount,
    errors: errorCount,
    message: `บันทึกแล้ว ${savedCount} รายการ${errorCount > 0 ? ` (⚠️ ${errorCount} รายการต้องตรวจ)` : " ✅"}`,
  };
}

// ─────────────────────────────────────────────────────────────
// loadAttendanceByDate — ดึง log รายวันพร้อมชื่อพนักงาน
// ─────────────────────────────────────────────────────────────
export async function loadAttendanceByDate(date) {
  const { data, error } = await supabase
    .from("attendance_logs")
    .select(`
      *,
      employees ( emp_code, nickname, full_name )
    `)
    .eq("work_date", date)
    .order("employees(emp_code)");

  if (error) throw new Error(`โหลดข้อมูลไม่สำเร็จ: ${error.message}`);
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// loadRecentImports — คลังไฟล์ที่อัพโหลด
// ─────────────────────────────────────────────────────────────
export async function loadRecentImports(limit = 20) {
  const { data, error } = await supabase
    .from("attendance_imports")
    .select("*")
    .order("uploaded_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`โหลดคลังไฟล์ไม่สำเร็จ: ${error.message}`);
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// deleteImport — ลบทั้ง batch (cascade → ลบ logs ด้วย)
// ─────────────────────────────────────────────────────────────
export async function deleteImport(importId) {
  const { error } = await supabase
    .from("attendance_imports")
    .delete()
    .eq("id", importId);

  if (error) throw new Error(`ลบ import ไม่สำเร็จ: ${error.message}`);
  return true;
}

// ─────────────────────────────────────────────────────────────
// confirmLog — HR ยืนยัน log ที่ needs_hr_review = true
// ─────────────────────────────────────────────────────────────
export async function confirmLog(logId, hrNote) {
  const { error } = await supabase
    .from("attendance_logs")
    .update({
      is_confirmed: true,
      needs_hr_review: false,
      hr_note: hrNote || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", logId);

  if (error) throw new Error(`ยืนยัน log ไม่สำเร็จ: ${error.message}`);
  return true;
}
