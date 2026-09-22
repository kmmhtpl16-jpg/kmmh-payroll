// src/EditRequestPanel.jsx
// ── ระบบ "ขอแก้ไข" ของโปรแกรมเงินเดือน (22 ก.ย.69) ──
// HR กดขอ (เหตุผล + สิ่งที่จะเปลี่ยนเป็น + ไฟล์หลักฐาน)
//   → เด้ง Telegram กลุ่มเงินเดือน
//   → เจ้าของเห็นแถบบนหน้าบันทึกเวลา พร้อมตัวเลขผลกระทบต่อเงิน
//   → กดอนุมัติ = ระบบแก้ให้เลย (RPC apply_edit_request คืนสิทธิ์ลาเก่า + ตัดสิทธิ์ใหม่ให้ในทีเดียว)
// 🔑 ที่ต้องมี RPC เพราะการเปลี่ยนโน้ต "ขาด ↔ ลา" กระทบ 3 ตาราง ถ้าทำแยกแล้วพังกลางทาง สิทธิ์ลาจะค้าง
import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { HR_NOTE_PRESETS, PRESET_GROUPS, impactOf, deriveFromNote, dayLabelTH } from "./hrNotePresets";

// bucket receipts เป็น private → ต้องขอ signed url ตอนกดดู (เก็บ path ลง DB เท่านั้น)
async function signedUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from("receipts").createSignedUrl(path, 3600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

async function compressImage(file, maxDim = 1200) {
  if (!file.type.startsWith("image/")) return file;   // pdf ส่งตรง
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => resolve(new File([blob], (file.name || "evidence").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" })),
          "image/jpeg", 0.75);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

// ══════════════════════════════════════════════
// ① ฟอร์ม HR กด "ขอแก้ไข"
// ══════════════════════════════════════════════
export function EditRequestModal({ log, emp, role, onClose, onSent }) {
  const [note, setNote] = useState(log.hr_note || "");
  const [times, setTimes] = useState({
    scan_am_in: log.scan_am_in || "", scan_am_out: log.scan_am_out || "",
    scan_pm_in: log.scan_pm_in || "", scan_pm_out: log.scan_pm_out || "",
  });
  const [extraDeduct, setExtraDeduct] = useState(log.hr_extra_deduct != null ? String(log.hr_extra_deduct) : "");
  const [extraNote, setExtraNote] = useState(log.hr_extra_note || "");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const d = deriveFromNote({ note, times, empCode: emp?.emp_code, workDate: log.work_date });
  const impact = impactOf({
    emp, workDate: log.work_date, oldNote: log.hr_note, newNote: note,
    oldLate: log.late_minutes, newLate: d.lateMinutes,
  });
  const changed = note !== (log.hr_note || "") ||
    d.times.scan_am_in !== (log.scan_am_in || "") || d.times.scan_am_out !== (log.scan_am_out || "") ||
    d.times.scan_pm_in !== (log.scan_pm_in || "") || d.times.scan_pm_out !== (log.scan_pm_out || "") ||
    (parseFloat(extraDeduct) || 0) !== (Number(log.hr_extra_deduct) || 0);

  const canSend = changed && reason.trim().length >= 5 && !!file && d.isDone && !busy;

  const send = async () => {
    setBusy(true); setMsg(null);
    try {
      // ① อัปไฟล์หลักฐานก่อน — ถ้าอัปไม่ขึ้น ห้ามสร้างคำขอ (กันคำขอเปล่าไม่มีหลักฐาน)
      const comp = await compressImage(file);
      const ext = comp.type === "image/jpeg" ? "jpg" : (comp.name.split(".").pop() || "bin");
      const path = `edit-requests/${log.employee_id}/${log.work_date}_${Date.now()}.${ext}`;
      const up = await supabase.storage.from("receipts").upload(path, comp, { upsert: false });
      if (up.error) throw new Error("อัปไฟล์ไม่สำเร็จ: " + up.error.message);

      const { error } = await supabase.from("edit_requests").insert({
        target_table: "attendance_logs",
        target_id: log.id,
        target_label: `${emp?.nickname || log.employees?.nickname || "-"} · ${dayLabelTH(log.work_date)} (${log.hr_note || "ไม่มีโน้ต"} → ${note || "-"})`,
        employee_id: log.employee_id,
        request_kind: "edit",
        old_data: {
          hr_note: log.hr_note, scan_am_in: log.scan_am_in, scan_am_out: log.scan_am_out,
          scan_pm_in: log.scan_pm_in, scan_pm_out: log.scan_pm_out,
          late_minutes: log.late_minutes, ot_hours: log.ot_hours,
          hr_extra_deduct: log.hr_extra_deduct, hr_extra_note: log.hr_extra_note,
        },
        new_data: {
          hr_note: note,
          ...d.times,
          hr_extra_deduct: parseFloat(extraDeduct) || 0,
          hr_extra_note: extraNote || null,
        },
        reason: reason.trim(),
        evidence_url: path,
        impact_note: impact,
        requested_by: role || null,
      });
      if (error) throw new Error(error.message);
      setMsg({ type: "ok", text: "✅ ส่งคำขอแล้ว — แจ้งเตือนเข้า Telegram กลุ่มเงินเดือนเรียบร้อย รอเจ้าของกดอนุมัติ" });
      setTimeout(() => { onSent?.(); onClose(); }, 1200);
    } catch (e) {
      setMsg({ type: "error", text: "❌ " + (e.message || e) });
    } finally { setBusy(false); }
  };

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...st.header, background: "#b45309" }}>
          <span style={{ fontWeight: 700, color: "#fff" }}>
            📨 ขอแก้ไข — {emp?.nickname || log.employees?.nickname} · {log.work_date}
          </span>
          <button onClick={onClose} style={st.closeBtn}>✕</button>
        </div>

        <div style={{ padding: "12px 14px" }}>
          <div style={st.oldBox}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#475569", marginBottom: 4 }}>ข้อมูลตอนนี้ (ล็อกอยู่)</div>
            <div style={{ fontSize: 13, color: "#334155" }}>
              {log.hr_note ? <b>{log.hr_note}</b> : <i style={{ color: "#94a3b8" }}>ไม่มีโน้ต</i>}
              {" · "}เข้า {log.scan_am_in || "—"} · ออก {log.scan_pm_out || "—"}
              {" · "}สาย {log.late_minutes || 0} น.
            </div>
          </div>

          <label style={st.label}>ขอเปลี่ยนเป็น</label>
          {PRESET_GROUPS.map((g) => {
            const items = HR_NOTE_PRESETS.filter((p) => p.cat === g.key);
            if (!items.length) return null;
            const icon = { paid: "🟢 ", half: "🔵 ", deduct: "🔴 ", other: "🟠 " }[g.key] || "";
            return (
              <div key={g.key} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#334155", marginBottom: 3 }}>{g.title}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 5 }}>
                  {items.map((p) => (
                    <button key={p.value} onClick={() => setNote(p.value)}
                      style={{ ...st.preset, ...(note === p.value ? st.presetActive : {}) }}>
                      {icon}{p.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="หรือพิมพ์เองได้" style={st.input} />

          {d.needTimes && (
            <>
              <label style={st.label}>เวลาสแกน (แก้ได้ถ้าจำเป็น)</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                {[["scan_am_in", "🕐 เข้าเช้า"], ["scan_am_out", "🍱 พักออก"],
                  ["scan_pm_in", "🍱 พักกลับ"], ["scan_pm_out", "🕔 ออกเย็น"]].map(([key, lbl]) => (
                  <div key={key}>
                    <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{lbl}</span>
                    <input type="text" inputMode="numeric" placeholder="เช่น 08:00" value={times[key]}
                      onChange={(e) => {
                        let v = e.target.value.replace(/[^0-9:]/g, "");
                        if (v.length === 2 && !v.includes(":")) v = v + ":";
                        if (v.length > 5) v = v.slice(0, 5);
                        setTimes((p) => ({ ...p, [key]: v }));
                      }}
                      style={{ ...st.timeInput, borderColor: times[key]?.length === 5 ? "#86efac" : "#fca5a5" }} />
                  </div>
                ))}
              </div>
              {!d.isDone && (
                <p style={st.warnLine}>⚠️ ยังกรอกเวลาไม่ครบ — โน้ตแบบนี้ต้องมีเวลาสแกนถึงจะส่งคำขอได้</p>
              )}
            </>
          )}

          {/^ออกระหว่างวัน/.test(note) && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input type="text" inputMode="decimal" placeholder="หักเพิ่ม (บาท)" value={extraDeduct}
                onChange={(e) => setExtraDeduct(e.target.value.replace(/[^0-9.]/g, ""))}
                style={{ ...st.input, width: 120, marginBottom: 0, textAlign: "right", fontWeight: 700 }} />
              <input type="text" placeholder="เหตุผลการหัก" value={extraNote}
                onChange={(e) => setExtraNote(e.target.value)} style={{ ...st.input, flex: 1, marginBottom: 0 }} />
            </div>
          )}

          <div style={st.impactBox}>
            <b>💰 ผลกระทบต่อเงิน</b>
            <div style={{ marginTop: 3 }}>{impact}</div>
            <div style={{ marginTop: 3, color: "#92400e", fontSize: 11 }}>
              ยังไม่รวมผลต่อ ปกส. และยอดสุทธิทั้งเดือน — ต้องกด “คำนวณ + บันทึก” ใหม่หลังอนุมัติ
            </div>
          </div>

          <label style={st.label}>เหตุผลที่ขอแก้ <span style={{ color: "#dc2626" }}>*</span></label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
            placeholder="เช่น พนักงานเอาใบรับรองแพทย์มาให้ย้อนหลังวันนี้"
            style={{ ...st.input, resize: "vertical" }} />

          <label style={st.label}>ไฟล์หลักฐาน <span style={{ color: "#dc2626" }}>*</span></label>
          <label style={st.fileZone}>
            <input type="file" accept="image/*,application/pdf" style={{ display: "none" }}
              onChange={(e) => setFile(e.target.files[0] || null)} />
            {file ? `✅ ${file.name}` : "📎 แตะเพื่อแนบรูปใบรับรอง / เอกสาร"}
          </label>

          {msg && (
            <div style={{ ...st.msg, background: msg.type === "ok" ? "#f0fdf4" : "#fef2f2",
              color: msg.type === "ok" ? "#166534" : "#991b1b" }}>{msg.text}</div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={send} disabled={!canSend}
              style={{ ...st.primaryBtn, background: canSend ? "#b45309" : "#cbd5e1", cursor: canSend ? "pointer" : "not-allowed" }}>
              {busy ? "⏳ กำลังส่ง..." : "📨 ส่งคำขอให้เจ้าของอนุมัติ"}
            </button>
            <button onClick={onClose} style={st.ghostBtn}>ยกเลิก</button>
          </div>
          {!canSend && !busy && (
            <p style={{ margin: "6px 0 0", fontSize: 11, color: "#94a3b8" }}>
              ต้องมีครบ: เปลี่ยนแปลงจากเดิม · เหตุผลอย่างน้อย 5 ตัวอักษร · ไฟล์แนบ
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// ② แถบคำขอที่ค้างอยู่ (เจ้าของกดอนุมัติได้ · HR เห็นสถานะ)
// ══════════════════════════════════════════════
export function EditRequestBar({ role, refreshKey, onApplied }) {
  const [rows, setRows] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const { data, error } = await supabase
      .from("edit_requests")
      .select("*, employees(nickname, emp_code)")
      .eq("status", "pending")
      .order("requested_at", { ascending: false })
      .limit(50);
    if (!error) setRows(data || []);
  };
  useEffect(() => { load(); }, [refreshKey]);

  const viewEvidence = async (r) => {
    try {
      const url = await signedUrl(r.evidence_url);
      if (url) window.open(url, "_blank", "noopener");
    } catch (e) { setMsg({ type: "error", text: "เปิดไฟล์ไม่สำเร็จ: " + e.message }); }
  };

  const approve = async (r) => {
    const label = r.target_label || "รายการนี้";
    if (!window.confirm(`อนุมัติและแก้ให้เลยไหม?\n\n${label}\n${r.impact_note || ""}`)) return;
    setBusyId(r.id); setMsg(null);
    try {
      // ดึงแถวจริงมาคำนวณสาย/OT ด้วยกติกาเดียวกับหน้าแก้ไข (เผื่อข้อมูลเปลี่ยนหลังยื่นคำขอ)
      const { data: log, error: logErr } = await supabase
        .from("attendance_logs").select("*, employees(nickname, emp_code)").eq("id", r.target_id).maybeSingle();
      if (logErr) throw new Error(logErr.message);
      if (!log) throw new Error("ไม่พบแถวบันทึกเวลาที่ขอแก้");

      const nd = r.new_data || {};
      const d = deriveFromNote({
        note: nd.hr_note,
        times: {
          scan_am_in: nd.scan_am_in || "", scan_am_out: nd.scan_am_out || "",
          scan_pm_in: nd.scan_pm_in || "", scan_pm_out: nd.scan_pm_out || "",
        },
        empCode: log.employees?.emp_code,
        workDate: log.work_date,
      });

      const { data, error } = await supabase.rpc("apply_edit_request", {
        p_request_id: r.id,
        p_late_minutes: d.lateMinutes,
        p_ot_hours: d.otHours,
        p_clear_times: d.clearTimes,
        p_is_done: d.isDone,
        p_leave_type: d.leaveType,
        p_leave_half: d.leaveHalf,
        p_decide_note: null,
      });
      if (error) throw new Error(error.message);

      const back = Number(data?.returned_sick || 0) + Number(data?.returned_personal || 0);
      setMsg({ type: "ok", text:
        `✅ แก้ให้แล้ว — ${label}` +
        (back > 0 ? ` · คืนสิทธิ์ลาเดิม ${back} วัน` : "") +
        (d.leaveType ? " · ตัดสิทธิ์ลาใหม่ให้แล้ว" : "") +
        " · อย่าลืมกด “คำนวณ + บันทึก” ในแท็บเงินเดือน" });
      await load();
      onApplied?.();
    } catch (e) {
      setMsg({ type: "error", text: "❌ อนุมัติไม่สำเร็จ: " + (e.message || e) });
    } finally { setBusyId(null); }
  };

  const reject = async (r) => {
    const why = window.prompt(`ไม่อนุมัติ "${r.target_label}"\nเหตุผล (พิมพ์ให้ HR อ่าน):`, "");
    if (why === null) return;
    setBusyId(r.id); setMsg(null);
    const { error } = await supabase.from("edit_requests")
      .update({ status: "rejected", decided_by: role, decided_at: new Date().toISOString(), decide_note: why || null })
      .eq("id", r.id);
    if (error) setMsg({ type: "error", text: "❌ " + error.message });
    else { setMsg({ type: "ok", text: "ไม่อนุมัติแล้ว — แจ้ง HR ทาง Telegram เรียบร้อย" }); await load(); }
    setBusyId(null);
  };

  const cancel = async (r) => {
    if (!window.confirm("ยกเลิกคำขอนี้ไหม?")) return;
    setBusyId(r.id);
    const { error } = await supabase.from("edit_requests")
      .update({ status: "cancelled", decided_by: role, decided_at: new Date().toISOString() }).eq("id", r.id);
    if (error) setMsg({ type: "error", text: "❌ " + error.message });
    await load();
    setBusyId(null);
  };

  if (rows.length === 0 && !msg) return null;

  return (
    <div style={st.bar}>
      <div style={{ fontWeight: 700, color: "#92400e", fontSize: 14, marginBottom: rows.length ? 8 : 0 }}>
        🙋 คำขอแก้ไขที่รออนุมัติ ({rows.length})
      </div>
      {msg && (
        <div style={{ ...st.msg, marginBottom: 8,
          background: msg.type === "ok" ? "#f0fdf4" : "#fef2f2",
          color: msg.type === "ok" ? "#166534" : "#991b1b" }}>{msg.text}</div>
      )}
      {rows.map((r) => (
        <div key={r.id} style={st.reqCard}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#1e293b" }}>{r.target_label}</div>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>เหตุผล: {r.reason}</div>
            {r.impact_note && <div style={{ fontSize: 12, color: "#b45309", marginTop: 2 }}>💰 {r.impact_note}</div>}
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              ขอโดย {r.requested_by || "-"} · {new Date(r.requested_at).toLocaleString("th-TH")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {r.evidence_url && (
              <button onClick={() => viewEvidence(r)} style={st.ghostSmall}>📎 ดูหลักฐาน</button>
            )}
            {role === "owner" ? (
              <>
                <button onClick={() => approve(r)} disabled={busyId === r.id} style={st.okSmall}>
                  {busyId === r.id ? "⏳" : "✅ อนุมัติ"}
                </button>
                <button onClick={() => reject(r)} disabled={busyId === r.id} style={st.noSmall}>✖ ไม่อนุมัติ</button>
              </>
            ) : (
              <>
                <span style={st.waitTag}>⏳ รอเจ้าของอนุมัติ</span>
                <button onClick={() => cancel(r)} disabled={busyId === r.id} style={st.ghostSmall}>ยกเลิก</button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const st = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex",
    alignItems: "center", justifyContent: "center", zIndex: 1000 },
  modal: { background: "#fff", borderRadius: 16, width: 460, maxWidth: "92vw", maxHeight: "90vh",
    overflowY: "auto", WebkitOverflowScrolling: "touch", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px",
    borderRadius: "16px 16px 0 0", position: "sticky", top: 0, zIndex: 3 },
  closeBtn: { background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer", lineHeight: 1 },
  oldBox: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", marginBottom: 10 },
  label: { display: "block", fontSize: 12, color: "#64748b", fontWeight: 700, margin: "8px 0 4px" },
  input: { width: "100%", padding: "8px 10px", border: "1.5px solid #e2e8f0", borderRadius: 8,
    fontSize: 14, boxSizing: "border-box", marginBottom: 8 },
  timeInput: { width: "100%", padding: 7, boxSizing: "border-box", border: "2px solid #fca5a5",
    borderRadius: 8, fontSize: 16, textAlign: "center", letterSpacing: 1, fontWeight: 700 },
  preset: { padding: "5px 8px", borderRadius: 20, border: "1.5px solid #e2e8f0", background: "#f8fafc",
    cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#475569", textAlign: "center" },
  presetActive: { background: "#b45309", borderColor: "#b45309", color: "#fff" },
  impactBox: { background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 10px",
    fontSize: 12, color: "#78350f", margin: "8px 0" },
  warnLine: { margin: "0 0 8px", fontSize: 12, color: "#b91c1c", fontWeight: 600 },
  fileZone: { display: "block", border: "2px dashed #93c5fd", borderRadius: 10, padding: "12px",
    textAlign: "center", cursor: "pointer", background: "#eff6ff", fontSize: 13,
    color: "#1e40af", fontWeight: 600, marginBottom: 8 },
  msg: { padding: "8px 12px", borderRadius: 8, fontWeight: 600, fontSize: 13 },
  primaryBtn: { flex: 1, padding: 12, borderRadius: 10, border: "none", color: "#fff", fontWeight: 700, fontSize: 15 },
  ghostBtn: { padding: "12px 20px", borderRadius: 10, border: "1.5px solid #e2e8f0",
    background: "#f8fafc", cursor: "pointer", fontWeight: 600 },
  bar: { background: "#fffbeb", border: "1.5px solid #fde68a", borderRadius: 12, padding: "12px 14px", marginBottom: 12 },
  reqCard: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", background: "#fff",
    border: "1px solid #fde68a", borderRadius: 10, padding: "10px 12px", marginBottom: 8 },
  ghostSmall: { padding: "6px 12px", borderRadius: 8, border: "1.5px solid #e2e8f0", background: "#f8fafc",
    cursor: "pointer", fontSize: 12, fontWeight: 600 },
  okSmall: { padding: "6px 14px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff",
    cursor: "pointer", fontSize: 12, fontWeight: 700 },
  noSmall: { padding: "6px 12px", borderRadius: 8, border: "1.5px solid #fecaca", background: "#fef2f2",
    color: "#b91c1c", cursor: "pointer", fontSize: 12, fontWeight: 700 },
  waitTag: { padding: "6px 12px", borderRadius: 8, background: "#fef3c7", color: "#92400e",
    fontSize: 12, fontWeight: 700 },
};
