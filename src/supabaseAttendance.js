// src/supabaseAttendance.js
import { supabase } from "./supabaseClient";

// 🔧 v3 [import guard] หาแถวที่ "สำคัญ" ซึ่งการ import จะไปทับ + คืนรายละเอียด เดิม→ใหม่
//   สำคัญ = (1) log เดิมที่ HR แก้มือ/ยืนยันแล้ว (is_confirmed=true)
//          (2) วันที่อยู่ในรอบจ่าย (pay_cycles) ที่ "จ่ายแล้ว" (is_paid=true)
//   คืน array ของ conflict (ไว้โชว์ใน modal เทียบ เดิม→ใหม่ + ใช้ skip ถ้าผู้ใช้เลือกไม่ทับ)
//   วันปกติที่ไม่เข้าเงื่อนไข = ไม่อยู่ในลิสต์ → ทับเงียบตามเดิม
export async function findProtectedConflicts(rows, dateFrom, dateTo) {
  const empIds = [...new Set(rows.map((r) => r.employee_id).filter(Boolean))];
  if (empIds.length === 0) return [];

  // log เดิม (ไว้เทียบค่าเดิม + เช็ค is_confirmed)
  const { data: existing } = await supabase
    .from("attendance_logs")
    .select("employee_id, work_date, is_confirmed, late_minutes, ot_hours, scan_am_in")
    .in("employee_id", empIds)
    .gte("work_date", dateFrom)
    .lte("work_date", dateTo);
  const existMap = {};
  (existing || []).forEach((e) => {
    existMap[`${e.employee_id}_${e.work_date}`] = e;
  });

  // รอบที่ "จ่ายแล้ว" (ช่วงวันที่)
  const { data: paidCycles } = await supabase
    .from("pay_cycles")
    .select("date_from, date_to, is_paid")
    .eq("is_paid", true)
    .lte("date_from", dateTo)
    .gte("date_to", dateFrom);
  const inPaidCycle = (d) =>
    (paidCycles || []).some((c) => d >= c.date_from && d <= c.date_to);

  const conflicts = [];
  rows.forEach((r) => {
    if (!r.employee_id) return;
    const key = `${r.employee_id}_${r.work_date}`;
    const old = existMap[key];
    const reasons = [];
    if (old?.is_confirmed) reasons.push("HR แก้มือ/ยืนยันแล้ว");
    if (inPaidCycle(r.work_date)) reasons.push("อยู่ในรอบที่จ่ายแล้ว");
    if (reasons.length === 0) return; // วันปกติ → ทับเงียบ ไม่ต้องเตือน

    conflicts.push({
      key,
      employee_id: r.employee_id,
      work_date: r.work_date,
      nickname: r.nickname || r.emp_code || r.employee_id,
      reason: reasons.join(" + "),
      old: old
        ? { am_in: old.scan_am_in || "—", late: old.late_minutes || 0, ot: old.ot_hours || 0 }
        : { am_in: "—", late: "—", ot: "—" },
      neu: { am_in: r.scan_am_in || "—", late: r.late_minutes || 0, ot: r.ot_hours || 0 },
    });
  });

  return conflicts;
}

export async function saveAttendanceToSupabase(
  rows,
  fileName,
  dateFrom,
  dateTo,
  role = "hr",
  skipKeys = new Set()
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

  // ── Step 2: UPSERT attendance_logs (ข้ามรายการสำคัญที่ผู้ใช้เลือกไม่ทับ) ──
  const logsToUpsert = rows
    .filter((r) => !skipKeys.has(`${r.employee_id}_${r.work_date}`))
    .map((r) => ({
      import_id: importId,
      employee_id: r.employee_id,
      work_date: r.work_date,
      scan_am_in: r.scan_am_in || null,
      scan_am_out: r.scan_am_out || null,
      scan_pm_in: r.scan_pm_in || null,
      scan_pm_out: r.scan_pm_out || null,
      late_minutes: r.late_minutes || 0,
      ot_hours: r.ot_hours || 0,
      lunch_ot: r.lunch_ot || false,
      needs_hr_review: r.needs_hr_review || false,
      hr_note: r.hr_note || null,
      is_confirmed: false,
      updated_at: new Date().toISOString(),
    }));

  let savedCount = 0;
  if (logsToUpsert.length > 0) {
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
    savedCount = logData?.length || 0;
  }

  const skippedCount = rows.length - logsToUpsert.length;
  const errorCount = logsToUpsert.filter((r) => r.needs_hr_review).length;

  let message = `บันทึกแล้ว ${savedCount} รายการ`;
  if (skippedCount > 0) message += ` · เก็บของเดิมไว้ ${skippedCount} รายการ`;
  if (errorCount > 0) message += ` · ⚠️ ${errorCount} รายการต้องตรวจ`;
  if (errorCount === 0 && skippedCount === 0) message += " ✅";

  return {
    importId,
    saved: savedCount,
    skipped: skippedCount,
    errors: errorCount,
    message,
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
