// src/AttendancePage.jsx
import { useState, useEffect } from "react";
import { parseZKTecoCSV, calcDay } from "./attendanceLogic";
import { saveAttendanceToSupabase, loadRecentImports, deleteImport, findProtectedConflicts } from "./supabaseAttendance";
import { supabase } from "./supabaseClient";
import ImportConflictModal from "./ImportConflictModal";

// ── ปุ่ม preset หมายเหตุ HR ──
// fullDay: true = ไม่มาทำงานทั้งวัน (ลา/ขาด/วันหยุด) → กดแล้วบันทึกจบ ไม่ต้องกรอกเวลา
// fullDay: false = ยังมาทำงานจริง (ครึ่งวัน/ออกระหว่างวัน) → ต้องกรอกเวลาตามจริง
const HR_NOTE_PRESETS = [
  { label: "ลาป่วย", value: "ลาป่วย", fullDay: true, leaveType: "sick" },
  { label: "ลากิจ", value: "ลากิจ", fullDay: true, leaveType: "personal" },
  { label: "ลาป่วยครึ่งวัน", value: "ลาป่วยครึ่งวัน", fullDay: false, leaveType: "sick", half: true },
  { label: "ลากิจครึ่งวัน", value: "ลากิจครึ่งวัน", fullDay: false, leaveType: "personal", half: true },
  { label: "ออกระหว่างวัน", value: "ออกระหว่างวัน", fullDay: false },
  { label: "ขาดงาน", value: "ขาดงาน", fullDay: true },
  { label: "วันหยุด", value: "วันหยุดบริษัท", fullDay: true },
];

function processAttendance(rows, employees) {
  return rows.map((r) => {
    const emp = employees.find((e) => e.emp_code === r.empCode);
    // 🆕 ส่ง date เข้าไปด้วย → calcDay รู้ว่าวันไหนเป็นเสาร์ (คิดเฉพาะสายเช้า)
    const { lateMin, otHours } = calcDay({
      checkIn: r.checkIn, lunchOut: r.lunchOut,
      lunchIn: r.lunchIn, checkOut: r.checkOut, empCode: r.empCode,
      date: r.date,
    });
    return {
      employee_id: emp?.id || null,
      emp_code: r.empCode,
      nickname: emp?.nickname || r.empCode,
      work_date: r.date,
      scan_am_in: r.checkIn || null,
      scan_am_out: r.lunchOut || null,
      scan_pm_in: r.lunchIn || null,
      scan_pm_out: r.checkOut || null,
      late_minutes: lateMin,
      ot_hours: otHours,
      lunch_ot: false,
      needs_hr_review: r.needsReview || !emp,
      hr_note: !emp ? `ไม่พบพนักงาน emp_code=${r.empCode}` : (r.reason || null),
    };
  });
}

// ✅ แปลง "HH:mm" ให้แน่ใจว่าเป็น 24 ชม. เสมอ
function to24h(val) {
  if (!val) return "";
  if (/^\d{2}:\d{2}$/.test(val)) return val;
  const [time, period] = val.split(" ");
  if (!period) return val;
  let [h, m] = time.split(":").map(Number);
  if (period.toUpperCase() === "PM" && h !== 12) h += 12;
  if (period.toUpperCase() === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

export default function AttendancePage({ role }) {
  const [processed, setProcessed] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [fileName, setFileName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [imports, setImports] = useState([]);
  const [loadingImports, setLoadingImports] = useState(false);
  const [activeSection, setActiveSection] = useState("upload");
  const [conflictRows, setConflictRows] = useState(null); // 🔧 v3 [import guard] modal เตือนทับ

  const [reviewLogs, setReviewLogs] = useState([]);
  const [loadingReview, setLoadingReview] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [editValues, setEditValues] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editMsg, setEditMsg] = useState(null);

  useEffect(() => { loadEmployees(); loadHistory(); }, []);

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

  const loadReviewLogs = async () => {
    setLoadingReview(true);
    setEditMsg(null);
    const { data, error } = await supabase
      .from("attendance_logs")
      .select("*, employees(nickname, emp_code)")
      .or("needs_hr_review.eq.true,hr_edited_at.not.is.null")
      .order("work_date", { ascending: false })
      .limit(100);
    if (!error) setReviewLogs(data || []);
    setLoadingReview(false);
  };

  const openEdit = (log) => {
    // 🆕 #1.1 รายการที่แก้ไปแล้ว = ล็อก เปิดแก้ซ้ำไม่ได้
    if (!log.needs_hr_review && log.hr_edited_at) return;
    setEditRow(log);
    setEditValues({
      scan_am_in: log.scan_am_in || "",
      scan_am_out: log.scan_am_out || "",
      scan_pm_in: log.scan_pm_in || "",
      scan_pm_out: log.scan_pm_out || "",
      hr_note: log.hr_note || "",
      hr_extra_deduct: log.hr_extra_deduct != null ? String(log.hr_extra_deduct) : "",
      hr_extra_note: log.hr_extra_note || "",
    });
    setEditMsg(null);
  };

  const saveEdit = async () => {
    if (!editRow) return;
    setSavingEdit(true);
    setEditMsg(null);

    const am_in = to24h(editValues.scan_am_in);
    const am_out = to24h(editValues.scan_am_out);
    const pm_in = to24h(editValues.scan_pm_in);
    const pm_out = to24h(editValues.scan_pm_out);

    const emp = employees.find(e => e.id === editRow.employee_id);
    // 🆕 ส่ง date (work_date ของแถวนี้) เข้าไป → กฎเสาร์ทำงานตอนกดแก้ด้วย
    const { lateMin, otHours } = calcDay({
      checkIn: am_in || null,
      lunchOut: am_out || null,
      lunchIn: pm_in || null,
      checkOut: pm_out || null,
      empCode: emp?.emp_code || "",
      date: editRow.work_date,
    });

    // 🆕 ลา/ขาดทั้งวัน (ลาป่วย/ลากิจ/ขาดงาน/วันหยุด) → ไม่ต้องกรอกเวลา 4 จุด
    const fullDayNote = HR_NOTE_PRESETS.find(p => p.fullDay && p.value === editValues.hr_note);
    const isFullDayAbsence = !!fullDayNote;

    // 🆕 ลาครึ่งวัน → ทำงานจริงครึ่งวัน กรอกแค่ครึ่งเดียว (เช้า หรือ บ่าย) ก็ครบ ปลด 🟡 ได้
    //   (ระบบจะหักค่าแรงครึ่งวันให้อัตโนมัติตอนคำนวณเงินเดือนใน payrollCalc.js)
    const leavePreset = HR_NOTE_PRESETS.find(p => p.leaveType && p.value === editValues.hr_note);
    const isHalfDayLeave = !!(leavePreset && leavePreset.half);
    const amFilled = am_in !== "" && am_out !== "";
    const pmFilled = pm_in !== "" && pm_out !== "";

    const allFilled = amFilled && pmFilled;
    // "ตรวจเสร็จ" ถ้า: กรอกเวลาครบ 4 จุด / ลา-ขาดทั้งวัน / ลาครึ่งวันที่กรอกครึ่งเดียวครบ
    const isDone = allFilled || isFullDayAbsence || (isHalfDayLeave && (amFilled || pmFilled));

    const { error } = await supabase
      .from("attendance_logs")
      .update({
        // ลา/ขาดทั้งวัน = ไม่มาทำงาน → ล้างเวลา + สาย/OT เป็น 0
        scan_am_in: isFullDayAbsence ? null : (am_in || null),
        scan_am_out: isFullDayAbsence ? null : (am_out || null),
        scan_pm_in: isFullDayAbsence ? null : (pm_in || null),
        scan_pm_out: isFullDayAbsence ? null : (pm_out || null),
        late_minutes: isFullDayAbsence ? 0 : lateMin,
        ot_hours: isFullDayAbsence ? 0 : otHours,
        hr_note: editValues.hr_note || null,
        hr_extra_deduct: parseFloat(editValues.hr_extra_deduct) || 0,
        hr_extra_note: editValues.hr_extra_note || null,
        needs_hr_review: isDone ? false : true,
        is_confirmed: isDone ? true : false,
        updated_at: new Date().toISOString(),
        hr_edited_at: new Date().toISOString(),
        hr_edited_by: role || null,
      })
      .eq("id", editRow.id);

    if (error) {
      setEditMsg({ type: "error", text: "❌ " + error.message });
    } else {
      // 🆕 #1.2 ลาป่วย/ลากิจ (เต็ม/ครึ่ง) → บันทึกลงหน้า "การลา" + ตัดสิทธิ์
      if (leavePreset && isDone) {
        try {
          const cy = new Date().getFullYear();
          const deductDays = leavePreset.half ? 0.5 : 1.0;
          const usedField = leavePreset.leaveType === "sick" ? "sick_used" : "personal_used";
          const quotaField = leavePreset.leaveType === "sick" ? "sick_quota" : "personal_quota";
          const { data: exist } = await supabase.from("leave_requests")
            .select("id").eq("employee_id", editRow.employee_id)
            .eq("leave_date", editRow.work_date).limit(1);
          if (!exist || exist.length === 0) {
            const { data: bal } = await supabase.from("leave_balances")
              .select("*").eq("employee_id", editRow.employee_id).eq("year", cy).maybeSingle();
            const remain = bal ? (Number(bal[quotaField]) - Number(bal[usedField])) : (leavePreset.leaveType === "sick" ? 30 : 3);
            await supabase.from("leave_requests").insert({
              employee_id: editRow.employee_id,
              leave_type: leavePreset.leaveType,
              leave_date: editRow.work_date,
              unit: "day",
              hours: leavePreset.half ? 4 : null,
              is_within_quota: remain >= deductDays,
              deduct_amount: 0,
              note: (editValues.hr_note || "") + " (จากบันทึกเวลา)",
            });
            if (bal) {
              await supabase.from("leave_balances")
                .update({ [usedField]: (Number(bal[usedField]) || 0) + deductDays })
                .eq("employee_id", editRow.employee_id).eq("year", cy);
            } else {
              await supabase.from("leave_balances").insert({
                employee_id: editRow.employee_id, year: cy, start_date: `${cy}-01-01`,
                sick_quota: 30, sick_used: leavePreset.leaveType === "sick" ? deductDays : 0,
                personal_quota: 3, personal_used: leavePreset.leaveType === "personal" ? deductDays : 0,
              });
            }
          }
        } catch (e) { console.error("leave sync", e); }
      }
      const doneText = isFullDayAbsence
        ? ` — ${editValues.hr_note} (ทั้งวัน) ปลด 🟡 แล้ว`
        : (isHalfDayLeave && isDone)
        ? ` — ${editValues.hr_note} ปลด 🟡 แล้ว (จ่ายเต็มวัน · ลงหน้าการลาแล้ว)`
        : (isDone ? " — ปลด 🟡 แล้ว" : " (ยังไม่ครบ 4 จุด)");
      setEditMsg({ type: "ok", text: "✅ บันทึกแล้ว" + doneText });
      setReviewLogs(prev => prev.filter(l => l.id !== editRow.id || !isDone));
      if (isDone) setTimeout(() => { setEditRow(null); loadReviewLogs(); }, 800);
    }
    setSavingEdit(false);
  };

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setSaveResult(null);
    const text = await file.text();
    const { rows } = parseZKTecoCSV(text);
    setProcessed(processAttendance(rows, employees));
  };

  const okCount = processed.filter(r => !r.needs_hr_review).length;
  const reviewCount = processed.filter(r => r.needs_hr_review).length;

  // 🔧 v3 [import guard] กดบันทึก → เช็คก่อนว่าจะทับข้อมูลสำคัญไหม ถ้าใช่เปิด modal
  const handleSave = async () => {
    if (processed.length === 0) return;
    if (reviewCount > 0) {
      const ok = window.confirm(
        `⚠️ มี ${reviewCount} รายการต้องตรวจ\nบันทึกทั้งหมด ${processed.length} รายการเลยไหม?\n(แก้ภายหลังได้ในแท็บ "แก้ไขย้อนหลัง")`
      );
      if (!ok) return;
    }
    const dates = processed.map(r => r.work_date).sort();
    const df = dates[0], dt = dates[dates.length - 1];
    try {
      const conflicts = await findProtectedConflicts(processed, df, dt);
      if (conflicts.length > 0) {
        setConflictRows(conflicts); // เปิด modal ให้ผู้ใช้เลือก ทับ/เก็บของเดิม
        return;
      }
    } catch (e) {
      // เช็คไม่ได้ก็ไม่บล็อก — บันทึกตามปกติ
      console.error(e);
    }
    doSave(new Set());
  };

  // ทำการบันทึกจริง (skipKeys = รายการสำคัญที่เลือก "เก็บของเดิม")
  const doSave = async (skipKeys) => {
    setConflictRows(null);
    setSaving(true); setSaveResult(null);
    try {
      const dates = processed.map(r => r.work_date).sort();
      const result = await saveAttendanceToSupabase(
        processed, fileName, dates[0], dates[dates.length-1], role, skipKeys
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

  const SECTIONS = [
    { id: "upload", label: "📤 อัพโหลด CSV" },
    { id: "review", label: "🟡 แก้ไขย้อนหลัง" },
    { id: "history", label: "📁 คลังไฟล์" },
  ];

  return (
    <div style={s.page}>
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
                        <td style={s.td}>{r.scan_am_in || "—"}</td>
                        <td style={s.td}>{r.scan_am_out || "—"}</td>
                        <td style={s.td}>{r.scan_pm_in || "—"}</td>
                        <td style={s.td}>{r.scan_pm_out || "—"}</td>
                        <td style={{ ...s.td, color: r.late_minutes>0?"#dc2626":"inherit", fontWeight: r.late_minutes>0?700:400 }}>
                          {r.late_minutes||0}
                        </td>
                        <td style={s.td}>{r.ot_hours||0}</td>
                        <td style={{ ...s.td, fontWeight:600, color: r.needs_hr_review?"#92400e":"#166534" }}>
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

      {/* ══ REVIEW ══ */}
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
            <p style={{ color:"#9ca3af", textAlign:"center", padding:32 }}>🎉 ไม่มีรายการที่ต้องตรวจแล้ว</p>
          )}

          {reviewLogs.map(log => { const locked = !log.needs_hr_review && !!log.hr_edited_at; return (
            <div key={log.id} style={{ ...s.reviewCard, ...(locked ? s.reviewCardLocked : {}) }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <span style={{ fontWeight:700, fontSize:14 }}>{log.employees?.nickname || log.employee_id}</span>
                  <span style={{ marginLeft:10, color:"#64748b", fontSize:13 }}>{log.work_date}</span>
                  {log.hr_note && (
                    <span style={{ marginLeft:8, fontSize:12, color:"#92400e",
                      background:"#fffbeb", padding:"1px 8px", borderRadius:4 }}>
                      {log.hr_note}
                    </span>
                  )}
                </div>
                {locked ? <span style={s.lockedTag}>✏️ แก้ไขแล้ว 🔒</span> : <button onClick={() => openEdit(log)} style={s.editBtn}>✏️ แก้ไข</button>}
              </div>
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
          );})}
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
                  ["scan_am_in", "🕐 เข้าเช้า"],
                  ["scan_am_out", "🍱 พักออก"],
                  ["scan_pm_in", "🍱 พักกลับ"],
                  ["scan_pm_out", "🕔 ออกเย็น"],
                ].map(([key, label]) => (
                  <div key={key}>
                    <label style={{ display:"block", fontSize:12, color:"#64748b",
                      fontWeight:600, marginBottom:4 }}>{label}</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="เช่น 08:00"
                      value={editValues[key]}
                      onChange={e => {
                        let v = e.target.value.replace(/[^0-9:]/g,"");
                        if (v.length === 2 && !v.includes(":")) v = v + ":";
                        if (v.length > 5) v = v.slice(0,5);
                        setEditValues(p => ({ ...p, [key]: v }));
                      }}
                      style={{
                        width:"100%", padding:"10px", boxSizing:"border-box",
                        border:`2px solid ${editValues[key]?.length===5?"#86efac":"#fca5a5"}`,
                        borderRadius:8, fontSize:18, textAlign:"center",
                        letterSpacing:2, fontWeight:700,
                      }}
                    />
                  </div>
                ))}
              </div>

              {/* ── ปุ่ม preset หมายเหตุ HR ── */}
              <div style={{ marginBottom:8 }}>
                <label style={{ display:"block", fontSize:12, color:"#64748b",
                  fontWeight:600, marginBottom:6 }}>หมายเหตุ HR</label>
                <p style={{ margin:"0 0 8px", fontSize:11, color:"#166534",
                  background:"#f0fdf4", padding:"4px 8px", borderRadius:6,
                  border:"1px solid #bbf7d0" }}>
                  💡 ปุ่มสีเขียว (ลา/ขาด/วันหยุด ทั้งวัน) — กดแล้วกด "บันทึก" ได้เลย ไม่ต้องกรอกเวลา
                  <br />🔵 ลาป่วย/ลากิจครึ่งวัน — กรอกครึ่งที่มาทำงานก็กด "บันทึก" ได้ จ่ายเต็มวัน + ลงหน้าการลาให้เอง
                </p>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 }}>
                  {HR_NOTE_PRESETS.map(p => {
                    const isActive = editValues.hr_note === p.value;
                    return (
                      <button key={p.value}
                        onClick={() => setEditValues(prev => ({ ...prev, hr_note: p.value }))}
                        style={{
                          ...s.presetBtn,
                          ...(p.fullDay ? s.presetBtnFullDay : {}),
                          ...(isActive ? (p.fullDay ? s.presetBtnFullDayActive : s.presetBtnActive) : {}),
                        }}>
                        {p.fullDay ? "🟢 " : p.half ? "🔵 " : ""}{p.label}
                      </button>
                    );
                  })}
                </div>
                <input type="text" value={editValues.hr_note}
                  onChange={e => setEditValues(p => ({ ...p, hr_note: e.target.value }))}
                  placeholder="หรือพิมพ์เองได้"
                  style={{ width:"100%", padding:"8px 10px", border:"1.5px solid #e2e8f0",
                    borderRadius:8, fontSize:14, boxSizing:"border-box" }} />
              </div>

              {/* ── ช่องหักเพิ่ม (ออกระหว่างวัน / ลารายชั่วโมง) ── */}
              <div style={{ marginBottom:12, padding:"10px 12px",
                background:"#fafafa", borderRadius:8, border:"1px solid #e2e8f0" }}>
                <label style={{ display:"block", fontSize:12, color:"#64748b",
                  fontWeight:600, marginBottom:2 }}>💸 หักเพิ่ม (บาท)</label>
                <p style={{ margin:"0 0 8px", fontSize:11, color:"#92400e",
                  background:"#fffbeb", padding:"4px 8px", borderRadius:6,
                  border:"1px solid #fde68a" }}>
                  ⚠️ ใช้เฉพาะ <strong>ออกระหว่างวัน</strong> เท่านั้น —
                  ถ้าเข้าสาย/ออกก่อน/พักนาน ระบบหักให้อัตโนมัติแล้ว ไม่ต้องกรอกซ้ำ
                </p>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <input
                    type="text" inputMode="decimal"
                    placeholder="0.00"
                    value={editValues.hr_extra_deduct}
                    onChange={e => {
                      const v = e.target.value.replace(/[^0-9.]/g,"");
                      setEditValues(p => ({ ...p, hr_extra_deduct: v }));
                    }}
                    style={{ width:100, padding:"8px 10px", border:"1.5px solid #e2e8f0",
                      borderRadius:8, fontSize:16, textAlign:"right",
                      fontWeight:700, boxSizing:"border-box" }}
                  />
                  <span style={{ fontSize:13, color:"#64748b" }}>บาท</span>
                  <input
                    type="text"
                    placeholder="เหตุผล เช่น ออกระหว่างวัน 55 นาที"
                    value={editValues.hr_extra_note}
                    onChange={e => setEditValues(p => ({ ...p, hr_extra_note: e.target.value }))}
                    style={{ flex:1, padding:"8px 10px", border:"1.5px solid #e2e8f0",
                      borderRadius:8, fontSize:13, boxSizing:"border-box" }}
                  />
                </div>
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

      {/* ══ MODAL เตือนทับข้อมูลสำคัญ (import guard) ══ */}
      <ImportConflictModal
        rows={conflictRows}
        saving={saving}
        onOverwrite={() => doSave(new Set())}
        onKeep={() => doSave(new Set((conflictRows || []).map(c => c.key)))}
        onCancel={() => setConflictRows(null)}
      />
    </div>
  );
}

const s = {
  page: { maxWidth:960, margin:"0 auto" },
  sectionTabs: { display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" },
  secTab: { padding:"8px 18px", borderRadius:8, border:"1.5px solid #e2e8f0",
    background:"#fff", cursor:"pointer", fontWeight:600, fontSize:14, color:"#64748b" },
  secTabActive: { background:"#2563eb", color:"#fff", borderColor:"#2563eb" },
  section: { background:"#fff", borderRadius:12, padding:16, boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  uploadZone: { display:"flex", alignItems:"center", gap:12, border:"2px dashed #93c5fd",
    borderRadius:12, padding:"20px 16px", cursor:"pointer", background:"#eff6ff", marginBottom:12 },
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
  reviewCardLocked: { border:"1.5px solid #bbf7d0", background:"#f0fdf4" },
  lockedTag: { padding:"6px 12px", borderRadius:8, background:"#dcfce7",
    color:"#166534", fontWeight:700, fontSize:12, whiteSpace:"nowrap" },
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
  closeBtn: { background:"none", border:"none", color:"#fff", fontSize:20, cursor:"pointer", lineHeight:1 },

  // ── preset buttons ──
  presetBtn: {
    padding:"5px 12px", borderRadius:20, border:"1.5px solid #e2e8f0",
    background:"#f8fafc", cursor:"pointer", fontSize:13, fontWeight:600,
    color:"#475569", transition:"all 0.15s",
  },
  presetBtnActive: {
    background:"#dbeafe", borderColor:"#93c5fd", color:"#1e40af",
  },
  // ── ปุ่มกลุ่ม "ลา/ขาดทั้งวัน" (กดแล้วบันทึกจบ) ──
  presetBtnFullDay: {
    borderColor:"#bbf7d0", color:"#166534", background:"#f0fdf4",
  },
  presetBtnFullDayActive: {
    background:"#16a34a", borderColor:"#16a34a", color:"#fff",
  },
};
