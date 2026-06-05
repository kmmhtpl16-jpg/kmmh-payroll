// src/AttendancePage.jsx
import { useState, useEffect } from "react";
import { parseZKTecoCSV, calcDay } from "./attendanceLogic";
import { saveAttendanceToSupabase, loadRecentImports, deleteImport } from "./supabaseAttendance";
import { supabase } from "./supabaseClient";

const STATUS_COLOR = {
  ok:     { bg: "#f0fdf4", text: "#166534" },
  review: { bg: "#fffbeb", text: "#92400e" },
};

function processAttendance(rows, employees) {
  return rows.map((r) => {
    const emp = employees.find((e) => e.emp_code === r.empCode);
    const { lateMin, otHours } = calcDay({
      checkIn: r.checkIn, lunchOut: r.lunchOut,
      lunchIn: r.lunchIn, checkOut: r.checkOut, empCode: r.empCode,
    });
    return {
      employee_id:     emp?.id || null,
      emp_code:        r.empCode,
      nickname:        emp?.nickname || r.empCode,
      work_date:       r.date,
      scan_am_in:      r.checkIn   || null,
      scan_am_out:     r.lunchOut  || null,
      scan_pm_in:      r.lunchIn   || null,
      scan_pm_out:     r.checkOut  || null,
      late_minutes:    lateMin,
      ot_hours:        otHours,
      lunch_ot:        false,
      needs_hr_review: r.needsReview || !emp,
      hr_note:         !emp ? `ไม่พบพนักงาน emp_code=${r.empCode}` : (r.reason || null),
    };
  });
}

export default function AttendancePage({ role }) {
  const [processed,      setProcessed]      = useState([]);
  const [employees,      setEmployees]      = useState([]);
  const [fileName,       setFileName]       = useState("");
  const [saving,         setSaving]         = useState(false);
  const [saveResult,     setSaveResult]     = useState(null);
  const [imports,        setImports]        = useState([]);
  const [loadingImports, setLoadingImports] = useState(false);
  const [activeSection,  setActiveSection]  = useState("upload");

  // ── state สำหรับ edit mode ─────────────────────────────
  const [reviewLogs,   setReviewLogs]   = useState([]); // logs ที่ needs_hr_review
  const [loadingReview, setLoadingReview] = useState(false);
  const [editRow,      setEditRow]      = useState(null); // row ที่กำลังแก้
  const [editValues,   setEditValues]   = useState({});
  const [savingEdit,   setSavingEdit]   = useState(false);
  const [editMsg,      setEditMsg]      = useState(null);

  useEffect(() => {
    loadEmployees();
    loadHistory();
  }, []);

  const loadEmployees = async () => {
    const { data } = await supabase
      .from("employees").select("id, emp_code, nickname, full_name")
      .eq("is_active", true).order("emp_code");
    if (data) setEmployees(data);
  };

  const loadHistory = async () => {
    setLoadingImports(true);
    try { setImports(await loadRecentImports(10)); }
    catch (e) { console.error(e); }
    finally { setLoadingImports(false); }
  };

  // ── โหลด logs ที่ต้องตรวจ ─────────────────────────────
  const loadReviewLogs = async () => {
    setLoadingReview(true);
    setEditMsg(null);
    const { data, error } = await supabase
      .from("attendance_logs")
      .select("*, employees(nickname, emp_code)")
      .eq("needs_hr_review", true)
      .order("work_date", { ascending: false })
      .limit(100);
    if (!error) setReviewLogs(data || []);
    setLoadingReview(false);
  };

  // ── เปิด modal แก้ไข ──────────────────────────────────
  const openEdit = (log) => {
    setEditRow(log);
    setEditValues({
      scan_am_in:  log.scan_am_in  || "",
      scan_am_out: log.scan_am_out || "",
      scan_pm_in:  log.scan_pm_in  || "",
      scan_pm_out: log.scan_pm_out || "",
      hr_note:     log.hr_note     || "",
    });
    setEditMsg(null);
  };

  // ── บันทึกการแก้ไข ────────────────────────────────────
  const saveEdit = async () => {
    if (!editRow) return;
    setSavingEdit(true);
    setEditMsg(null);

    // คำนวณ late/OT ใหม่จากเวลาที่แก้
    const emp = employees.find(e => e.id === editRow.employee_id);
    const { lateMin, otHours } = calcDay({
      checkIn:  editValues.scan_am_in  || null,
      lunchOut: editValues.scan_am_out || null,
      lunchIn:  editValues.scan_pm_in  || null,
      checkOut: editValues.scan_pm_out || null,
      empCode:  emp?.emp_code || "",
    });

    const allFilled = editValues.scan_am_in && editValues.scan_am_out
      && editValues.scan_pm_in && editValues.scan_pm_out;

    const { error } = await supabase
      .from("attendance_logs")
      .update({
        scan_am_in:      editValues.scan_am_in  || null,
        scan_am_out:     editValues.scan_am_out || null,
        scan_pm_in:      editValues.scan_pm_in  || null,
        scan_pm_out:     editValues.scan_pm_out || null,
        late_minutes:    lateMin,
        ot_hours:        otHours,
        hr_note:         editValues.hr_note || null,
        needs_hr_review: !allFilled, // ถ้ากรอกครบ 4 จุด → ปลด review
        is_confirmed:    allFilled,
        updated_at:      new Date().toISOString(),
      })
      .eq("id", editRow.id);

    if (error) {
      setEditMsg({ type: "error", text: "❌ " + error.message });
    } else {
      setEditMsg({ type: "ok", text: "✅ บันทึกแล้ว" + (allFilled ? " — ปลด 🟡 แล้ว" : " (ยังไม่ครบ 4 จุด)") });
      setReviewLogs(prev => prev.filter(l => l.id !== editRow.id || !allFilled));
      if (allFilled) setTimeout(() => setEditRow(null), 800);
    }
    setSavingEdit(false);
  };

  // ── Upload CSV ─────────────────────────────────────────
  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setSaveResult(null);
    const text = await file.text();
    const { rows } = parseZKTecoCSV(text);
    setProcessed(processAttendance(rows, employees));
  };

  const okCount     = processed.filter(r => !r.needs_hr_review).length;
  const reviewCount = processed.filter(r =>  r.needs_hr_review).length;

  const handleSave = async () => {
    if (processed.length === 0) return;
    if (reviewCount > 0) {
      const ok = window.confirm(
        `⚠️ มี ${reviewCount} รายการต้องตรวจ\nบันทึกทั้งหมด ${processed.length} รายการเลยไหม?\n(แก้ภายหลังได้ในแท็บ "แก้ไขย้อนหลัง")`
      );
      if (!ok) return;
    }
    setSaving(true); setSaveResult(null);
    try {
      const dates  = processed.map(r => r.work_date).sort();
      const result = await saveAttendanceToSupabase(
        processed, fileName, dates[0], dates[dates.length-1], role
      );
      setSaveResult({ ...result, success: true });
      setProcessed([]); setFileName("");
      loadHistory();
    } catch (err) {
      setSaveResult({ success: false, message: err.message });
    } finally { setSaving(false); }
  };

  const handleDelete = async (importId, name) => {
    if (!window.confirm(`ลบไฟล์ "${name}" และข้อมูลทั้งหมดในนั้นเลยไหม?`)) return;
    try { await deleteImport(importId); setImports(p => p.filter(i => i.id !== importId)); }
    catch (e) { alert("ลบไม่สำเร็จ: " + e.message); }
  };

  // ─── TABS ────────────────────────────────────────────
  const SECTIONS = [
    { id: "upload",  label: "📤 อัพโหลด CSV" },
    { id: "review",  label: `🟡 แก้ไขย้อนหลัง` },
    { id: "history", label: "📁 คลังไฟล์" },
  ];

  return (
    <div style={s.page}>
      {/* แท็บ */}
      <div style={s.sectionTabs}>
        {SECTIONS.map(sec => (
          <button key={sec.id}
            onClick={() => { setActiveSection(sec.id); if (sec.id==="review") loadReviewLogs(); }}
            style={{ ...s.secTab, ...(activeSection===sec.id ? s.secTabActive : {}) }}>
            {sec.label}
          </button>
        ))}
      </div>

      {/* ══ UPLOAD ══ */}
      {activeSection === "upload" && (
        <div style={s.section}>
          <label style={s.uploadZone}>
            <input type="file" accept=".csv,.txt" onChange={handleFile} style={{ display:"none" }} />
            <span style={{ fontSize:28 }}>📂</span>
            <span style={{ fontSize:14, color:"#1e40af", fontWeight:600 }}>
              {fileName ? `✅ ${fileName}` : "แตะเพื่อเลือกไฟล์ CSV จาก ZKTime.Net"}
            </span>
          </label>

          {processed.length > 0 && (
            <div style={s.summaryBar}>
              <span style={{ ...s.badge, background:"#f0fdf4", color:"#166534" }}>🟢 ครบ {okCount}</span>
              {reviewCount > 0 && <span style={{ ...s.badge, background:"#fffbeb", color:"#92400e" }}>🟡 ต้องตรวจ {reviewCount}</span>}
              <span style={{ ...s.badge, background:"#f1f5f9", color:"#475569" }}>รวม {processed.length}</span>
            </div>
          )}

          {saveResult && (
            <div style={{ ...s.resultBox,
              background: saveResult.success ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${saveResult.success ? "#86efac":"#fca5a5"}` }}>
              <p style={{ margin:0, fontWeight:600, color: saveResult.success?"#166534":"#991b1b" }}>
                {saveResult.success ? "✅ " : "❌ "}{saveResult.message}
              </p>
              {saveResult.success && reviewCount > 0 && (
                <p style={{ margin:"4px 0 0", fontSize:12, color:"#92400e" }}>
                  💡 แก้ไขรายการ 🟡 ได้ที่แท็บ "แก้ไขย้อนหลัง"
                </p>
              )}
            </div>
          )}

          {processed.length > 0 && (
            <>
              <div style={{ overflowX:"auto", marginBottom:12 }}>
                <table style={s.table}>
                  <thead><tr>
                    {["พนักงาน","วันที่","เข้า","พักออก","พักกลับ","ออก","สาย(น.)","OT(ชม.)","สถานะ"].map(h=>(
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {processed.map((r,i) => (
                      <tr key={i} style={{ background: r.needs_hr_review?"#fffbeb":"#f0fdf4" }}>
                        <td style={s.td}>{r.nickname}</td>
                        <td style={s.td}>{r.work_date}</td>
                        <td style={s.td}>{r.scan_am_in  || "—"}</td>
                        <td style={s.td}>{r.scan_am_out || "—"}</td>
                        <td style={s.td}>{r.scan_pm_in  || "—"}</td>
                        <td style={s.td}>{r.scan_pm_out || "—"}</td>
                        <td style={{ ...s.td, color: r.late_minutes>0?"#dc2626":"inherit", fontWeight: r.late_minutes>0?700:400 }}>
                          {r.late_minutes||0}
                        </td>
                        <td style={s.td}>{r.ot_hours||0}</td>
                        <td style={{ ...s.td, fontWeight:600,
                          color: r.needs_hr_review?"#92400e":"#166534" }}>
                          {r.needs_hr_review ? `🟡 ${r.hr_note||"ตรวจ"}` : "🟢"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button onClick={handleSave} disabled={saving}
                style={{ ...s.saveBtn, opacity: saving?0.6:1 }}>
                {saving ? "⏳ กำลังบันทึก..." : `💾 บันทึกลง Supabase (${processed.length} รายการ)`}
              </button>
            </>
          )}
        </div>
      )}

      {/* ══ REVIEW / แก้ไขย้อนหลัง ══ */}
      {activeSection === "review" && (
        <div style={s.section}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div>
              <h3 style={{ margin:0, fontSize:15 }}>🟡 รายการที่ต้องตรวจและแก้ไข</h3>
              <p style={{ margin:"4px 0 0", fontSize:12, color:"#64748b" }}>
                กรอกเวลาให้ครบ 4 จุด → ระบบคำนวณสาย/OT ใหม่อัตโนมัติ + ปลด 🟡
              </p>
            </div>
            <button onClick={loadReviewLogs} style={s.refreshBtn}>🔄 โหลดใหม่</button>
          </div>

          {loadingReview && <p style={{ color:"#6b7280" }}>กำลังโหลด...</p>}

          {!loadingReview && reviewLogs.length === 0 && (
            <p style={{ color:"#9ca3af", textAlign:"center", padding:32 }}>
              🎉 ไม่มีรายการที่ต้องตรวจแล้ว
            </p>
          )}

          {reviewLogs.map(log => (
            <div key={log.id} style={s.reviewCard}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <span style={{ fontWeight:700, fontSize:14 }}>
                    {log.employees?.nickname || log.employee_id}
                  </span>
                  <span style={{ marginLeft:10, color:"#64748b", fontSize:13 }}>
                    {log.work_date}
                  </span>
                  {log.hr_note && (
                    <span style={{ marginLeft:8, fontSize:12, color:"#92400e",
                      background:"#fffbeb", padding:"1px 8px", borderRadius:4 }}>
                      {log.hr_note}
                    </span>
                  )}
                </div>
                <button onClick={() => openEdit(log)} style={s.editBtn}>✏️ แก้ไข</button>
              </div>
              {/* แสดงเวลาที่มีอยู่ */}
              <div style={{ display:"flex", gap:16, marginTop:8, fontSize:13 }}>
                {[["เข้าเช้า", log.scan_am_in], ["พักออก", log.scan_am_out],
                  ["พักกลับ", log.scan_pm_in], ["ออกเย็น", log.scan_pm_out]].map(([label, val]) => (
                  <div key={label}>
                    <span style={{ color:"#94a3b8", fontSize:11 }}>{label}</span>
                    <p style={{ margin:"2px 0 0", fontWeight: val?600:400,
                      color: val?"#1e293b":"#dc2626" }}>{val || "❌ ขาด"}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══ HISTORY ══ */}
      {activeSection === "history" && (
        <div style={s.section}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <h3 style={{ margin:0, fontSize:15 }}>📁 ไฟล์ที่บันทึกไปแล้ว</h3>
            <button onClick={loadHistory} style={s.refreshBtn}>🔄 โหลดใหม่</button>
          </div>
          {loadingImports && <p style={{ color:"#6b7280" }}>กำลังโหลด...</p>}
          {!loadingImports && imports.length === 0 && (
            <p style={{ color:"#9ca3af", textAlign:"center", marginTop:32 }}>ยังไม่มีไฟล์ที่บันทึก</p>
          )}
          {imports.map(imp => (
            <div key={imp.id} style={s.importCard}>
              <div style={{ flex:1 }}>
                <p style={{ margin:0, fontWeight:700, fontSize:14 }}>{imp.file_name}</p>
                <p style={{ margin:"2px 0 0", fontSize:12, color:"#6b7280" }}>
                  {imp.date_from} → {imp.date_to} · {imp.total_rows} รายการ ·{" "}
                  {new Date(imp.uploaded_at).toLocaleString("th-TH")}
                </p>
                {imp.has_errors && (
                  <span style={{ fontSize:11, background:"#fffbeb", color:"#92400e",
                    border:"1px solid #fde68a", borderRadius:4, padding:"1px 8px" }}>
                    ⚠️ มีรายการต้องตรวจ
                  </span>
                )}
              </div>
              {role === "owner" && (
                <button onClick={() => handleDelete(imp.id, imp.file_name)} style={s.deleteBtn}>🗑</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ══ MODAL แก้ไข ══ */}
      {editRow && (
        <div style={s.modalOverlay} onClick={() => setEditRow(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={{ fontWeight:700, color:"#fff" }}>
                ✏️ แก้ไข — {editRow.employees?.nickname} · {editRow.work_date}
              </span>
              <button onClick={() => setEditRow(null)} style={s.closeBtn}>✕</button>
            </div>
            <div style={{ padding:16 }}>
              <p style={{ margin:"0 0 12px", fontSize:13, color:"#64748b" }}>
                กรอกเวลาให้ครบ 4 จุด → ระบบคำนวณสาย/OT ใหม่ + ปลด 🟡 อัตโนมัติ
              </p>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
                {[
                  ["scan_am_in",  "🕐 เข้าเช้า"],
                  ["scan_am_out", "🍱 พักออก"],
                  ["scan_pm_in",  "🍱 พักกลับ"],
                  ["scan_pm_out", "🕔 ออกเย็น"],
                ].map(([key, label]) => (
                  <div key={key}>
                    <label style={{ display:"block", fontSize:12, color:"#64748b",
                      fontWeight:600, marginBottom:4 }}>{label}</label>
                    <input type="time" value={editValues[key]}
                      onChange={e => setEditValues(p => ({ ...p, [key]: e.target.value }))}
                      style={{ width:"100%", padding:"8px 10px",
                        border:`2px solid ${editValues[key]?"#86efac":"#fca5a5"}`,
                        borderRadius:8, fontSize:15 }} />
                  </div>
                ))}
              </div>

              <div style={{ marginBottom:12 }}>
                <label style={{ display:"block", fontSize:12, color:"#64748b",
                  fontWeight:600, marginBottom:4 }}>หมายเหตุ HR</label>
                <input type="text" value={editValues.hr_note}
                  onChange={e => setEditValues(p => ({ ...p, hr_note: e.target.value }))}
                  placeholder="บันทึกเหตุผลที่แก้ไข"
                  style={{ width:"100%", padding:"8px 10px", border:"1.5px solid #e2e8f0",
                    borderRadius:8, fontSize:14, boxSizing:"border-box" }} />
              </div>

              {editMsg && (
                <div style={{ padding:"8px 12px", borderRadius:8, marginBottom:12,
                  background: editMsg.type==="ok"?"#f0fdf4":"#fef2f2",
                  color: editMsg.type==="ok"?"#166534":"#991b1b",
                  fontWeight:600, fontSize:13 }}>
                  {editMsg.text}
                </div>
              )}

              <div style={{ display:"flex", gap:8 }}>
                <button onClick={saveEdit} disabled={savingEdit}
                  style={{ flex:1, padding:12, borderRadius:10, border:"none",
                    background:"#2563eb", color:"#fff", fontWeight:700,
                    fontSize:15, cursor:"pointer", opacity:savingEdit?0.6:1 }}>
                  {savingEdit ? "⏳ กำลังบันทึก..." : "💾 บันทึก"}
                </button>
                <button onClick={() => setEditRow(null)}
                  style={{ padding:"12px 20px", borderRadius:10,
                    border:"1.5px solid #e2e8f0", background:"#f8fafc",
                    cursor:"pointer", fontWeight:600 }}>
                  ยกเลิก
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  page: { maxWidth:960, margin:"0 auto" },
  sectionTabs: { display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" },
  secTab: { padding:"8px 18px", borderRadius:8, border:"1.5px solid #e2e8f0",
    background:"#fff", cursor:"pointer", fontWeight:600, fontSize:14, color:"#64748b" },
  secTabActive: { background:"#2563eb", color:"#fff", borderColor:"#2563eb" },
  section: { background:"#fff", borderRadius:12, padding:16,
    boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  uploadZone: { display:"flex", alignItems:"center", gap:12,
    border:"2px dashed #93c5fd", borderRadius:12,
    padding:"20px 16px", cursor:"pointer", background:"#eff6ff", marginBottom:12 },
  summaryBar: { display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 },
  badge: { padding:"4px 12px", borderRadius:20, fontSize:13, fontWeight:600 },
  resultBox: { padding:12, borderRadius:8, marginBottom:12 },
  table: { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th: { padding:"8px 10px", textAlign:"left", background:"#f8fafc",
    borderBottom:"2px solid #e2e8f0", fontWeight:700, color:"#374151", whiteSpace:"nowrap" },
  td: { padding:"7px 10px", borderBottom:"1px solid #f1f5f9", whiteSpace:"nowrap" },
  saveBtn: { width:"100%", padding:14, borderRadius:10, background:"#2563eb",
    color:"#fff", border:"none", fontSize:16, fontWeight:700, cursor:"pointer" },
  refreshBtn: { padding:"6px 14px", borderRadius:8, border:"1px solid #e2e8f0",
    background:"#f8fafc", cursor:"pointer", fontSize:13 },
  reviewCard: { padding:"12px 14px", borderRadius:10,
    border:"1.5px solid #fde68a", background:"#fffbeb", marginBottom:8 },
  editBtn: { padding:"6px 14px", borderRadius:8, border:"1.5px solid #e2e8f0",
    background:"#fff", cursor:"pointer", fontWeight:600, fontSize:13 },
  importCard: { display:"flex", alignItems:"flex-start", gap:12,
    padding:"12px 14px", borderRadius:10, border:"1px solid #e2e8f0", marginBottom:8 },
  deleteBtn: { background:"#fef2f2", border:"1px solid #fecaca", color:"#dc2626",
    borderRadius:8, padding:"6px 10px", cursor:"pointer", fontSize:16, flexShrink:0 },
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.45)",
    display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal: { background:"#fff", borderRadius:16, width:440, maxWidth:"92vw",
    boxShadow:"0 20px 60px rgba(0,0,0,0.3)" },
  modalHeader: { display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"14px 16px", background:"#1e3a5f", borderRadius:"16px 16px 0 0" },
  closeBtn: { background:"none", border:"none", color:"#fff",
    fontSize:20, cursor:"pointer", lineHeight:1 },
};
