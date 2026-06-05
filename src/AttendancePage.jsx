// src/AttendancePage.jsx
// ─────────────────────────────────────────────────────────────
// หน้าบันทึกเวลา — import CSV จาก ZKTime.Net → parse → ตรวจ → บันทึก Supabase
//
// Props:
//   role: 'hr' | 'owner'
//
// การเพิ่มจากรอบที่แล้ว:
//   1. รับ role prop (ใช้แสดง badge + ส่งต่อ supabase)
//   2. ปุ่ม "💾 บันทึกลง Supabase" หลังผ่านชั้นตรวจ
//   3. แสดงผลบันทึก (saved / errors / importId)
//   4. คลังไฟล์ที่บันทึกไปแล้ว (loadRecentImports)
// ─────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";
import { parseZKTimeCSV, processAttendance } from "./attendanceLogic";
import {
  saveAttendanceToSupabase,
  loadRecentImports,
  deleteImport,
} from "./supabaseAttendance";
import { supabase } from "./supabaseClient";

// ─── สีสถานะ ─────────────────────────────────────────────────
const STATUS_COLOR = {
  ok:     { bg: "#f0fdf4", border: "#bbf7d0", text: "#166534" },
  review: { bg: "#fffbeb", border: "#fde68a", text: "#92400e" },
  error:  { bg: "#fef2f2", border: "#fecaca", text: "#991b1b" },
};

export default function AttendancePage({ role }) {
  const [rawRows,      setRawRows]      = useState([]); // ผล parse CSV
  const [processed,   setProcessed]    = useState([]); // ผลหลัง processAttendance
  const [employees,   setEmployees]    = useState([]); // พนักงานทั้งหมดจาก DB
  const [fileName,    setFileName]     = useState("");
  const [saving,      setSaving]       = useState(false);
  const [saveResult,  setSaveResult]   = useState(null); // { saved, errors, importId }
  const [imports,     setImports]      = useState([]); // คลังไฟล์
  const [loadingImports, setLoadingImports] = useState(false);
  const [activeSection, setActiveSection] = useState("upload"); // upload | history

  // ─── โหลดพนักงาน + คลังไฟล์ ──────────────────────────────
  useEffect(() => {
    loadEmployees();
    loadHistory();
  }, []);

  const loadEmployees = async () => {
    const { data } = await supabase
      .from("employees")
      .select("id, emp_code, nickname, full_name")
      .eq("is_active", true)
      .order("emp_code");
    if (data) setEmployees(data);
  };

  const loadHistory = async () => {
    setLoadingImports(true);
    try {
      const data = await loadRecentImports(10);
      setImports(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingImports(false);
    }
  };

  // ─── อัพโหลด CSV ─────────────────────────────────────────
  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setSaveResult(null);

    const text = await file.text();
    const raw = parseZKTimeCSV(text);           // parse เป็น [{empId, date, time, type}]
    setRawRows(raw);

    if (employees.length === 0) {
      alert("⚠️ ยังโหลดรายชื่อพนักงานไม่ครบ กรุณารอสักครู่แล้วลองใหม่");
      return;
    }

    const result = processAttendance(raw, employees); // จับคู่ + คำนวณสาย/OT
    setProcessed(result);
  };

  // ─── นับสถานะ ──────────────────────────────────────────────
  const okCount     = processed.filter((r) => !r.needs_hr_review).length;
  const reviewCount = processed.filter((r) => r.needs_hr_review).length;

  // ─── บันทึก Supabase ──────────────────────────────────────
  const handleSave = async () => {
    if (processed.length === 0) return;

    // ถ้ามี needs_hr_review → แจ้งเตือนก่อน
    if (reviewCount > 0) {
      const ok = window.confirm(
        `⚠️ มี ${reviewCount} รายการที่ต้องตรวจก่อน\n` +
        `จะบันทึกทั้งหมด ${processed.length} รายการเลยไหม?\n` +
        `(รายการที่ต้องตรวจจะถูก mark needs_hr_review=true)`
      );
      if (!ok) return;
    }

    setSaving(true);
    setSaveResult(null);

    try {
      // ดึงวันแรก-สุดท้ายจากข้อมูล
      const dates = processed.map((r) => r.work_date).sort();
      const dateFrom = dates[0];
      const dateTo   = dates[dates.length - 1];

      const result = await saveAttendanceToSupabase(
        processed,
        fileName,
        dateFrom,
        dateTo,
        role
      );

      setSaveResult({ ...result, success: true });
      setProcessed([]); // clear หลังบันทึกแล้ว
      setRawRows([]);
      setFileName("");
      loadHistory(); // refresh คลัง
    } catch (err) {
      setSaveResult({ success: false, message: err.message });
    } finally {
      setSaving(false);
    }
  };

  // ─── ลบ import ─────────────────────────────────────────────
  const handleDelete = async (importId, name) => {
    if (!window.confirm(`ลบไฟล์ "${name}" และข้อมูลทั้งหมดในนั้นเลยไหม?\nไม่สามารถย้อนกลับได้`))
      return;
    try {
      await deleteImport(importId);
      setImports((prev) => prev.filter((i) => i.id !== importId));
    } catch (e) {
      alert("ลบไม่สำเร็จ: " + e.message);
    }
  };

  // ─── Render ───────────────────────────────────────────────
  return (
    <div style={s.page}>

      {/* ── แท็บ Upload / History ─────────────────────────── */}
      <div style={s.sectionTabs}>
        {["upload","history"].map((sec) => (
          <button
            key={sec}
            onClick={() => setActiveSection(sec)}
            style={{
              ...s.secTab,
              ...(activeSection === sec ? s.secTabActive : {}),
            }}
          >
            {sec === "upload" ? "📤 อัพโหลด CSV" : "📁 คลังไฟล์"}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          SECTION: Upload
      ══════════════════════════════════════════════════════ */}
      {activeSection === "upload" && (
        <div style={s.section}>

          {/* Upload zone */}
          <label style={s.uploadZone}>
            <input
              type="file"
              accept=".csv,.txt"
              onChange={handleFile}
              style={{ display: "none" }}
            />
            <span style={s.uploadIcon}>📂</span>
            <span style={s.uploadText}>
              {fileName ? `✅ ${fileName}` : "แตะเพื่อเลือกไฟล์ CSV จาก ZKTime.Net"}
            </span>
          </label>

          {/* Summary bar */}
          {processed.length > 0 && (
            <div style={s.summaryBar}>
              <span style={{ ...s.badge, background: STATUS_COLOR.ok.bg, color: STATUS_COLOR.ok.text }}>
                🟢 ครบ {okCount} คน/วัน
              </span>
              {reviewCount > 0 && (
                <span style={{ ...s.badge, background: STATUS_COLOR.review.bg, color: STATUS_COLOR.review.text }}>
                  🟡 ต้องตรวจ {reviewCount} รายการ
                </span>
              )}
              <span style={s.badgeTotal}>รวม {processed.length} รายการ</span>
            </div>
          )}

          {/* ผลบันทึก */}
          {saveResult && (
            <div style={{
              ...s.resultBox,
              background: saveResult.success ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${saveResult.success ? "#86efac" : "#fca5a5"}`,
            }}>
              <p style={{ margin: 0, fontWeight: 600,
                color: saveResult.success ? "#166534" : "#991b1b" }}>
                {saveResult.success ? "✅ " : "❌ "}
                {saveResult.message}
              </p>
              {saveResult.importId && (
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6b7280" }}>
                  Import ID: {saveResult.importId}
                </p>
              )}
            </div>
          )}

          {/* ตารางผล */}
          {processed.length > 0 && (
            <>
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>พนักงาน</th>
                      <th style={s.th}>วันที่</th>
                      <th style={s.th}>เข้า</th>
                      <th style={s.th}>พักออก</th>
                      <th style={s.th}>พักกลับ</th>
                      <th style={s.th}>ออก</th>
                      <th style={s.th}>สาย (น.)</th>
                      <th style={s.th}>OT (ชม.)</th>
                      <th style={s.th}>สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processed.map((r, i) => {
                      const st = r.needs_hr_review ? "review" : "ok";
                      const emp = employees.find((e) => e.id === r.employee_id);
                      return (
                        <tr key={i} style={{ background: STATUS_COLOR[st].bg }}>
                          <td style={s.td}>{emp?.nickname || r.employee_id}</td>
                          <td style={s.td}>{r.work_date}</td>
                          <td style={s.td}>{r.scan_am_in  || "—"}</td>
                          <td style={s.td}>{r.scan_am_out || "—"}</td>
                          <td style={s.td}>{r.scan_pm_in  || "—"}</td>
                          <td style={s.td}>{r.scan_pm_out || "—"}</td>
                          <td style={{ ...s.td, color: r.late_minutes > 0 ? "#dc2626" : "inherit", fontWeight: r.late_minutes > 0 ? 700 : 400 }}>
                            {r.late_minutes || 0}
                          </td>
                          <td style={s.td}>{r.ot_hours || 0}</td>
                          <td style={{ ...s.td, color: STATUS_COLOR[st].text, fontWeight: 600 }}>
                            {st === "ok" ? "🟢" : "🟡 ตรวจ"}
                            {r.hr_note ? ` (${r.hr_note})` : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ปุ่มบันทึก */}
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  ...s.saveBtn,
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? "⏳ กำลังบันทึก..." : `💾 บันทึกลง Supabase (${processed.length} รายการ)`}
              </button>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SECTION: History (คลังไฟล์)
      ══════════════════════════════════════════════════════ */}
      {activeSection === "history" && (
        <div style={s.section}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>📁 ไฟล์ที่บันทึกไปแล้ว</h3>
            <button onClick={loadHistory} style={s.refreshBtn}>🔄 โหลดใหม่</button>
          </div>

          {loadingImports && <p style={{ color: "#6b7280" }}>กำลังโหลด...</p>}

          {!loadingImports && imports.length === 0 && (
            <p style={{ color: "#9ca3af", textAlign: "center", marginTop: 32 }}>
              ยังไม่มีไฟล์ที่บันทึก
            </p>
          )}

          {imports.map((imp) => (
            <div key={imp.id} style={s.importCard}>
              <div style={{ flex: 1 }}>
                <p style={s.importName}>{imp.file_name}</p>
                <p style={s.importMeta}>
                  {imp.date_from} → {imp.date_to} · {imp.total_rows} รายการ ·{" "}
                  {imp.uploaded_by_role || "—"} ·{" "}
                  {new Date(imp.uploaded_at).toLocaleString("th-TH")}
                </p>
                {imp.has_errors && (
                  <span style={s.errorBadge}>⚠️ มีรายการต้องตรวจ</span>
                )}
              </div>
              {/* เฉพาะ owner ลบได้ */}
              {role === "owner" && (
                <button
                  onClick={() => handleDelete(imp.id, imp.file_name)}
                  style={s.deleteBtn}
                >
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────
const s = {
  page: { maxWidth: 960, margin: "0 auto" },
  sectionTabs: { display: "flex", gap: 8, marginBottom: 12 },
  secTab: {
    padding: "8px 18px", borderRadius: 8,
    border: "1.5px solid #e2e8f0", background: "#fff",
    cursor: "pointer", fontWeight: 600, fontSize: 14, color: "#64748b",
  },
  secTabActive: { background: "#2563eb", color: "#fff", borderColor: "#2563eb" },
  section: { background: "#fff", borderRadius: 12, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" },
  uploadZone: {
    display: "flex", alignItems: "center", gap: 12,
    border: "2px dashed #93c5fd", borderRadius: 12,
    padding: "20px 16px", cursor: "pointer",
    background: "#eff6ff", marginBottom: 12,
  },
  uploadIcon: { fontSize: 28 },
  uploadText: { fontSize: 14, color: "#1e40af", fontWeight: 600 },
  summaryBar: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 },
  badge: { padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 600 },
  badgeTotal: { padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 600, background: "#f1f5f9", color: "#475569" },
  resultBox: { padding: 12, borderRadius: 8, marginBottom: 12 },
  tableWrap: { overflowX: "auto", marginBottom: 12 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { padding: "8px 10px", textAlign: "left", background: "#f8fafc", borderBottom: "2px solid #e2e8f0", fontWeight: 700, color: "#374151", whiteSpace: "nowrap" },
  td: { padding: "7px 10px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  saveBtn: {
    width: "100%", padding: "14px", borderRadius: 10,
    background: "#2563eb", color: "#fff", border: "none",
    fontSize: 16, fontWeight: 700, cursor: "pointer",
    marginTop: 4,
  },
  refreshBtn: {
    padding: "6px 14px", borderRadius: 8, border: "1px solid #e2e8f0",
    background: "#f8fafc", cursor: "pointer", fontSize: 13,
  },
  importCard: {
    display: "flex", alignItems: "flex-start", gap: 12,
    padding: "12px 14px", borderRadius: 10,
    border: "1px solid #e2e8f0", marginBottom: 8,
  },
  importName: { margin: 0, fontWeight: 700, fontSize: 14, color: "#1e293b" },
  importMeta: { margin: "2px 0 0", fontSize: 12, color: "#6b7280" },
  errorBadge: {
    display: "inline-block", marginTop: 4,
    background: "#fffbeb", color: "#92400e",
    border: "1px solid #fde68a", borderRadius: 4,
    padding: "1px 8px", fontSize: 11, fontWeight: 600,
  },
  deleteBtn: {
    background: "#fef2f2", border: "1px solid #fecaca",
    color: "#dc2626", borderRadius: 8,
    padding: "6px 10px", cursor: "pointer", fontSize: 16,
    flexShrink: 0,
  },
};
