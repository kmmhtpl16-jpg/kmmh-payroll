// src/supabaseAttendance.js
import { supabase } from "./supabaseClient";

// 🔧 v2 [import guard] หาแถวที่ "สำคัญ" ซึ่งการ import จะไปทับ:
//   (1) log เดิมที่ HR แก้มือ/ยืนยันแล้ว (is_confirmed = true)
//   (2) วันที่อยู่ในรอบจ่าย (pay_cycles) ที่ "จ่ายแล้ว" (is_paid = true)
//   คืน Map key `${employee_id}_${work_date}` → เหตุผล (ใช้เตือน + ใช้ skip ถ้าผู้ใช้เลือกไม่ทับ)
async function findProtectedKeys(rows, dateFrom, dateTo) {
  const protectedMap = new Map();
  const empIds = [...new Set(rows.map((r) => r.employee_id).filter(Boolean))];
  if (empIds.length === 0) return protectedMap;

  // (1) log เดิมที่ HR ยืนยัน/แก้มือแล้ว → ห้ามทับเงียบ
  const { data: existing } = await supabase
    .from("attendance_logs")
    .select("employee_id, work_date, is_confirmed")
    .in("employee_id", empIds)
    .gte("work_date", dateFrom)
    .lte("work_date", dateTo);
  (existing || []).forEach((e) => {
    if (e.is_confirmed) {
      protectedMap.set(`${e.employee_id}_${e.work_date}`, "HR แก้มือ/ยืนยันแล้ว");
    }
  });

  // (2) วันที่อยู่ในรอบที่ "จ่ายแล้ว" → กระทบยอดที่จ่ายไปแล้ว
  const { data: paidCycles } = await supabase
    .from("pay_cycles")
    .select("date_from, date_to, is_paid")
    .eq("is_paid", true)
    .lte("date_from", dateTo)
    .gte("date_to", dateFrom);
  const inPaidCycle = (d) =>
    (paidCycles || []).some((c) => d >= c.date_from && d <= c.date_to);
  rows.forEach((r) => {
    if (r.employee_id && inPaidCycle(r.work_date)) {
      const k = `${r.employee_id}_${r.work_date}`;
      if (!protectedMap.has(k)) protectedMap.set(k, "อยู่ในรอบที่จ่ายแล้ว");
    }
  });

  return protectedMap;
}

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

  // 🔧 v2 [import guard] เตือนก่อนทับข้อมูลสำคัญ (HR แก้มือ / วันในรอบที่จ่ายแล้ว)
  //   เตือนเฉพาะแถวสำคัญ — วันปกติทับเงียบตามเดิม
  const protectedMap = await findProtectedKeys(rows, dateFrom, dateTo);
  let skipKeys = new Set();
  if (protectedMap.size > 0) {
    const items = [...protectedMap.entries()];
    const sample = items
      .slice(0, 6)
      .map(([k, reason]) => `• ${k.split("_").slice(-1)[0]} (${reason})`)
      .join("\n");
    const more = items.length > 6 ? `\n…และอีก ${items.length - 6} รายการ` : "";
    const overwrite = window.confirm(
      `⚠️ การนำเข้านี้จะทับข้อมูลสำคัญ ${items.length} รายการ:\n${sample}${more}\n\n` +
        `กด "ตกลง" = ทับทั้งหมด (ใช้ข้อมูลใหม่)\n` +
        `กด "ยกเลิก" = เก็บของเดิมไว้ (ข้ามเฉพาะรายการสำคัญพวกนี้ ส่วนวันอื่นยังนำเข้าปกติ)`
    );
    if (!overwrite) skipKeys = new Set(protectedMap.keys());
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

  // ── Step 2: UPSERT attendance_logs (ข้ามรายการสำคัญถ้าผู้ใช้เลือกไม่ทับ) ──
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

  const skippedCount = skipKeys.size;
  const errorCount = logsToUpsert.filter((r) => r.needs_hr_review).length;

  let message = `บันทึกแล้ว ${savedCount} รายการ`;
  if (skippedCount > 0) message += ` · ข้ามของเดิมที่ปกป้องไว้ ${skippedCount} รายการ`;
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
