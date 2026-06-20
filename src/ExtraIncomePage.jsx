// src/ExtraIncomePage.jsx
// หน้าบันทึกรายได้พิเศษ — KMMH Payroll
// ทรงเดียวกับ DeductionsPage แต่โทนเขียว (รายได้ = เงินเข้า)
//
// 🔧 v2: เหลือ 2 ประเภทเท่านั้น
//   • ⏰ OT      → ดึงยอดจากระบบอัตโนมัติ (ตัวจริงของรอบจ่าย OT)
//   • ✏️ อื่นๆ   → พิมพ์เอง (โบนัส/ค่าพาหนะ/เงินรางวัล ที่เครื่องสแกนไม่รู้)
//   ── เอา "เงินประจำตำแหน่ง" ออก เพราะระบบคำนวณ+รวมในเงินเดือนให้แล้ว
//      (ตั้งค่าคงที่ในโปรไฟล์พนักงาน) — คีย์ที่นี่จะนับซ้ำ
//   ── เบี้ยขยันก็เช่นกัน: ระบบคิดเองจากการสแกน ไม่ต้องคีย์
// 🔧 v3: เพิ่มช่องค้นหา (ชื่อ / ประเภท / หมายเหตุ) กรองรายการในงวด
//
// เพิ่มแท็บใน App.jsx:
//   import ExtraIncomePage from "./ExtraIncomePage";
//   { id: "extra", label: "➕ รายได้พิเศษ" },
//   {activeTab === "extra" && <ExtraIncomePage role={role} />}

import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

const fmt = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// แปลงสตริงวันที่ "YYYY-MM-DD" (ค.ศ.) → "DD/MM/พ.ศ." (แสดงผลเท่านั้น — เก็บยังเป็น ค.ศ.)
const toBE = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
};

// ── โทนเขียว ──
const GREEN = "#16a34a";
const GREEN_DARK = "#15803d";
const GREEN_BG = "#f0fdf4";
const GREEN_BORDER = "#bbf7d0";

// ประเภทรายได้พิเศษ (เหลือ 2 แบบ)
const INCOME_TYPES = [
  { value: "ot",    label: "⏰ OT",    auto: true },
  { value: "other", label: "✏️ อื่นๆ", auto: false },
];

// รอบจ่าย (card ใหญ่ 2 อัน เหมือน CYCLE_OPTIONS ของ DeductionsPage)
const CYCLE_OPTIONS = [
  { value: "saturday",  label: "🗓 วันเสาร์",  desc: "จ่ายรอบเสาร์ถัดไปที่ยังไม่ปิด" },
  { value: "month_end", label: "📅 สิ้นเดือน", desc: "จ่ายตอนปิดงวดสิ้นเดือน" },
];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ExtraIncomePage({ role }) {
  const canEdit = role === "owner" || role === "hr";

  const [periods,   setPeriods]   = useState([]);
  const [periodId,  setPeriodId]  = useState("");
  const [employees, setEmployees] = useState([]);
  const [entries,   setEntries]   = useState([]); // รายการทุกคนในงวด
  const [loading,   setLoading]   = useState(false);
  const [query,     setQuery]     = useState("");   // 🔍 ค้นหา (ชื่อ/ประเภท/โน้ต)

  // cache ยอดจากระบบ ราย employee_id → {ot:{hours,amount}|null}
  const [sysCache, setSysCache] = useState({});
  const [nextCycle, setNextCycle] = useState(null);

  // ── form state เดียวรวม (เหมือน DeductionsPage) ──
  const [form, setForm] = useState({
    employee_id: "",
    income_type: "",
    amount:      "",
    label:       "",
    note:        "",
    entry_date:  todayStr(),
    disburse_on: "month_end",
    _systemAmount: null, // เก็บไว้เทียบว่า override ไหม
  });
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  // ── แก้ไข inline ──
  const [editRow,  setEditRow]  = useState(null);
  const [editVals, setEditVals] = useState({});

  function flash(text, type = "ok") {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 3000);
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
        .select("id, nickname, emp_code, emp_type, position_allowance")
        .eq("is_active", true)
        .order("emp_code");
      setEmployees(emps || []);
    })();
  }, []);

  // ── เมื่อเปลี่ยน period → โหลดรายการ + หา cycle เสาร์ถัดไป ──
  useEffect(() => {
    if (!periodId) return;
    loadEntries();
    (async () => {
      const { data: cyc } = await supabase
        .from("pay_cycles")
        .select("id, cycle_date, is_paid")
        .eq("period_id", periodId)
        .eq("is_paid", false)
        .order("cycle_date", { ascending: true })
        .limit(1);
      setNextCycle(cyc && cyc.length ? cyc[0] : null);
    })();
  }, [periodId]);

  async function loadEntries() {
    setLoading(true);
    const { data } = await supabase
      .from("extra_income_entries")
      .select("*")
      .eq("period_id", periodId)
      .order("created_at", { ascending: false });
    setEntries(data || []);
    setLoading(false);
  }

  // ── ดึงยอด OT จากระบบเมื่อเลือกคน ──
  async function fetchSystemAmount(empId) {
    if (sysCache[empId]?.ot !== undefined) return sysCache[empId].ot;
    const { data: pr } = await supabase
      .from("payroll_records")
      .select("ot_hours, ot_amount")
      .eq("employee_id", empId)
      .eq("period_id", periodId)
      .maybeSingle();
    const ot = pr ? { hours: pr.ot_hours, amount: Number(pr.ot_amount || 0) } : null;
    setSysCache((c) => ({ ...c, [empId]: { ...c[empId], ot } }));
    return ot;
  }

  // ── เมื่อเลือกคน หรือ ประเภท → auto-fill ยอด ──
  async function onPickEmployee(empId) {
    setForm((f) => ({ ...f, employee_id: empId }));
    if (empId && form.income_type) await applyAuto(empId, form.income_type);
  }
  async function onPickType(type) {
    setForm((f) => ({ ...f, income_type: type, label: type === "other" ? f.label : "" }));
    if (form.employee_id && type) await applyAuto(form.employee_id, type);
  }

  async function applyAuto(empId, type) {
    if (type !== "ot") {
      // อื่นๆ → ปล่อยให้พิมพ์เอง
      setForm((f) => ({ ...f, amount: "", note: "", _systemAmount: null }));
      return;
    }
    const sys = await fetchSystemAmount(empId);
    if (!sys) {
      setForm((f) => ({ ...f, amount: "", note: "", _systemAmount: null }));
      flash("ยังไม่มีข้อมูล OT เดือนนี้ (ต้องคำนวณเวลาก่อน)", "warn");
      return;
    }
    setForm((f) => ({ ...f, amount: String(sys.amount), note: `${sys.hours} ชม.`, _systemAmount: sys.amount }));
  }

  // ── บันทึก ──
  async function save() {
    if (!form.employee_id) return flash("เลือกพนักงานก่อน", "warn");
    if (!form.income_type) return flash("เลือกประเภทก่อน", "warn");
    if (form.income_type === "other" && !form.label.trim()) return flash("ใส่ชื่อรายการ", "warn");
    if (form.amount === "" || Number(form.amount) < 0) return flash("จำนวนเงินไม่ถูกต้อง", "warn");

    // กัน OT ซ้ำ
    if (form.income_type === "ot") {
      const dup = entries.some((e) => e.employee_id === form.employee_id && e.income_type === "ot");
      if (dup) return flash("มี OT ของคนนี้แล้วในเดือนนี้", "warn");
    }

    let cycleId = null;
    if (form.disburse_on === "saturday") {
      if (!nextCycle) return flash("ไม่มีรอบเสาร์ที่เปิดอยู่ — เลือกสิ้นเดือนแทน", "warn");
      cycleId = nextCycle.id;
    }

    const overridden =
      form.income_type === "ot" &&
      form._systemAmount !== null &&
      Number(form.amount) !== Number(form._systemAmount);

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("extra_income_entries").insert({
      employee_id: form.employee_id,
      period_id:   periodId,
      income_type: form.income_type,
      label:       form.income_type === "other" ? form.label.trim() : null,
      amount:      Number(form.amount),
      amount_note: form.note || null,
      disburse_on: form.disburse_on,
      cycle_id:    cycleId,
      is_overridden:   overridden,
      override_reason: overridden ? "แก้จากระบบ" : null,
      created_by:  user?.id || null,
      updated_at:  new Date().toISOString(),
    });
    setSaving(false);

    if (error) return flash("บันทึกไม่สำเร็จ: " + error.message, "err");
    flash("บันทึกแล้ว ✓");
    setForm({ employee_id: "", income_type: "", amount: "", label: "", note: "", entry_date: todayStr(), disburse_on: "month_end", _systemAmount: null });
    loadEntries();
  }

  // ── ลบ ──
  async function del(id) {
    if (!confirm("ลบรายการนี้?")) return;
    const { error } = await supabase.from("extra_income_entries").delete().eq("id", id);
    if (error) return flash("ลบไม่สำเร็จ: " + error.message, "err");
    flash("ลบแล้ว");
    loadEntries();
  }

  // ── แก้ไข inline ──
  function startEdit(e) {
    setEditRow(e.id);
    setEditVals({ amount: e.amount, label: e.label || "", note: e.amount_note || "", disburse_on: e.disburse_on || "month_end" });
  }
  async function saveEdit(e) {
    let cycleId = null;
    if (editVals.disburse_on === "saturday") {
      if (!nextCycle) return flash("ไม่มีรอบเสาร์ที่เปิดอยู่", "warn");
      cycleId = nextCycle.id;
    }
    const { error } = await supabase
      .from("extra_income_entries")
      .update({
        amount: Number(editVals.amount),
        label: e.income_type === "other" ? editVals.label : null,
        amount_note: editVals.note || null,
        disburse_on: editVals.disburse_on,
        cycle_id: cycleId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", e.id);
    if (error) return flash("แก้ไม่สำเร็จ: " + error.message, "err");
    setEditRow(null);
    flash("แก้แล้ว ✓");
    loadEntries();
  }

  // ── helper: ชื่อ/ประเภท ──
  const empMap = Object.fromEntries(employees.map((e) => [e.id, e]));

  const typeLabel = (e) =>
    e.income_type === "other" ? e.label : INCOME_TYPES.find((t) => t.value === e.income_type)?.label || e.income_type;

  // 🔍 ค้นหา — ชื่อพนักงาน / ประเภท / หมายเหตุ
  const q = query.trim().toLowerCase();
  const matchEntry = (e) => {
    if (!q) return true;
    const emp = empMap[e.employee_id];
    const typeName = INCOME_TYPES.find((t) => t.value === e.income_type)?.label || e.income_type;
    const hay = [emp?.nickname, emp?.emp_code, e.label, typeName, e.income_type, e.amount_note]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  };

  // ── จัดกลุ่มรายการตามพนักงาน (กรองด้วยค้นหา) ──
  const grouped = {};
  for (const e of entries) {
    if (!matchEntry(e)) continue;
    if (!grouped[e.employee_id]) grouped[e.employee_id] = [];
    grouped[e.employee_id].push(e);
  }

  // ── UI ──
  return (
    <div style={S.wrap}>
      {msg && (
        <div style={{ ...S.toast, background: msg.type === "err" ? "#dc2626" : msg.type === "warn" ? "#d97706" : GREEN }}>
          {msg.text}
        </div>
      )}

      {/* ── ฟอร์มบันทึก ── */}
      {canEdit && (
        <div style={S.card}>
          <h3 style={S.cardTitle}>➕ บันทึกรายได้พิเศษ</h3>

          <div style={S.row2}>
            <div style={{ flex: 1 }}>
              <label style={S.lbl}>เดือน</label>
              <select style={S.select} value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>{p.month}/{p.year + 543} {p.is_closed ? "(ปิดแล้ว)" : ""}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={S.row2}>
            <div style={{ flex: 1 }}>
              <label style={S.lbl}>พนักงาน</label>
              <select style={S.select} value={form.employee_id} onChange={(e) => onPickEmployee(e.target.value)}>
                <option value="">— เลือกพนักงาน —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.emp_code} · {e.nickname}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.lbl}>ประเภทรายได้</label>
              <select style={S.select} value={form.income_type} onChange={(e) => onPickType(e.target.value)}>
                <option value="">— เลือกประเภท —</option>
                {INCOME_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* ── card toggle รอบจ่าย (2 อันใหญ่) ── */}
          <label style={{ ...S.lbl, textAlign: "center", display: "block", marginTop: 8 }}>จ่ายเมื่อไหร่</label>
          <div style={S.cycleRow}>
            {CYCLE_OPTIONS.map((c) => {
              const active = form.disburse_on === c.value;
              return (
                <div key={c.value}
                  style={{ ...S.cycleCard, ...(active ? { borderColor: GREEN, background: GREEN_BG } : {}) }}
                  onClick={() => setForm((f) => ({ ...f, disburse_on: c.value }))}>
                  <div style={{ fontWeight: 600, color: active ? GREEN_DARK : "#374151" }}>{c.label}</div>
                  <div style={S.cycleDesc}>{c.desc}</div>
                </div>
              );
            })}
          </div>
          {form.disburse_on === "saturday" && (
            <p style={S.hintCenter}>
              {nextCycle ? `→ จะจ่ายรอบเสาร์ ${toBE(nextCycle.cycle_date)}` : "⚠️ ไม่มีรอบเสาร์ที่เปิดอยู่"}
            </p>
          )}

          {/* ── ชื่อรายการ (เฉพาะ อื่นๆ) ── */}
          {form.income_type === "other" && (
            <div style={{ marginTop: 12 }}>
              <label style={S.lbl}>ชื่อรายการ</label>
              <input style={S.input} value={form.label} placeholder="เช่น โบนัส, ค่าพาหนะ"
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
          )}

          {/* ── จำนวนเงิน + วันที่ ── */}
          <div style={{ ...S.row2, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={S.lbl}>
                จำนวนเงิน (บาท)
                {form.income_type === "ot" && <span style={S.autoTag}>ดึงจากระบบ</span>}
              </label>
              <input style={S.input} type="number" value={form.amount} placeholder="0.00"
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
              {form.income_type === "ot" && form._systemAmount !== null && Number(form.amount) !== Number(form._systemAmount) && (
                <p style={S.warnSmall}>⚠️ แก้จากยอดระบบ ({fmt(form._systemAmount)} บ.)</p>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.lbl}>วันที่ทำรายการ</label>
              <input style={S.input} type="date" value={form.entry_date}
                onChange={(e) => setForm((f) => ({ ...f, entry_date: e.target.value }))} />
              {form.entry_date && <div style={S.beHint}>= {toBE(form.entry_date)} (พ.ศ.)</div>}
            </div>
          </div>

          {/* ── หมายเหตุ ── */}
          <div style={{ marginTop: 12 }}>
            <label style={S.lbl}>หมายเหตุ (ถ้ามี)</label>
            <input style={S.input} value={form.note} placeholder="เช่น OT พิเศษ / โบนัสประจำเดือน"
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          </div>

          <button style={S.saveBtn} disabled={saving} onClick={save}>
            {saving ? "กำลังบันทึก..." : "💾 บันทึกรายได้"}
          </button>
        </div>
      )}

      {/* ── รายการในงวด (จัดกลุ่มตามคน) ── */}
      <h3 style={S.listTitle}>💰 รายได้พิเศษในงวดนี้</h3>

      {/* ── 🔍 ช่องค้นหา ── */}
      <input type="text" value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="🔍 ค้นหา — ชื่อ / ประเภท / หมายเหตุ"
        style={S.searchInput} />

      {loading ? (
        <p style={S.hint}>กำลังโหลด...</p>
      ) : Object.keys(grouped).length === 0 ? (
        <p style={S.hint}>{q ? "ไม่พบรายการที่ค้นหา" : "ยังไม่มีรายได้พิเศษในงวดนี้"}</p>
      ) : (
        Object.entries(grouped).map(([empId, list]) => {
          const emp = empMap[empId];
          const sum = list.reduce((s, e) => s + Number(e.amount), 0);
          const hasUnassigned = list.some((e) => !e.disburse_on);
          return (
            <div key={empId} style={S.empGroup}>
              <div style={S.empHead}>
                <span style={{ fontWeight: 600 }}>{emp?.nickname} <span style={S.empCode}>{emp?.emp_code}</span></span>
                <span style={S.sumTag}>รวม {fmt(sum)} บาท</span>
              </div>
              {hasUnassigned && <div style={S.warnBanner}>⚠️ มีรายการที่ยังไม่กำหนดรอบจ่าย — จะไม่ขึ้นหน้าสรุป</div>}
              {list.map((e) =>
                editRow === e.id ? (
                  <div key={e.id} style={S.editCard}>
                    {e.income_type === "other" && (
                      <input style={S.editInput} value={editVals.label} placeholder="ชื่อรายการ"
                        onChange={(ev) => setEditVals({ ...editVals, label: ev.target.value })} />
                    )}
                    <input style={S.editInput} type="number" value={editVals.amount}
                      onChange={(ev) => setEditVals({ ...editVals, amount: ev.target.value })} />
                    <select style={S.editInput} value={editVals.disburse_on}
                      onChange={(ev) => setEditVals({ ...editVals, disburse_on: ev.target.value })}>
                      <option value="saturday">🗓 วันเสาร์</option>
                      <option value="month_end">📅 สิ้นเดือน</option>
                    </select>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={S.miniSave} onClick={() => saveEdit(e)}>✓</button>
                      <button style={S.miniCancel} onClick={() => setEditRow(null)}>✕</button>
                    </div>
                  </div>
                ) : (
                  <div key={e.id} style={S.entryRow}>
                    <span style={S.typePill}>{typeLabel(e)}</span>
                    <span style={S.entryAmt}>{fmt(e.amount)} บาท</span>
                    <span style={S.cyclePill}>
                      {e.disburse_on === "saturday" ? "🗓 เสาร์" : e.disburse_on === "month_end" ? "📅 สิ้นเดือน" : "⏳ ยังไม่กำหนด"}
                    </span>
                    {e.amount_note && <span style={S.entryNote}>{e.amount_note}</span>}
                    {e.is_overridden && <span style={S.overrideTag}>แก้แล้ว</span>}
                    {canEdit && (
                      <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                        <button style={S.editBtn} onClick={() => startEdit(e)}>✏️</button>
                        <button style={S.delBtn} onClick={() => del(e.id)}>🗑</button>
                      </span>
                    )}
                  </div>
                )
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Styles (โทนเขียว) ──
const S = {
  wrap: { maxWidth: 760, margin: "0 auto", padding: "1rem" },
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1.2rem", marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
  cardTitle: { textAlign: "center", color: GREEN_DARK, fontWeight: 700, fontSize: "1.1rem", marginBottom: 16 },
  row2: { display: "flex", gap: 12, marginBottom: 12 },
  lbl: { display: "block", fontSize: "0.8rem", color: "#6b7280", marginBottom: 4 },
  select: { width: "100%", padding: "0.55rem", borderRadius: 8, border: "1px solid #d1d5db", fontSize: "0.95rem", boxSizing: "border-box" },
  input: { width: "100%", padding: "0.55rem", borderRadius: 8, border: "1px solid #d1d5db", fontSize: "0.95rem", boxSizing: "border-box" },
  searchInput: { width: "100%", padding: "0.7rem 0.9rem", borderRadius: 10, border: "1px solid #d1d5db", fontSize: "0.95rem", boxSizing: "border-box", marginBottom: 12, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
  beHint: { fontSize: "0.72rem", color: "#9ca3af", marginTop: 4 },
  cycleRow: { display: "flex", gap: 12, marginTop: 6 },
  cycleCard: { flex: 1, border: "2px solid #e5e7eb", borderRadius: 10, padding: "0.8rem", cursor: "pointer", textAlign: "center", transition: "all 0.15s" },
  cycleDesc: { fontSize: "0.75rem", color: "#9ca3af", marginTop: 4 },
  hintCenter: { textAlign: "center", color: "#6b7280", fontSize: "0.8rem", marginTop: 8 },
  autoTag: { marginLeft: 8, fontSize: "0.7rem", background: "#dcfce7", color: GREEN_DARK, padding: "2px 6px", borderRadius: 4 },
  warnSmall: { color: "#dc2626", fontSize: "0.78rem", marginTop: 4 },
  saveBtn: { width: "100%", marginTop: 16, padding: "0.7rem", borderRadius: 8, border: "none", background: GREEN, color: "#fff", fontWeight: 700, fontSize: "1rem", cursor: "pointer" },
  listTitle: { color: GREEN_DARK, fontWeight: 700, fontSize: "1.05rem", marginBottom: 12 },
  hint: { color: "#9ca3af", textAlign: "center", padding: "1.5rem 0" },
  empGroup: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "0.8rem", marginBottom: 12 },
  empHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  empCode: { color: "#9ca3af", fontSize: "0.85rem", fontWeight: 400 },
  sumTag: { background: GREEN_BG, color: GREEN_DARK, fontWeight: 600, fontSize: "0.85rem", padding: "3px 10px", borderRadius: 12, border: "1px solid " + GREEN_BORDER },
  warnBanner: { background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", padding: "0.5rem 0.7rem", borderRadius: 6, fontSize: "0.8rem", marginBottom: 8 },
  entryRow: { display: "flex", alignItems: "center", gap: 8, padding: "0.5rem 0.2rem", borderTop: "1px solid #f3f4f6", flexWrap: "wrap" },
  typePill: { background: GREEN_BG, color: GREEN_DARK, fontSize: "0.82rem", padding: "2px 8px", borderRadius: 6, fontWeight: 600 },
  entryAmt: { fontWeight: 700, fontSize: "0.95rem", color: "#1f2937" },
  cyclePill: { fontSize: "0.78rem", color: "#6b7280", background: "#f3f4f6", padding: "2px 8px", borderRadius: 6 },
  entryNote: { fontSize: "0.8rem", color: "#9ca3af" },
  overrideTag: { fontSize: "0.7rem", background: "#fef3c7", color: "#b45309", padding: "2px 6px", borderRadius: 4 },
  editBtn: { border: "1px solid #d1d5db", background: "#fff", borderRadius: 6, padding: "2px 8px", cursor: "pointer" },
  delBtn: { border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 6, padding: "2px 8px", cursor: "pointer" },
  editCard: { display: "flex", gap: 6, alignItems: "center", padding: "0.5rem 0", borderTop: "1px solid #f3f4f6", flexWrap: "wrap" },
  editInput: { padding: "0.4rem", borderRadius: 6, border: "1px solid #d1d5db", fontSize: "0.85rem" },
  miniSave: { border: "none", background: GREEN, color: "#fff", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
  miniCancel: { border: "1px solid #d1d5db", background: "#fff", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
  toast: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", padding: "0.6rem 1.2rem", borderRadius: 8, color: "#fff", fontSize: "0.9rem", zIndex: 1000, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" },
};
