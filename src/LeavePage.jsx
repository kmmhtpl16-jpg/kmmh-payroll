// src/LeavePage.jsx
// ระบบบันทึกการลา / ขาดงาน — KMMH Payroll
// ตรรกะ: sick=30วัน/ปี(ทุกคน), personal=3วัน/ปี(ประจำเท่านั้น)
// ครึ่งวัน=ตัดสิทธิ์ 0.5, ค่าแรง 0.5 | รูปบังคับทั้ง sick+personal

import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

// ── สี theme (ม่วง ตาม payroll หลัก) ──
const C = {
  primary:   "#7c3aed",
  primaryLt: "#ede9fe",
  primaryDk: "#5b21b6",
  sick:      "#dc2626",   // แดง = ป่วย
  sickLt:    "#fef2f2",
  personal:  "#2563eb",   // น้ำเงิน = กิจ
  personalLt:"#eff6ff",
  absent:    "#6b7280",   // เทา = ขาด
  absentLt:  "#f9fafb",
  ok:        "#16a34a",
  okLt:      "#f0fdf4",
  warn:      "#d97706",
  warnLt:    "#fffbeb",
  border:    "#e5e7eb",
  text:      "#111827",
  muted:     "#6b7280",
};

const LEAVE_TYPES = [
  { value: "sick",     label: "🤒 ลาป่วย",  color: C.sick,     bg: C.sickLt,     needReceipt: true  },
  { value: "personal", label: "📋 ลากิจ",   color: C.personal,  bg: C.personalLt, needReceipt: true  },
  { value: "absent",   label: "❌ ขาดงาน", color: C.absent,    bg: C.absentLt,   needReceipt: false },
];

const UNITS = [
  { value: "day",  label: "เต็มวัน",   deduct: 1.0 },
  { value: "half", label: "ครึ่งวัน",  deduct: 0.5 },  // unit=day, hours=null, deduct=0.5
];

const YEAR = new Date().getFullYear() + 543; // พ.ศ. ปัจจุบัน

// ── helper: คำนวณโควต้า pro-rata ──
// p_start_date = วันที่เริ่มทำงาน (JS Date)
// quota = 30 หรือ 3
function calcProRataQuota(quota, startDate, year) {
  const yearStart = new Date(year - 543, 0, 1); // 1 ม.ค. ค.ศ.
  if (startDate <= yearStart) return quota; // คนเก่า = เต็ม
  // pro-rata: นับเดือนที่เหลือในปี (ปัดลง)
  const monthsLeft = 12 - startDate.getMonth(); // getMonth() = 0-based
  return Math.floor(quota * monthsLeft / 12);
}

// ── compress รูปก่อน upload ──
async function compressImage(file, maxKb = 400) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width, h = img.height;
        const maxDim = 1200;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => resolve(new File([blob], file.name, { type: "image/jpeg" })),
          "image/jpeg", 0.75);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── อ่านขนาดไฟล์ kb ──
function kbSize(file) { return Math.round(file.size / 1024); }

export default function LeavePage({ role }) {
  // ── state: form ──
  const [employees,   setEmployees]   = useState([]);
  const [selectedEmp, setSelectedEmp] = useState(null);   // employee object
  const [balance,     setBalance]     = useState(null);   // leave_balance row
  const [leaveType,   setLeaveType]   = useState("sick");
  const [leaveDate,   setLeaveDate]   = useState("");
  const [unit,        setUnit]        = useState("day");  // day | half
  const [note,        setNote]        = useState("");
  const [receiptFile, setReceiptFile] = useState(null);
  const [receiptPreview, setReceiptPreview] = useState(null);
  const fileRef = useRef();

  // ── state: UI ──
  const [saving,      setSaving]      = useState(false);
  const [msg,         setMsg]         = useState(null);   // {type:"ok"|"error"|"warn", text}
  const [records,     setRecords]     = useState([]);     // ประวัติของ selectedEmp
  const [loadingRec,  setLoadingRec]  = useState(false);
  const [activeTab,   setActiveTab]   = useState("form"); // form | history

  useEffect(() => { loadEmployees(); }, []);
  useEffect(() => {
    if (selectedEmp) { loadBalance(selectedEmp); loadRecords(selectedEmp); }
    else { setBalance(null); setRecords([]); }
  }, [selectedEmp]);

  // ── โหลดพนักงาน ──
  const loadEmployees = async () => {
    const { data } = await supabase
      .from("employees")
      .select("id, emp_code, nickname, full_name, emp_type, trial_start_date, permanent_start_date")
      .eq("is_active", true)
      .order("emp_code");
    if (data) setEmployees(data);
  };

  // ── โหลด leave_balance ──
  const loadBalance = async (emp) => {
    const currentYear = new Date().getFullYear();
    const { data } = await supabase
      .from("leave_balances")
      .select("*")
      .eq("employee_id", emp.id)
      .eq("year", currentYear)
      .maybeSingle();
    if (data) {
      setBalance(data);
    } else {
      // ยังไม่มี row → คำนวณจาก trial_start_date / permanent_start_date
      const startStr = emp.emp_type === "permanent"
        ? (emp.trial_start_date || emp.permanent_start_date)
        : emp.trial_start_date;
      const startDate = startStr ? new Date(startStr) : new Date(currentYear, 0, 1);
      const sickQ  = calcProRataQuota(20, startDate, YEAR);
      const persQ  = emp.emp_type === "permanent"
        ? calcProRataQuota(3, new Date(emp.permanent_start_date || startStr), YEAR)
        : 0; // ทดลองงาน = ไม่ได้ลากิจ
      setBalance({
        sick_quota: sickQ, sick_used: 0,
        personal_quota: persQ, personal_used: 0,
        _notInDb: true,
      });
    }
  };

  // ── โหลดประวัติการลาของ emp ──
  const loadRecords = async (emp) => {
    setLoadingRec(true);
    const currentYear = new Date().getFullYear();
    const from = `${currentYear}-01-01`;
    const to   = `${currentYear}-12-31`;
    const { data } = await supabase
      .from("leave_requests")
      .select("*")
      .eq("employee_id", emp.id)
      .gte("leave_date", from)
      .lte("leave_date", to)
      .order("leave_date", { ascending: false });
    setRecords(data || []);
    setLoadingRec(false);
  };

  // ── เลือกรูป ──
  const handleFile = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const compressed = await compressImage(f);
    setReceiptFile(compressed);
    const url = URL.createObjectURL(compressed);
    setReceiptPreview(url);
  };

  // ── เคลียร์ฟอร์ม ──
  const resetForm = () => {
    setLeaveDate("");
    setUnit("day");
    setNote("");
    setReceiptFile(null);
    setReceiptPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  // ── คำนวณ preview ผลที่จะเกิดขึ้น ──
  const deductDays = unit === "half" ? 0.5 : 1.0;
  const typeObj = LEAVE_TYPES.find(t => t.value === leaveType);
  const isPersonal = leaveType === "personal";
  const isSick     = leaveType === "sick";
  const isAbsent   = leaveType === "absent";
  const needsReceipt = typeObj?.needReceipt && !isAbsent;

  const sickRemain = balance ? balance.sick_quota - balance.sick_used : 0;
  const persRemain = balance ? balance.personal_quota - balance.personal_used : 0;

  let withinQuota = true;
  let overMsg = null;
  if (isSick) {
    withinQuota = sickRemain >= deductDays;
    if (!withinQuota) overMsg = `⚠️ เกินสิทธิ์ลาป่วย (คงเหลือ ${sickRemain} วัน) — วันนี้จะไม่ได้ค่าแรง`;
  } else if (isPersonal) {
    if (selectedEmp?.emp_type === "trial") {
      withinQuota = false;
      overMsg = "⚠️ พนักงานทดลองงานไม่มีสิทธิ์ลากิจ — วันนี้จะไม่ได้ค่าแรง";
    } else {
      withinQuota = persRemain >= deductDays;
      if (!withinQuota) overMsg = `⚠️ เกินสิทธิ์ลากิจ (คงเหลือ ${persRemain} วัน) — วันนี้จะไม่ได้ค่าแรง`;
    }
  } else if (isAbsent) {
    withinQuota = false;
    overMsg = "⚠️ ขาดงาน — ไม่ได้ค่าแรงวันนี้";
  }

  // ── บันทึก ──
  const handleSave = async () => {
    if (!selectedEmp)  { setMsg({ type:"error", text:"เลือกพนักงานก่อน" }); return; }
    if (!leaveDate)    { setMsg({ type:"error", text:"เลือกวันที่ลาก่อน" }); return; }
    if (needsReceipt && !receiptFile) {
      setMsg({ type:"error", text:"ต้องแนบเอกสาร/รูป (ป่วย/กิจ บังคับ)" }); return;
    }

    setSaving(true); setMsg(null);
    try {
      let receiptUrl = null;
      let receiptSizeKb = null;

      // ── upload รูป ──
      if (receiptFile) {
        const path = `leave/${selectedEmp.id}/${leaveDate}_${leaveType}_${Date.now()}.jpg`;
        const { error: upErr } = await supabase.storage
          .from("receipts")
          .upload(path, receiptFile, { upsert: false });
        if (upErr) throw new Error("อัปโหลดรูปไม่สำเร็จ: " + upErr.message);
        const { data: { publicUrl } } = supabase.storage.from("receipts").getPublicUrl(path);
        receiptUrl = publicUrl;
        receiptSizeKb = kbSize(receiptFile);
      }

      // ── insert leave_request ──
      const { error: insErr } = await supabase.from("leave_requests").insert({
        employee_id:    selectedEmp.id,
        leave_type:     leaveType,
        leave_date:     leaveDate,
        unit:           "day",          // schema ใช้ day/hour — half day = day + deduct_amount = 0.5×daily
        hours:          unit === "half" ? 4 : null,  // 4 ชม. = ครึ่งวัน
        is_within_quota: withinQuota,
        deduct_amount:  0,              // ระบบ A: หัก via work_days ไม่ใช่ deduct_amount
        receipt_url:    receiptUrl,
        receipt_size_kb: receiptSizeKb,
        note:           note || null,
      });
      if (insErr) throw new Error(insErr.message);

      // ── อัปเดต leave_balances ──
      if (!isAbsent) {
        const currentYear = new Date().getFullYear();
        const field = isSick ? "sick_used" : "personal_used";
        if (balance && !balance._notInDb) {
          // row มีอยู่แล้ว → increment
          const newUsed = (balance[field] || 0) + deductDays;
          await supabase.from("leave_balances")
            .update({ [field]: newUsed })
            .eq("employee_id", selectedEmp.id)
            .eq("year", currentYear);
        } else {
          // ยังไม่มี row → insert ใหม่
          const startStr = selectedEmp.emp_type === "permanent"
            ? (selectedEmp.trial_start_date || selectedEmp.permanent_start_date)
            : selectedEmp.trial_start_date;
          const startDate = startStr ? new Date(startStr) : new Date(currentYear, 0, 1);
          const sickQ = calcProRataQuota(20, startDate, YEAR);
          const persQ = selectedEmp.emp_type === "permanent"
            ? calcProRataQuota(3, new Date(selectedEmp.permanent_start_date || startStr), YEAR)
            : 0;
          await supabase.from("leave_balances").insert({
            employee_id:   selectedEmp.id,
            year:          currentYear,
            start_date:    startStr || `${currentYear}-01-01`,
            sick_quota:    sickQ,
            sick_used:     isSick ? deductDays : 0,
            personal_quota: persQ,
            personal_used: isPersonal ? deductDays : 0,
          });
        }
      }

      setMsg({ type:"ok", text:`✅ บันทึกแล้ว — ${selectedEmp.nickname} ${leaveDate} (${unit === "half" ? "ครึ่งวัน" : "เต็มวัน"})` });
      resetForm();
      loadBalance(selectedEmp);
      loadRecords(selectedEmp);

    } catch(e) {
      setMsg({ type:"error", text:"❌ " + e.message });
    } finally {
      setSaving(false);
    }
  };

  // ── ลบรายการ ──
  const handleDelete = async (rec) => {
    if (!window.confirm(`ลบรายการลา ${rec.leave_date} ของ ${selectedEmp?.nickname}?`)) return;
    const { error } = await supabase.from("leave_requests").delete().eq("id", rec.id);
    if (error) { alert("ลบไม่สำเร็จ: " + error.message); return; }
    // คืนสิทธิ์
    if (!isAbsent && balance && !balance._notInDb) {
      const field = rec.leave_type === "sick" ? "sick_used" : "personal_used";
      const amt   = rec.hours === 4 ? 0.5 : 1.0;
      const currentYear = new Date().getFullYear();
      const newUsed = Math.max(0, (balance[field] || 0) - amt);
      await supabase.from("leave_balances")
        .update({ [field]: newUsed })
        .eq("employee_id", selectedEmp.id)
        .eq("year", currentYear);
    }
    loadBalance(selectedEmp);
    loadRecords(selectedEmp);
  };

  const typeColor = (t) => LEAVE_TYPES.find(x => x.value === t)?.color || C.muted;
  const typeBg    = (t) => LEAVE_TYPES.find(x => x.value === t)?.bg    || "#f9fafb";
  const typeLabel = (t) => LEAVE_TYPES.find(x => x.value === t)?.label || t;

  return (
    <div style={{ maxWidth:960, margin:"0 auto" }}>
      {/* ── Header ── */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
        <div style={{ width:40, height:40, borderRadius:10,
          background:C.primary, display:"flex", alignItems:"center",
          justifyContent:"center", fontSize:20 }}>📋</div>
        <div>
          <h2 style={{ margin:0, fontSize:18, fontWeight:800, color:C.text }}>บันทึกการลา</h2>
          <p style={{ margin:0, fontSize:12, color:C.muted }}>ลาป่วย / ลากิจ / ขาดงาน — ตัดสิทธิ์อัตโนมัติ</p>
        </div>
      </div>

      {/* ── เลือกพนักงาน ── */}
      <div style={card}>
        <label style={labelStyle}>👤 พนักงาน</label>
        <select
          value={selectedEmp?.id || ""}
          onChange={e => {
            const emp = employees.find(x => x.id === e.target.value) || null;
            setSelectedEmp(emp);
            setMsg(null);
            resetForm();
            setActiveTab("form");
          }}
          style={selectStyle}>
          <option value="">— เลือกพนักงาน —</option>
          {employees.map(e => (
            <option key={e.id} value={e.id}>
              {e.emp_code} · {e.nickname} ({e.emp_type === "permanent" ? "ประจำ" : "ทดลองงาน"})
            </option>
          ))}
        </select>

        {/* สิทธิ์คงเหลือ */}
        {selectedEmp && balance && (
          <div style={{ display:"flex", gap:10, marginTop:12, flexWrap:"wrap" }}>
            <QuotaChip
              label="ลาป่วยคงเหลือ"
              used={balance.sick_used}
              quota={balance.sick_quota}
              color={C.sick}
              bg={C.sickLt}
            />
            {selectedEmp.emp_type === "permanent" ? (
              <QuotaChip
                label="ลากิจคงเหลือ"
                used={balance.personal_used}
                quota={balance.personal_quota}
                color={C.personal}
                bg={C.personalLt}
              />
            ) : (
              <div style={{ ...chip, background:"#f3f4f6", color:C.muted }}>
                🚫 ทดลองงาน — ไม่มีสิทธิ์ลากิจ
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      {selectedEmp && (
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          {[["form","📝 บันทึกการลา"], ["history","📋 ประวัติ"]].map(([id, label]) => (
            <button key={id} onClick={() => setActiveTab(id)}
              style={{ padding:"8px 18px", borderRadius:8,
                border:`1.5px solid ${activeTab===id ? C.primary : C.border}`,
                background: activeTab===id ? C.primaryLt : "#fff",
                color: activeTab===id ? C.primaryDk : C.muted,
                fontWeight:700, fontSize:14, cursor:"pointer" }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ════ TAB: FORM ════ */}
      {activeTab === "form" && selectedEmp && (
        <div style={card}>
          {/* ── ประเภทการลา ── */}
          <div style={{ marginBottom:16 }}>
            <label style={labelStyle}>ประเภทการลา</label>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:6 }}>
              {LEAVE_TYPES.map(t => (
                <button key={t.value}
                  onClick={() => { setLeaveType(t.value); setMsg(null); }}
                  style={{
                    padding:"10px 18px", borderRadius:10, cursor:"pointer",
                    border:`2px solid ${leaveType===t.value ? t.color : C.border}`,
                    background: leaveType===t.value ? t.bg : "#fff",
                    color: leaveType===t.value ? t.color : C.muted,
                    fontWeight:700, fontSize:14, transition:"all 0.15s",
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── วันที่ + เต็มวัน/ครึ่งวัน ── */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
            <div>
              <label style={labelStyle}>📅 วันที่ลา</label>
              <input type="date" value={leaveDate}
                onChange={e => { setLeaveDate(e.target.value); setMsg(null); }}
                style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>⏱ ระยะเวลา</label>
              <div style={{ display:"flex", gap:8, marginTop:6 }}>
                {UNITS.map(u => (
                  <button key={u.value}
                    onClick={() => setUnit(u.value)}
                    style={{
                      flex:1, padding:"10px 0", borderRadius:10, cursor:"pointer",
                      border:`2px solid ${unit===u.value ? C.primary : C.border}`,
                      background: unit===u.value ? C.primaryLt : "#fff",
                      color: unit===u.value ? C.primaryDk : C.muted,
                      fontWeight:700, fontSize:14,
                    }}>
                    {u.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── เตือนเกินสิทธิ์ ── */}
          {overMsg && (
            <div style={{ padding:"10px 14px", borderRadius:8, marginBottom:14,
              background: C.warnLt, border:`1px solid #fcd34d`,
              color: C.warn, fontWeight:600, fontSize:13 }}>
              {overMsg}
            </div>
          )}

          {/* ── แนบรูป/เอกสาร ── */}
          {!isAbsent && (
            <div style={{ marginBottom:16 }}>
              <label style={labelStyle}>
                📎 เอกสาร/รูป
                {needsReceipt
                  ? <span style={{ color:C.sick, marginLeft:4 }}>(บังคับ)</span>
                  : <span style={{ color:C.muted, marginLeft:4 }}>(ไม่บังคับ)</span>
                }
              </label>
              <label style={{
                display:"flex", alignItems:"center", gap:10, marginTop:6,
                border:`2px dashed ${receiptFile ? C.ok : (needsReceipt ? C.sick : C.border)}`,
                borderRadius:10, padding:"14px 16px", cursor:"pointer",
                background: receiptFile ? C.okLt : "#fafafa",
              }}>
                <input ref={fileRef} type="file" accept="image/*,application/pdf"
                  onChange={handleFile} style={{ display:"none" }} />
                <span style={{ fontSize:24 }}>{receiptFile ? "✅" : "📷"}</span>
                <div>
                  <p style={{ margin:0, fontWeight:700, fontSize:14,
                    color: receiptFile ? C.ok : C.muted }}>
                    {receiptFile ? receiptFile.name : "แตะเพื่อเลือกรูป/เอกสาร"}
                  </p>
                  {receiptFile && (
                    <p style={{ margin:0, fontSize:12, color:C.muted }}>
                      ขนาด {kbSize(receiptFile)} KB · บีบอัดแล้ว
                    </p>
                  )}
                </div>
                {receiptFile && (
                  <button onClick={(e) => {
                    e.preventDefault();
                    setReceiptFile(null); setReceiptPreview(null);
                    if (fileRef.current) fileRef.current.value = "";
                  }} style={{ marginLeft:"auto", background:"none", border:"none",
                    color:C.sick, fontSize:18, cursor:"pointer" }}>✕</button>
                )}
              </label>

              {/* preview */}
              {receiptPreview && (
                <div style={{ marginTop:8, borderRadius:8, overflow:"hidden",
                  border:`1px solid ${C.border}`, maxHeight:200 }}>
                  <img src={receiptPreview} alt="preview"
                    style={{ width:"100%", height:200, objectFit:"cover" }} />
                </div>
              )}
            </div>
          )}

          {/* ── หมายเหตุ ── */}
          <div style={{ marginBottom:16 }}>
            <label style={labelStyle}>💬 หมายเหตุ (ไม่บังคับ)</label>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              rows={2} placeholder="เช่น ไข้หวัด / ธุระครอบครัว"
              style={{ ...inputStyle, resize:"vertical", marginTop:6 }} />
          </div>

          {/* ── สรุปที่จะบันทึก ── */}
          {leaveDate && (
            <div style={{ padding:"12px 14px", borderRadius:10,
              background: withinQuota ? C.okLt : C.warnLt,
              border:`1px solid ${withinQuota ? "#86efac" : "#fcd34d"}`,
              marginBottom:14, fontSize:13 }}>
              <p style={{ margin:0, fontWeight:700,
                color: withinQuota ? C.ok : C.warn }}>
                📊 สรุปที่จะบันทึก
              </p>
              <p style={{ margin:"4px 0 0", color:C.text }}>
                {selectedEmp.nickname} · {leaveDate} ·{" "}
                {unit === "half" ? "ครึ่งวัน (4 ชม.)" : "เต็มวัน"} ·{" "}
                {typeLabel(leaveType)} ·{" "}
                {withinQuota
                  ? <span style={{ color:C.ok, fontWeight:700 }}>ในสิทธิ์ ✓ ได้ค่าแรง</span>
                  : <span style={{ color:C.warn, fontWeight:700 }}>เกินสิทธิ์ ✗ ไม่ได้ค่าแรง</span>
                }
              </p>
              {!isAbsent && (
                <p style={{ margin:"2px 0 0", color:C.muted, fontSize:12 }}>
                  ตัดสิทธิ์ {deductDays} วัน
                </p>
              )}
            </div>
          )}

          {/* ── msg ── */}
          {msg && (
            <div style={{ padding:"10px 14px", borderRadius:8, marginBottom:12,
              background: msg.type==="ok" ? C.okLt : msg.type==="warn" ? C.warnLt : "#fef2f2",
              color: msg.type==="ok" ? C.ok : msg.type==="warn" ? C.warn : "#dc2626",
              fontWeight:600, fontSize:13, border:`1px solid ${msg.type==="ok"?"#86efac":msg.type==="warn"?"#fcd34d":"#fca5a5"}` }}>
              {msg.text}
            </div>
          )}

          <button onClick={handleSave} disabled={saving}
            style={{ width:"100%", padding:14, borderRadius:10, border:"none",
              background: saving ? "#a78bfa" : C.primary,
              color:"#fff", fontWeight:800, fontSize:16,
              cursor: saving ? "not-allowed" : "pointer" }}>
            {saving ? "⏳ กำลังบันทึก..." : "💾 บันทึกการลา"}
          </button>
        </div>
      )}

      {/* ════ TAB: HISTORY ════ */}
      {activeTab === "history" && selectedEmp && (
        <div style={card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <h3 style={{ margin:0, fontSize:15, fontWeight:800 }}>
              ประวัติการลา {YEAR} — {selectedEmp.nickname}
            </h3>
            <button onClick={() => loadRecords(selectedEmp)}
              style={{ padding:"6px 14px", borderRadius:8,
                border:`1px solid ${C.border}`, background:"#f8fafc",
                cursor:"pointer", fontSize:13 }}>
              🔄 โหลดใหม่
            </button>
          </div>

          {loadingRec && <p style={{ color:C.muted }}>กำลังโหลด...</p>}
          {!loadingRec && records.length === 0 && (
            <p style={{ color:"#9ca3af", textAlign:"center", padding:32 }}>
              🎉 ยังไม่มีรายการลาในปีนี้
            </p>
          )}

          {records.map(r => {
            const isHalf = r.hours === 4;
            return (
              <div key={r.id} style={{
                display:"flex", justifyContent:"space-between", alignItems:"center",
                padding:"12px 14px", borderRadius:10, marginBottom:8,
                background: typeBg(r.leave_type),
                border:`1.5px solid ${typeColor(r.leave_type)}30`,
              }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                    <span style={{ fontWeight:700, fontSize:14,
                      color: typeColor(r.leave_type) }}>
                      {typeLabel(r.leave_type)}
                    </span>
                    <span style={{ fontWeight:700, fontSize:14, color:C.text }}>
                      {r.leave_date}
                    </span>
                    <span style={{ fontSize:12, padding:"1px 8px", borderRadius:10,
                      background: isHalf ? "#dbeafe" : "#e0e7ff",
                      color: isHalf ? C.personal : C.primaryDk }}>
                      {isHalf ? "ครึ่งวัน" : "เต็มวัน"}
                    </span>
                    <span style={{ fontSize:12, padding:"1px 8px", borderRadius:10,
                      background: r.is_within_quota ? C.okLt : C.warnLt,
                      color: r.is_within_quota ? C.ok : C.warn }}>
                      {r.is_within_quota ? "✓ ในสิทธิ์" : "✗ เกินสิทธิ์"}
                    </span>
                  </div>
                  {r.note && (
                    <p style={{ margin:"4px 0 0", fontSize:12, color:C.muted }}>
                      {r.note}
                    </p>
                  )}
                  {r.receipt_url && (
                    <a href={r.receipt_url} target="_blank" rel="noreferrer"
                      style={{ fontSize:12, color:C.personal, textDecoration:"underline" }}>
                      📎 ดูเอกสาร
                    </a>
                  )}
                </div>
                {role === "owner" && (
                  <button onClick={() => handleDelete(r)}
                    style={{ background:"#fef2f2", border:"1px solid #fecaca",
                      color:"#dc2626", borderRadius:8, padding:"6px 10px",
                      cursor:"pointer", fontSize:16, flexShrink:0 }}>
                    🗑
                  </button>
                )}
              </div>
            );
          })}

          {/* สรุปท้าย */}
          {records.length > 0 && balance && (
            <div style={{ marginTop:16, padding:"12px 14px", borderRadius:10,
              background:"#f8fafc", border:`1px solid ${C.border}` }}>
              <p style={{ margin:0, fontWeight:700, fontSize:13, color:C.text, marginBottom:8 }}>
                📊 สรุปสิทธิ์ปี {YEAR}
              </p>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                <QuotaChip label="ลาป่วย" used={balance.sick_used} quota={balance.sick_quota} color={C.sick} bg={C.sickLt} />
                {selectedEmp.emp_type === "permanent" && (
                  <QuotaChip label="ลากิจ" used={balance.personal_used} quota={balance.personal_quota} color={C.personal} bg={C.personalLt} />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* placeholder ก่อนเลือกพนักงาน */}
      {!selectedEmp && (
        <div style={{ textAlign:"center", padding:"48px 24px", color:C.muted }}>
          <div style={{ fontSize:48, marginBottom:12 }}>👆</div>
          <p style={{ margin:0, fontWeight:600 }}>เลือกพนักงานก่อนบันทึกการลา</p>
        </div>
      )}
    </div>
  );
}

// ── Quota Chip Component ──
function QuotaChip({ label, used, quota, color, bg }) {
  const remain = quota - used;
  const pct = quota > 0 ? Math.min(used / quota, 1) : 0;
  return (
    <div style={{ ...chip, background: bg, color, minWidth:160 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
        <span style={{ fontWeight:700, fontSize:13 }}>{label}</span>
        <span style={{ fontSize:13, fontWeight:700 }}>
          {remain} / {quota} วัน
        </span>
      </div>
      <div style={{ height:4, borderRadius:4, background:`${color}20`, overflow:"hidden" }}>
        <div style={{ height:"100%", borderRadius:4,
          width:`${pct * 100}%`, background: color,
          transition:"width 0.4s" }} />
      </div>
      <p style={{ margin:"3px 0 0", fontSize:11, color }}>
        ใช้ไป {used} วัน
      </p>
    </div>
  );
}

// ── shared styles ──
const card = {
  background:"#fff", borderRadius:12, padding:16,
  boxShadow:"0 1px 4px rgba(0,0,0,0.08)", marginBottom:12,
};
const labelStyle = {
  display:"block", fontSize:13, color:C.muted,
  fontWeight:700, marginBottom:4,
};
const inputStyle = {
  width:"100%", padding:"10px 12px", border:`1.5px solid ${C.border}`,
  borderRadius:8, fontSize:14, boxSizing:"border-box",
  fontFamily:"inherit",
};
const selectStyle = {
  ...inputStyle, background:"#fff", cursor:"pointer",
};
const chip = {
  padding:"8px 12px", borderRadius:10,
  border:`1px solid currentColor`, fontSize:13,
};
