// ExtraIncomePage.jsx
// หน้าบันทึกรายได้พิเศษ (OT / เงินประจำตำแหน่ง / อื่นๆ) — KMMH Payroll
// วางที่ src/ExtraIncomePage.jsx
// เพิ่มแท็บใน App.jsx:
//   import ExtraIncomePage from "./ExtraIncomePage";
//   { id: "extra", label: "➕ รายได้พิเศษ" },
//   {activeTab === "extra" && <ExtraIncomePage role={role} />}

import { useState, useEffect } from "react";
import { supabase } from "./supabase"; // ← ปรับ path ตาม project

// ── Constants ────────────────────────────────────────────────────
const TYPE_CONFIG = {
  ot: {
    label: "OT",
    icon: "⏰",
    color: "#b45309", bg: "#fffbeb", border: "#fde68a",
    auto: true, // ดึงยอดจากระบบ
  },
  position_allowance: {
    label: "เงินประจำตำแหน่ง",
    icon: "🏅",
    color: "#0f766e", bg: "#f0fdfa", border: "#99f6e4",
    auto: true,
  },
  other: {
    label: "อื่นๆ",
    icon: "✏️",
    color: "#6d28d9", bg: "#faf5ff", border: "#e9d5ff",
    auto: false,
  },
};

const DISBURSE_OPTS = [
  { value: "saturday",  label: "💸 รอบเสาร์" },
  { value: "month_end", label: "📅 สิ้นเดือน" },
  { value: null,        label: "⏳ ยังไม่กำหนด" },
];

// ── Helpers ───────────────────────────────────────────────────────
function fmtBaht(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function disburseLabel(v) {
  const o = DISBURSE_OPTS.find((x) => x.value === v);
  return o ? o.label : "⏳ ยังไม่กำหนด";
}

// ── Component ─────────────────────────────────────────────────────
export default function ExtraIncomePage({ role }) {
  const canEdit = role === "owner" || role === "hr";

  const [periods, setPeriods] = useState([]);
  const [periodId, setPeriodId] = useState("");
  const [employees, setEmployees] = useState([]);
  const [empId, setEmpId] = useState("");

  const [entries, setEntries] = useState([]);   // รายการของคนที่เลือก
  const [otFromSystem, setOtFromSystem] = useState(null); // {hours, amount}
  const [posFromSystem, setPosFromSystem] = useState(0);  // ค่า default ประจำตำแหน่ง
  const [nextCycle, setNextCycle] = useState(null); // รอบเสาร์ถัดไปที่ยังไม่ปิด

  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  // form state สำหรับเพิ่มรายการ
  const [form, setForm] = useState(null); // {income_type, label, amount, disburse_on, is_overridden, override_reason}

  function showToast(msg, type = "ok") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  // ── โหลด periods + employees ครั้งแรก ──
  useEffect(() => {
    (async () => {
      const { data: pds } = await supabase
        .from("pay_periods")
        .select("id, year, month, is_closed")
        .order("year", { ascending: false })
        .order("month", { ascending: false });
      setPeriods(pds || []);
      if (pds && pds.length) setPeriodId(pds[0].id);

      const { data: emps } = await supabase
        .from("employees")
        .select("id, nickname, full_name, emp_code, emp_type, position_allowance")
        .eq("is_active", true)
        .order("emp_code");
      setEmployees(emps || []);
    })();
  }, []);

  // ── เมื่อเลือก period → หา cycle เสาร์ถัดไปที่ยังไม่ปิด ──
  useEffect(() => {
    if (!periodId) return;
    (async () => {
      const { data: cycles } = await supabase
        .from("pay_cycles")
        .select("id, cycle_date, is_paid")
        .eq("period_id", periodId)
        .eq("is_paid", false)
        .order("cycle_date", { ascending: true })
        .limit(1);
      setNextCycle(cycles && cycles.length ? cycles[0] : null);
    })();
  }, [periodId]);

  // ── เมื่อเลือกพนักงาน → โหลดรายการ + ยอดจากระบบ ──
  useEffect(() => {
    if (!empId || !periodId) {
      setEntries([]);
      setOtFromSystem(null);
      setPosFromSystem(0);
      return;
    }
    loadEmpData();
  }, [empId, periodId]);

  async function loadEmpData() {
    setLoading(true);

    // รายการที่บันทึกไว้แล้ว
    const { data: ents } = await supabase
      .from("extra_income_entries")
      .select("*")
      .eq("employee_id", empId)
      .eq("period_id", periodId)
      .order("created_at", { ascending: true });
    setEntries(ents || []);

    // ยอด OT จากระบบ (payroll_records)
    const { data: pr } = await supabase
      .from("payroll_records")
      .select("ot_hours, ot_amount")
      .eq("employee_id", empId)
      .eq("period_id", periodId)
      .maybeSingle();
    setOtFromSystem(pr ? { hours: pr.ot_hours, amount: pr.ot_amount } : null);

    // ค่า default เงินประจำตำแหน่ง
    const emp = employees.find((e) => e.id === empId);
    setPosFromSystem(emp ? Number(emp.position_allowance || 0) : 0);

    setLoading(false);
  }

  // ── เปิดฟอร์มตามประเภท ──
  function openForm(type) {
    // กัน OT / ประจำตำแหน่ง ซ้ำ
    if (type !== "other" && entries.some((e) => e.income_type === type)) {
      showToast(`มี${TYPE_CONFIG[type].label}ของคนนี้แล้วในเดือนนี้`, "warn");
      return;
    }

    let amount = 0, note = "";
    if (type === "ot") {
      if (!otFromSystem) {
        showToast("ยังไม่มีข้อมูล OT เดือนนี้ (ต้องคำนวณเวลาก่อน)", "warn");
        return;
      }
      amount = Number(otFromSystem.amount || 0);
      note = `${otFromSystem.hours} ชม.`;
    } else if (type === "position_allowance") {
      amount = posFromSystem;
      note = "ค่าประจำตำแหน่งตามที่ตั้งไว้";
    }

    setForm({
      income_type: type,
      label: type === "other" ? "" : TYPE_CONFIG[type].label,
      amount,
      amount_note: note,
      disburse_on: "month_end", // default สิ้นเดือน
      is_overridden: false,
      override_reason: "",
      _systemAmount: amount, // เก็บไว้เทียบว่าแก้หรือไม่
    });
  }

  // ── บันทึก ──
  async function saveEntry() {
    if (!form) return;
    if (form.income_type === "other" && !form.label.trim()) {
      showToast("กรุณาใส่ชื่อรายการ", "warn");
      return;
    }
    if (Number(form.amount) < 0) {
      showToast("จำนวนเงินต้องไม่ติดลบ", "warn");
      return;
    }

    // ถ้าเสาร์ → ผูก cycle ถัดไปที่ยังไม่ปิด
    let cycleId = null;
    if (form.disburse_on === "saturday") {
      if (!nextCycle) {
        showToast("ไม่มีรอบเสาร์ที่เปิดอยู่ — เลือกสิ้นเดือนแทน หรือเปิดรอบก่อน", "warn");
        return;
      }
      cycleId = nextCycle.id;
    }

    // เช็คว่า OT/ประจำตำแหน่ง ถูกแก้จากระบบไหม
    const overridden =
      form.income_type !== "other" &&
      Number(form.amount) !== Number(form._systemAmount);

    const { data: { user } } = await supabase.auth.getUser();

    const payload = {
      employee_id: empId,
      period_id: periodId,
      income_type: form.income_type,
      label: form.income_type === "other" ? form.label.trim() : null,
      amount: Number(form.amount),
      amount_note: form.amount_note || null,
      disburse_on: form.disburse_on,
      cycle_id: cycleId,
      is_overridden: overridden,
      override_reason: overridden ? (form.override_reason || "แก้จากระบบ") : null,
      created_by: user?.id || null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("extra_income_entries").insert(payload);
    if (error) {
      showToast("บันทึกไม่สำเร็จ: " + error.message, "err");
      return;
    }
    showToast("บันทึกแล้ว ✓");
    setForm(null);
    loadEmpData();
  }

  // ── ลบ ──
  async function deleteEntry(id) {
    if (!confirm("ลบรายการนี้?")) return;
    const { error } = await supabase.from("extra_income_entries").delete().eq("id", id);
    if (error) {
      showToast("ลบไม่สำเร็จ: " + error.message, "err");
      return;
    }
    showToast("ลบแล้ว");
    loadEmpData();
  }

  // ── เปลี่ยน toggle รอบจ่ายของรายการที่บันทึกแล้ว ──
  async function changeDisburse(entry, newVal) {
    let cycleId = null;
    if (newVal === "saturday") {
      if (!nextCycle) {
        showToast("ไม่มีรอบเสาร์ที่เปิดอยู่", "warn");
        return;
      }
      cycleId = nextCycle.id;
    }
    const { error } = await supabase
      .from("extra_income_entries")
      .update({ disburse_on: newVal, cycle_id: cycleId, updated_at: new Date().toISOString() })
      .eq("id", entry.id);
    if (error) {
      showToast("แก้ไม่สำเร็จ: " + error.message, "err");
      return;
    }
    loadEmpData();
  }

  const selectedEmp = employees.find((e) => e.id === empId);
  const hasUnassigned = entries.some((e) => !e.disburse_on);
  const totalAll = entries.reduce((s, e) => s + Number(e.amount), 0);

  // ── UI ────────────────────────────────────────────────────────
  return (
    <div style={S.wrap}>
      {toast && (
        <div style={{ ...S.toast, ...(toast.type === "err" ? S.toastErr : toast.type === "warn" ? S.toastWarn : S.toastOk) }}>
          {toast.msg}
        </div>
      )}

      <h2 style={S.title}>➕ รายได้พิเศษ</h2>

      {/* เลือก period + พนักงาน */}
      <div style={S.row}>
        <div style={{ flex: 1 }}>
          <label style={S.label}>เดือน</label>
          <select style={S.select} value={periodId} onChange={(e) => { setPeriodId(e.target.value); setEmpId(""); }}>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.month}/{p.year + 543} {p.is_closed ? "(ปิดแล้ว)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <label style={S.label}>พนักงาน</label>
          <select style={S.select} value={empId} onChange={(e) => setEmpId(e.target.value)}>
            <option value="">— เลือกพนักงาน —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.emp_code} · {e.nickname} ({e.emp_type === "permanent" ? "ประจำ" : "ทดลอง/รายวัน"})
              </option>
            ))}
          </select>
        </div>
      </div>

      {!empId && <p style={S.hint}>เลือกพนักงานเพื่อบันทึกรายได้พิเศษ</p>}

      {empId && (
        <>
          {/* ปุ่มเพิ่ม 3 ประเภท */}
          {canEdit && (
            <div style={S.btnRow}>
              {Object.entries(TYPE_CONFIG).map(([type, cfg]) => (
                <button
                  key={type}
                  style={{ ...S.typeBtn, color: cfg.color, background: cfg.bg, borderColor: cfg.border }}
                  onClick={() => openForm(type)}
                >
                  {cfg.icon} เพิ่ม{cfg.label}
                </button>
              ))}
            </div>
          )}

          {/* แสดงยอดจากระบบให้เห็นก่อน */}
          <div style={S.infoBox}>
            <span>📊 ยอดจากระบบ:</span>
            <span style={{ marginLeft: 8 }}>
              OT = {otFromSystem ? `${otFromSystem.hours} ชม. = ${fmtBaht(otFromSystem.amount)} บ.` : "ยังไม่มีข้อมูล"}
            </span>
            <span style={{ marginLeft: 16 }}>
              เงินประจำตำแหน่ง = {fmtBaht(posFromSystem)} บ.
            </span>
          </div>

          {/* ฟอร์มเพิ่ม */}
          {form && (
            <div style={S.formCard}>
              <div style={S.formHead}>
                {TYPE_CONFIG[form.income_type].icon} {TYPE_CONFIG[form.income_type].label}
              </div>

              {form.income_type === "other" && (
                <div style={S.field}>
                  <label style={S.label}>ชื่อรายการ</label>
                  <input style={S.input} value={form.label} placeholder="เช่น โบนัส, ค่าพาหนะ"
                    onChange={(e) => setForm({ ...form, label: e.target.value })} />
                </div>
              )}

              <div style={S.field}>
                <label style={S.label}>
                  จำนวนเงิน (บาท)
                  {form.income_type !== "other" && <span style={S.autoTag}>ดึงจากระบบ</span>}
                </label>
                <input style={S.input} type="number" value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                {form.income_type !== "other" && Number(form.amount) !== Number(form._systemAmount) && (
                  <p style={S.warnText}>⚠️ แก้ไขจากยอดระบบ ({fmtBaht(form._systemAmount)} บ.) — กรุณาระบุเหตุผล</p>
                )}
              </div>

              {form.income_type !== "other" && Number(form.amount) !== Number(form._systemAmount) && (
                <div style={S.field}>
                  <label style={S.label}>เหตุผลที่แก้</label>
                  <input style={S.input} value={form.override_reason} placeholder="เช่น OT พิเศษนอกระบบ"
                    onChange={(e) => setForm({ ...form, override_reason: e.target.value })} />
                </div>
              )}

              <div style={S.field}>
                <label style={S.label}>จ่ายรอบไหน</label>
                <div style={S.toggleRow}>
                  {DISBURSE_OPTS.map((o) => (
                    <button key={String(o.value)}
                      style={{ ...S.toggleBtn, ...(form.disburse_on === o.value ? S.toggleActive : {}) }}
                      onClick={() => setForm({ ...form, disburse_on: o.value })}>
                      {o.label}
                    </button>
                  ))}
                </div>
                {form.disburse_on === "saturday" && (
                  <p style={S.hint2}>
                    {nextCycle
                      ? `→ จะจ่ายรอบเสาร์ ${nextCycle.cycle_date}`
                      : "⚠️ ไม่มีรอบเสาร์ที่เปิดอยู่"}
                  </p>
                )}
              </div>

              <div style={S.formBtns}>
                <button style={S.saveBtn} onClick={saveEntry}>บันทึก</button>
                <button style={S.cancelBtn} onClick={() => setForm(null)}>ยกเลิก</button>
              </div>
            </div>
          )}

          {/* รายการที่บันทึกแล้ว */}
          {loading ? (
            <p style={S.hint}>กำลังโหลด...</p>
          ) : entries.length === 0 ? (
            <p style={S.hint}>ยังไม่มีรายได้พิเศษสำหรับ {selectedEmp?.nickname}</p>
          ) : (
            <div style={S.list}>
              {hasUnassigned && (
                <div style={S.warnBanner}>
                  ⚠️ มีรายการที่ยังไม่กำหนดรอบจ่าย — จะไม่ขึ้นในหน้าสรุปใดเลย
                </div>
              )}
              {entries.map((e) => {
                const cfg = TYPE_CONFIG[e.income_type];
                return (
                  <div key={e.id} style={{ ...S.entryCard, borderLeftColor: cfg.color }}>
                    <div style={S.entryMain}>
                      <div>
                        <span style={{ fontWeight: 600, color: cfg.color }}>
                          {cfg.icon} {e.income_type === "other" ? e.label : cfg.label}
                        </span>
                        {e.amount_note && <span style={S.entryNote}> · {e.amount_note}</span>}
                        {e.is_overridden && <span style={S.overrideTag}>แก้แล้ว</span>}
                      </div>
                      <div style={S.entryAmount}>{fmtBaht(e.amount)} บ.</div>
                    </div>
                    <div style={S.entryFoot}>
                      {canEdit ? (
                        <select style={S.miniSelect} value={e.disburse_on || ""}
                          onChange={(ev) => changeDisburse(e, ev.target.value || null)}>
                          {DISBURSE_OPTS.map((o) => (
                            <option key={String(o.value)} value={o.value || ""}>{o.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span style={S.disburseTag}>{disburseLabel(e.disburse_on)}</span>
                      )}
                      {canEdit && (
                        <button style={S.delBtn} onClick={() => deleteEntry(e.id)}>ลบ</button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div style={S.totalRow}>
                <span>รวมรายได้พิเศษ</span>
                <span style={{ fontWeight: 700 }}>{fmtBaht(totalAll)} บ.</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────
const S = {
  wrap: { padding: "1rem", maxWidth: 720, margin: "0 auto" },
  title: { fontSize: "1.3rem", fontWeight: 700, marginBottom: "1rem", color: "#1f2937" },
  row: { display: "flex", gap: 12, marginBottom: 16 },
  label: { display: "block", fontSize: "0.8rem", color: "#6b7280", marginBottom: 4 },
  select: { width: "100%", padding: "0.5rem", borderRadius: 8, border: "1px solid #d1d5db", fontSize: "0.95rem" },
  input: { width: "100%", padding: "0.5rem", borderRadius: 8, border: "1px solid #d1d5db", fontSize: "0.95rem", boxSizing: "border-box" },
  hint: { color: "#9ca3af", fontSize: "0.9rem", textAlign: "center", padding: "1.5rem 0" },
  hint2: { color: "#6b7280", fontSize: "0.8rem", marginTop: 6 },
  btnRow: { display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  typeBtn: { padding: "0.5rem 0.9rem", borderRadius: 8, border: "1px solid", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer" },
  infoBox: { background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.6rem 0.8rem", fontSize: "0.82rem", color: "#4b5563", marginBottom: 12, lineHeight: 1.6 },
  formCard: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
  formHead: { fontWeight: 700, fontSize: "1rem", marginBottom: 12 },
  field: { marginBottom: 12 },
  autoTag: { marginLeft: 8, fontSize: "0.7rem", background: "#fef3c7", color: "#b45309", padding: "2px 6px", borderRadius: 4 },
  warnText: { color: "#dc2626", fontSize: "0.78rem", marginTop: 4 },
  toggleRow: { display: "flex", gap: 6 },
  toggleBtn: { flex: 1, padding: "0.5rem", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: "0.85rem", cursor: "pointer", color: "#374151" },
  toggleActive: { background: "#1f2937", color: "#fff", borderColor: "#1f2937" },
  formBtns: { display: "flex", gap: 8, marginTop: 8 },
  saveBtn: { flex: 1, padding: "0.6rem", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", fontWeight: 600, cursor: "pointer" },
  cancelBtn: { flex: 1, padding: "0.6rem", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer" },
  list: { marginTop: 8 },
  warnBanner: { background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", padding: "0.6rem 0.8rem", borderRadius: 8, fontSize: "0.85rem", marginBottom: 10 },
  entryCard: { background: "#fff", border: "1px solid #e5e7eb", borderLeft: "4px solid", borderRadius: 8, padding: "0.7rem 0.9rem", marginBottom: 8 },
  entryMain: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  entryNote: { color: "#9ca3af", fontSize: "0.85rem" },
  entryAmount: { fontWeight: 700, fontSize: "1rem", color: "#1f2937" },
  overrideTag: { marginLeft: 8, fontSize: "0.7rem", background: "#fef3c7", color: "#b45309", padding: "2px 6px", borderRadius: 4 },
  entryFoot: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  miniSelect: { padding: "0.3rem 0.5rem", borderRadius: 6, border: "1px solid #d1d5db", fontSize: "0.82rem" },
  disburseTag: { fontSize: "0.82rem", color: "#6b7280" },
  delBtn: { padding: "0.3rem 0.7rem", borderRadius: 6, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontSize: "0.8rem", cursor: "pointer" },
  totalRow: { display: "flex", justifyContent: "space-between", padding: "0.7rem 0.9rem", background: "#f9fafb", borderRadius: 8, marginTop: 4, fontSize: "0.95rem" },
  toast: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", padding: "0.6rem 1.2rem", borderRadius: 8, color: "#fff", fontSize: "0.9rem", zIndex: 1000, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" },
  toastOk: { background: "#16a34a" },
  toastWarn: { background: "#d97706" },
  toastErr: { background: "#dc2626" },
};
