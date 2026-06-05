// src/supabaseAttendance.js
import { supabase } from "./supabaseClient";

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
    })
    .select("id")
    .single();

  if (importErr) {
    throw new Error(`สร้าง import record ไม่สำเร็จ: ${importErr.message}`);
  }

  const importId = importData.id;

  // ── Step 2: UPSERT attendance_logs ────────────────────────
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
      ignoreDuplicates: false,
    })
    .select("id");

  if (logErr) {
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

export async function loadAttendanceByDate(date) {
  const { data, error } = await supabase
    .from("attendance_logs")
    .select(`*, employees ( emp_code, nickname, full_name )`)
    .eq("work_date", date)
    .order("employees(emp_code)");

  if (error) throw new Error(`โหลดข้อมูลไม่สำเร็จ: ${error.message}`);
  return data || [];
}

export async function loadRecentImports(limit = 20) {
  const { data, error } = await supabase
    .from("attendance_imports")
    .select("*")
    .order("uploaded_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`โหลดคลังไฟล์ไม่สำเร็จ: ${error.message}`);
  return data || [];
}

export async function deleteImport(importId) {
  const { error } = await supabase
    .from("attendance_imports")
    .delete()
    .eq("id", importId);

  if (error) throw new Error(`ลบ import ไม่สำเร็จ: ${error.message}`);
  return true;
}

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
