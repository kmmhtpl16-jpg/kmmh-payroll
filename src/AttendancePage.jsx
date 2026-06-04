// AttendancePage.jsx
// หน้าบันทึกเวลา — KMMH Payroll (v2: import CSV + ชั้นตรวจ + 4 จุดสแกน)
// วางที่ src/pages/AttendancePage.jsx
//
// ใช้คู่กับ:
//   - src/lib/attendanceLogic.js  (parser + กฎคำนวณ)
//   - src/supabase.js             (Supabase client — ปรับ path ให้ตรง)
//   - ตาราง: attendance_imports, attendance_logs, device_user_map

import { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabase"; // ← ปรับ path ตาม project
import {
  parseZKTecoCSV, calcDay, fmtLate,
} from "./attendanceLogic"; // ← ปรับ path ตาม project

const STATUS = {
  present:        { label: "มาทำงาน", c: "#16a34a", bg: "#f0fdf4", bd: "#bbf7d0" },
  leave_sick:     { label: "ลาป่วย",  c: "#2563eb", bg: "#eff6ff", bd: "#bfdbfe" },
  leave_personal: { label: "ลากิจ",   c: "#d97706", bg: "#fffbeb", bd: "#fde68a" },
  absent:         { label: "ขาด",     c: "#dc2626", bg: "#fef2f2", bd: "#fecaca" },
};

function thaiDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const days = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
  const mons = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  return `${days[d.getDay()]} ${d.getDate()} ${mons[d.getMonth()]}`;
}

export default function AttendancePage() {
  const [empByCode, setEmpByCode] = useState({});
  const [parsedRows, setParsedRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [skipped, setSkipped] = useState([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    supabase.from("employees")
      .select("id, emp_code, nickname, emp_type")
      .eq("is_active", true).order("emp_code")
      .then(({ data }) => {
        const map = {};
        (data || []).forEach(e => { map[e.emp_code] = e; });
        setEmpByCode(map);
      });
  }, []);

  function recompute(r) {
    if (r.status && r.status !== "present") {
      return { lateMin: 0, otHours: 0, breakdown: [] };
    }
    return calcDay({
      checkIn: r.checkIn, lunchOut: r.lunchOut,
      lunchIn: r.lunchIn, checkOut: r.checkOut, empCode: r.empCode,
    });
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setToast(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { rows, skipped } = parseZKTecoCSV(ev.target.result);
      const withCalc = rows.map(r => {
        const base = { ...r, status: "present", hrNote: "" };
        return { ...base, ...recompute(base) };
      });
      setParsedRows(withCalc);
      setSkipped(skipped);
      if (rows.length === 0) setToast({ msg: "ไม่พบข้อมูลในไฟล์ หรือรูปแบบไม่ตรง", type: "error" });
    };
    reader.readAsText(file, "utf-8");
  }

  function updateRow(idx, field, value) {
    setParsedRows(prev => {
      const next = [...prev];
      const r = { ...next[idx], [field]: value };
      if (field === "status" && value !== "present") {
        r.checkIn = null; r.lunchOut = null; r.lunchIn = null; r.checkOut = null;
        r.needsReview = false; r.reason = "";
      }
      if (["checkIn","lunchOut","lunchIn","checkOut"].includes(field)) {
        if (r.checkIn && r.lunchOut && r.lunchIn && r.checkOut) {
          r.needsReview = false; r.reason = "";
        }
      }
      Object.assign(r, recompute(r));
      next[idx] = r;
      return next;
    });
  }

  const stats = useMemo(() => {
    const s = { total: parsedRows.length, ready: 0, review: 0 };
    parsedRows.forEach(r => { r.needsReview ? s.review++ : s.ready++; });
    return s;
  }, [parsedRows]);

  const visibleRows = useMemo(() => {
    if (filter === "ready")  return parsedRows.filter(r => !r.needsReview);
    if (filter === "review") return parsedRows.filter(r => r.needsReview);
    return parsedRows;
  }, [parsedRows, filter]);

  function buildNote(r) {
    const parts = [];
    if (r.lunchOut && r.lunchIn) parts.push(`พัก${r.lunchOut}-${r.lunchIn}`);
    if (r.reason) parts.push(r.reason);
    if (r.hrNote) parts.push(r.hrNote);
    return parts.join(" | ") || null;
  }

  async function handleSave() {
    if (parsedRows.length === 0) return;
    setSaving(true); setToast(null);
    try {
      const dates = [...new Set(parsedRows.map(r => r.date))].sort();
      const { data: imp, error: impErr } = await supabase
        .from("attendance_imports")
        .insert({
          source: "csv", file_name: fileName || "zkteco.csv",
          date_from: dates[0], date_to: dates[dates.length - 1],
          total_rows: parsedRows.length,
        })
        .select("id").single();
      if (impErr) throw impErr;

      const logs = parsedRows
        .filter(r => r.checkIn || r.status !== "present")
        .map(r => ({
          import_id: imp.id,
          employee_id: empByCode[r.empCode]?.id,
          work_date: r.date,
          check_in:  r.checkIn  || null,
          check_out: r.checkOut || null,
          status:    r.status,
          needs_hr_review: r.needsReview,
          hr_note: buildNote(r),
          is_confirmed: !r.needsReview,
        }))
        .filter(l => l.employee_id);

      if (logs.length === 0) throw new Error("ไม่มีข้อมูลให้บันทึก");

      const { error: upErr } = await supabase
        .from("attendance_logs")
        .upsert(logs, { onConflict: "employee_id,work_date" });
      if (upErr) throw upErr;

      setToast({ msg: `✅ บันทึก ${logs.length} รายการ (ยังต้องตรวจ ${stats.review})`, type: "success" });
    } catch (err) {
      console.error(err);
      setToast({ msg: `❌ ${err.message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ fontFamily: "'Sarabun', sans-serif", padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#1e293b" }}>
          📋 บันทึกเวลา — นำเข้าจากเครื่องสแกน
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748b" }}>
          เข้า 08:00 · พัก 1 ชม. (พัก&lt;30น.= OT+1) · เลิก 17:00 · OT เย็นหลัง 17:30
        </p>
      </div>

      <div style={{
        border: "2px dashed #cbd5e1", borderRadius: 12, padding: "20px 24px",
        background: "#f8fafc", marginBottom: 16, display: "flex",
        alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#334155" }}>อัปไฟล์ CSV จาก ZKTime.Net</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
            {fileName ? `📄 ${fileName}` : "เลือกรายงาน Transactions → export CSV"}
          </div>
        </div>
        <label style={{
          padding: "9px 20px", background: "#2563eb", color: "#fff",
          borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>
          เลือกไฟล์
          <input type="file" accept=".csv" onChange={handleFile} style={{ display: "none" }} />
        </label>
      </div>

      {skipped.length > 0 && (
        <div style={{ padding: "8px 14px", background: "#f1f5f9", borderRadius: 8, fontSize: 12, color: "#64748b", marginBottom: 12 }}>
          ℹ️ ข้าม {skipped.length} แถว — เลขเครื่องไม่อยู่ในระบบ:{" "}
          {[...new Set(skipped.map(s => `${s.devUid}(${s.devName})`))].join(", ")}
        </div>
      )}

      {parsedRows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {[
              { k: "all", label: `ทั้งหมด ${stats.total}`, c: "#475569" },
              { k: "ready", label: `🟢 ครบ ${stats.ready}`, c: "#16a34a" },
              { k: "review", label: `🟡 ต้องตรวจ ${stats.review}`, c: "#d97706" },
            ].map(t => (
              <button key={t.k} onClick={() => setFilter(t.k)}
                style={{
                  padding: "7px 16px", fontSize: 13, fontWeight: 600,
                  border: filter === t.k ? `2px solid ${t.c}` : "1px solid #e2e8f0",
                  borderRadius: 8, background: filter === t.k ? "#fff" : "#f8fafc",
                  color: t.c, cursor: "pointer", fontFamily: "'Sarabun', sans-serif",
                }}>
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 860 }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "2px solid #e2e8f0" }}>
                  {["วันที่","ชื่อเล่น","เข้าเช้า","ออกเที่ยง","เข้าเที่ยง","ออกเย็น","สาย","OT","สถานะ","หมายเหตุ"]
                    .map(h => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const idx = parsedRows.indexOf(r);
                  const emp = empByCode[r.empCode];
                  const sc = STATUS[r.status] || STATUS.present;
                  const dis = r.status !== "present";
                  return (
                    <tr key={`${r.empCode}-${r.date}`} style={{
                      borderBottom: "1px solid #f1f5f9",
                      background: r.needsReview ? "#fffbeb" : "#fff",
                    }}>
                      <td style={{ ...td, whiteSpace: "nowrap", color: "#64748b" }}>{thaiDate(r.date)}</td>
                      <td style={{ ...td, fontWeight: 600, color: "#1e293b", whiteSpace: "nowrap" }}>
                        {emp?.nickname || r.empCode}
                        {emp?.emp_type === "trial" && <span style={{ marginLeft: 4, fontSize: 10, color: "#d97706" }}>ทดลอง</span>}
                      </td>
                      {["checkIn","lunchOut","lunchIn","checkOut"].map(f => (
                        <td key={f} style={td}>
                          <input type="time" value={r[f] || ""} disabled={dis}
                            onChange={e => updateRow(idx, f, e.target.value || null)}
                            style={{
                              width: 92, padding: "4px 6px", fontSize: 12.5,
                              border: `1px solid ${!r[f] && r.needsReview ? "#fbbf24" : "#e2e8f0"}`,
                              borderRadius: 6, textAlign: "center",
                              background: dis ? "#f1f5f9" : (!r[f] && r.needsReview ? "#fef3c7" : "#fff"),
                              color: dis ? "#cbd5e1" : "#1e293b",
                              fontFamily: "'Sarabun', sans-serif",
                            }} />
                        </td>
                      ))}
                      <td style={{ ...td, textAlign: "center" }}>
                        {r.lateMin > 0
                          ? <span style={{ color: "#dc2626", fontWeight: 700 }}>{fmtLate(r.lateMin)}</span>
                          : <span style={{ color: "#cbd5e1" }}>—</span>}
                      </td>
                      <td style={{ ...td, textAlign: "center" }}>
                        {r.otHours > 0
                          ? <span style={{ color: "#16a34a", fontWeight: 700 }}>+{r.otHours}</span>
                          : <span style={{ color: "#cbd5e1" }}>—</span>}
                      </td>
                      <td style={td}>
                        <select value={r.status} onChange={e => updateRow(idx, "status", e.target.value)}
                          style={{
                            width: 96, padding: "4px 6px", fontSize: 12, fontWeight: 600,
                            border: `1px solid ${sc.bd}`, borderRadius: 6,
                            color: sc.c, background: sc.bg, cursor: "pointer",
                            fontFamily: "'Sarabun', sans-serif",
                          }}>
                          {Object.entries(STATUS).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
                        </select>
                      </td>
                      <td style={{ ...td, minWidth: 140 }}>
                        {r.needsReview
                          ? <span style={{ fontSize: 11, color: "#d97706" }}>⚠️ {r.reason}</span>
                          : <input type="text" value={r.hrNote} placeholder="—"
                              onChange={e => updateRow(idx, "hrNote", e.target.value)}
                              style={{
                                width: "100%", border: "none", borderBottom: "1px solid #e2e8f0",
                                background: "transparent", fontSize: 12, padding: "2px 0",
                                color: "#475569", fontFamily: "'Sarabun', sans-serif",
                              }} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <div style={{ fontSize: 13 }}>
              {toast
                ? <span style={{ fontWeight: 600, color: toast.type === "success" ? "#16a34a" : "#dc2626" }}>{toast.msg}</span>
                : <span style={{ color: "#64748b" }}>🟢 ครบ {stats.ready} · 🟡 ต้องตรวจ {stats.review} · รวม {stats.total}</span>}
            </div>
            <button onClick={handleSave} disabled={saving}
              style={{
                padding: "9px 28px", fontSize: 13, fontWeight: 700,
                background: saving ? "#93c5fd" : "#2563eb", color: "#fff",
                border: "none", borderRadius: 8, cursor: saving ? "not-allowed" : "pointer",
                fontFamily: "'Sarabun', sans-serif",
              }}>
              {saving ? "กำลังบันทึก..." : "💾 บันทึกทั้งหมด"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const th = { padding: "9px 10px", textAlign: "left", fontSize: 11.5, fontWeight: 600, color: "#64748b", whiteSpace: "nowrap" };
const td = { padding: "6px 10px", verticalAlign: "middle" };
