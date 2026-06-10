import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

// ── helpers ────────────────────────────────────────────────────
function fmtMoney(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString("th-TH", { day: "2-digit", month: "short", year: "2-digit" });
}
function monthLabel(y, m) {
  const names = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${names[m - 1]} ${y + 543}`;
}

// สร้าง list เดือน ตั้งแต่ fromDate ถึงปัจจุบัน
function monthsBetween(fromDateStr) {
  if (!fromDateStr) return [];
  const start = new Date(fromDateStr);
  start.setDate(1);
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const months = [];
  let cur = new Date(start);
  while (cur <= end) {
    months.push({ year: cur.getFullYear(), month: cur.getMonth() + 1 });
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

// ── InsurancePage ──────────────────────────────────────────────
export default function InsurancePage({ role }) {
  const [employees, setEmployees] = useState([]);   // permanent ทุกคน
  const [balances, setBalances]   = useState({});   // { empId: number }
  const [history, setHistory]     = useState([]);   // ledger ทั้งหมด
  const [periods, setPeriods]     = useState([]);   // pay_periods

  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [msg, setMsg]             = useState(null); // {type:'ok'|'err', text}

  // modal state
  const [modal, setModal]         = useState(null);
  // modal types: 'backfill' | 'withdraw' | 'refund' | 'history'

  // selected employee for modal
  const [selEmp, setSelEmp]       = useState(null);

  // backfill form
  const [backfillFrom, setBackfillFrom] = useState(""); // YYYY-MM (permanent_start_date)
  const [backfillPreview, setBackfillPreview] = useState([]); // months to insert
  const [existingMonths, setExistingMonths]   = useState(new Set()); // "YYYY-M" ที่มีแล้ว

  // withdraw form
  const [wdAmount, setWdAmount]   = useState("");
  const [wdNote, setWdNote]       = useState("");

  // refund: ใช้ยอดทั้งหมด อัตโนมัติ

  // ── load ──────────────────────────────────────────────────────
  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      // permanent employees (รวมที่ลาออกแล้ว เพื่อดูประวัติได้)
      const { data: emps, error: e1 } = await supabase
        .from("employees")
        .select("id, emp_code, nickname, full_name, insurance_level, permanent_start_date, resigned_date")
        .eq("emp_type", "permanent")
        .neq("insurance_level", "none")
        .order("emp_code");
      if (e1) throw e1;

      // ledger ทั้งหมด
      const { data: ledger, error: e2 } = await supabase
        .from("insurance_ledger")
        .select("id, employee_id, entry_date, entry_type, amount, note, period_id")
        .order("entry_date", { ascending: false });
      if (e2) throw e2;

      // pay_periods
      const { data: pp, error: e3 } = await supabase
        .from("pay_periods")
        .select("id, year, month")
        .order("year").order("month");
      if (e3) throw e3;

      // คำนวณ balance รายคน
      const bal = {};
      (ledger || []).forEach(r => {
        bal[r.employee_id] = (bal[r.employee_id] || 0) + Number(r.amount);
      });

      setEmployees(emps || []);
      setBalances(bal);
      setHistory(ledger || []);
      setPeriods(pp || []);
    } catch (err) {
      showMsg("err", "โหลดข้อมูลไม่ได้: " + err.message);
    } finally {
      setLoading(false);
    }
  }

  function showMsg(type, text) {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  }

  // ── open modals ───────────────────────────────────────────────
  function openBackfill(emp) {
    setSelEmp(emp);
    // default from = permanent_start_date ของพนักงาน (format YYYY-MM)
    const fromStr = emp.permanent_start_date
      ? emp.permanent_start_date.slice(0, 7)
      : "";
    setBackfillFrom(fromStr);

    // หา existing deposits ของคนนี้
    const existing = new Set(
      history
        .filter(r => r.employee_id === emp.id && r.entry_type === "deposit")
        .map(r => {
          const d = new Date(r.entry_date);
          return `${d.getFullYear()}-${d.getMonth() + 1}`;
        })
    );
    setExistingMonths(existing);
    buildPreview(fromStr, existing, emp);
    setModal("backfill");
  }

  function buildPreview(fromStr, existing, emp) {
    if (!fromStr) { setBackfillPreview([]); return; }
    const months = monthsBetween(fromStr + "-01");
    const level = Number((emp || selEmp)?.insurance_level || 0);
    const preview = months.map(({ year, month }) => ({
      year, month,
      amount: level,
      alreadyExists: existing.has(`${year}-${month}`),
    }));
    setBackfillPreview(preview);
  }

  function openWithdraw(emp) {
    setSelEmp(emp);
    setWdAmount("");
    setWdNote("");
    setModal("withdraw");
  }

  function openRefund(emp) {
    setSelEmp(emp);
    setModal("refund");
  }

  function openHistory(emp) {
    setSelEmp(emp);
    setModal("history");
  }

  function closeModal() {
    setModal(null);
    setSelEmp(null);
    setBackfillPreview([]);
  }

  // ── save backfill ─────────────────────────────────────────────
  async function saveBackfill() {
    const toInsert = backfillPreview.filter(m => !m.alreadyExists);
    if (toInsert.length === 0) {
      showMsg("err", "ไม่มีเดือนใหม่ที่ต้องเพิ่ม");
      return;
    }

    // หา period_id จาก pay_periods (ถ้ามี)
    const periodMap = {};
    periods.forEach(p => { periodMap[`${p.year}-${p.month}`] = p.id; });

    const rows = toInsert.map(({ year, month, amount }) => ({
      employee_id: selEmp.id,
      entry_date: `${year}-${String(month).padStart(2, "0")}-01`,
      entry_type: "deposit",
      amount: amount,
      period_id: periodMap[`${year}-${month}`] || null,
      note: `เพิ่มย้อนหลัง ${monthLabel(year, month)}`,
    }));

    setSaving(true);
    try {
      const { error } = await supabase.from("insurance_ledger").insert(rows);
      if (error) throw error;
      showMsg("ok", `เพิ่ม ${toInsert.length} เดือนสำเร็จ`);
      closeModal();
      loadAll();
    } catch (err) {
      showMsg("err", "บันทึกไม่ได้: " + err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── save withdraw ─────────────────────────────────────────────
  async function saveWithdraw() {
    const amt = Number(wdAmount);
    const bal = balances[selEmp.id] || 0;
    if (!amt || amt <= 0) { showMsg("err", "ระบุจำนวนให้ถูกต้อง"); return; }
    if (amt > bal) { showMsg("err", `เบิกไม่ได้เกินยอดคงเหลือ (${fmtMoney(bal)} บ.)`); return; }

    setSaving(true);
    try {
      const { error } = await supabase.from("insurance_ledger").insert({
        employee_id: selEmp.id,
        entry_date: new Date().toISOString().slice(0, 10),
        entry_type: "withdraw",
        amount: -amt,
        method: "cash",
        note: wdNote || "เบิกเงินประกันงาน",
      });
      if (error) throw error;
      showMsg("ok", `บันทึกเบิก ${fmtMoney(amt)} บ. สำเร็จ`);
      closeModal();
      loadAll();
    } catch (err) {
      showMsg("err", "บันทึกไม่ได้: " + err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── save refund (ลาออก) ───────────────────────────────────────
  async function saveRefund() {
    const bal = balances[selEmp.id] || 0;
    if (bal <= 0) { showMsg("err", "ยอดกระปุกเป็น 0 แล้ว ไม่ต้องคืน"); return; }

    setSaving(true);
    try {
      const { error } = await supabase.from("insurance_ledger").insert({
        employee_id: selEmp.id,
        entry_date: new Date().toISOString().slice(0, 10),
        entry_type: "refund",
        amount: -bal,
        method: "cash",
        note: "คืนเงินประกันงานตอนลาออก",
      });
      if (error) throw error;
      showMsg("ok", `คืนเงิน ${fmtMoney(bal)} บ. สำเร็จ`);
      closeModal();
      loadAll();
    } catch (err) {
      showMsg("err", "บันทึกไม่ได้: " + err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── render ────────────────────────────────────────────────────
  const totalBalance = Object.values(balances).reduce((s, v) => s + v, 0);

  if (loading) return (
    <div className="ins-loading">
      <div className="ins-spinner" />
      <p>กำลังโหลด...</p>
    </div>
  );

  return (
    <div className="ins-page">

      {/* toast */}
      {msg && (
        <div className={`ins-toast ins-toast--${msg.type}`}>{msg.text}</div>
      )}

      {/* header */}
      <div className="ins-header">
        <div>
          <h2 className="ins-title">กระปุกประกันงาน</h2>
          <p className="ins-subtitle">หักเข้าทุกเดือน · เบิกได้ · คืนตอนลาออก</p>
        </div>
        <div className="ins-summary-box">
          <span className="ins-summary-label">ยอดรวมทั้งหมด</span>
          <span className="ins-summary-amount">฿{fmtMoney(totalBalance)}</span>
          <span className="ins-summary-count">{employees.length} คน</span>
        </div>
      </div>

      {/* table */}
      <div className="ins-table-wrap">
        <table className="ins-table">
          <thead>
            <tr>
              <th>รหัส</th>
              <th>ชื่อ</th>
              <th>ระดับ/เดือน</th>
              <th>เริ่มประจำ</th>
              <th className="ins-col-right">ยอดคงเหลือ</th>
              <th>สถานะ</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(emp => {
              const bal = balances[emp.id] || 0;
              const isResigned = !!emp.resigned_date;
              // คำนวณจำนวนเดือนที่ควรสะสม
              const allMonths = emp.permanent_start_date
                ? monthsBetween(emp.permanent_start_date)
                : [];
              const existingDeps = history.filter(
                r => r.employee_id === emp.id && r.entry_type === "deposit"
              ).length;
              const missing = allMonths.length - existingDeps;

              return (
                <tr key={emp.id} className={isResigned ? "ins-row--resigned" : ""}>
                  <td className="ins-code">{emp.emp_code}</td>
                  <td>
                    <span className="ins-name">{emp.nickname}</span>
                    {isResigned && <span className="ins-badge ins-badge--resigned">ลาออก</span>}
                  </td>
                  <td>
                    <span className="ins-level">฿{emp.insurance_level}/เดือน</span>
                  </td>
                  <td className="ins-date">{fmtDate(emp.permanent_start_date)}</td>
                  <td className="ins-col-right">
                    <span className={`ins-balance ${bal === 0 ? "ins-balance--zero" : ""}`}>
                      ฿{fmtMoney(bal)}
                    </span>
                  </td>
                  <td>
                    {missing > 0 && !isResigned && (
                      <span className="ins-badge ins-badge--warn">ขาด {missing} เดือน</span>
                    )}
                    {missing === 0 && !isResigned && (
                      <span className="ins-badge ins-badge--ok">ครบ</span>
                    )}
                    {isResigned && bal === 0 && (
                      <span className="ins-badge ins-badge--done">คืนแล้ว</span>
                    )}
                    {isResigned && bal > 0 && (
                      <span className="ins-badge ins-badge--warn">ค้างคืน</span>
                    )}
                  </td>
                  <td>
                    <div className="ins-actions">
                      <button className="ins-btn ins-btn--ghost" onClick={() => openHistory(emp)}>ประวัติ</button>
                      {!isResigned && (
                        <>
                          <button className="ins-btn ins-btn--primary" onClick={() => openBackfill(emp)}>+ เพิ่ม</button>
                          <button className="ins-btn ins-btn--secondary" onClick={() => openWithdraw(emp)}
                            disabled={bal <= 0}>เบิก</button>
                          <button className="ins-btn ins-btn--danger" onClick={() => openRefund(emp)}
                            disabled={bal <= 0}>คืน</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── MODAL BACKFILL ─────────────────────────────────────── */}
      {modal === "backfill" && selEmp && (
        <div className="ins-overlay" onClick={closeModal}>
          <div className="ins-modal" onClick={e => e.stopPropagation()}>
            <div className="ins-modal-header">
              <h3>เติมย้อนหลัง — {selEmp.nickname}</h3>
              <span className="ins-modal-sub">฿{selEmp.insurance_level}/เดือน</span>
            </div>

            <div className="ins-modal-body">
              <label className="ins-label">เริ่มตั้งแต่เดือน</label>
              <input
                type="month"
                className="ins-input"
                value={backfillFrom}
                onChange={e => {
                  setBackfillFrom(e.target.value);
                  buildPreview(e.target.value, existingMonths, selEmp);
                }}
              />

              {backfillPreview.length > 0 && (
                <div className="ins-preview">
                  <div className="ins-preview-header">
                    <span>รายการทั้งหมด {backfillPreview.length} เดือน</span>
                    <span className="ins-preview-new">
                      เพิ่มใหม่ {backfillPreview.filter(m => !m.alreadyExists).length} เดือน
                    </span>
                  </div>
                  <div className="ins-preview-list">
                    {backfillPreview.map(({ year, month, amount, alreadyExists }) => (
                      <div
                        key={`${year}-${month}`}
                        className={`ins-preview-row ${alreadyExists ? "ins-preview-row--exists" : ""}`}
                      >
                        <span>{monthLabel(year, month)}</span>
                        <span>฿{fmtMoney(amount)}</span>
                        {alreadyExists && <span className="ins-preview-tag">มีแล้ว</span>}
                      </div>
                    ))}
                  </div>
                  <div className="ins-preview-total">
                    รวมที่จะเพิ่ม: ฿{fmtMoney(
                      backfillPreview
                        .filter(m => !m.alreadyExists)
                        .reduce((s, m) => s + m.amount, 0)
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="ins-modal-footer">
              <button className="ins-btn ins-btn--ghost" onClick={closeModal}>ยกเลิก</button>
              <button
                className="ins-btn ins-btn--primary"
                onClick={saveBackfill}
                disabled={saving || backfillPreview.filter(m => !m.alreadyExists).length === 0}
              >
                {saving ? "กำลังบันทึก..." : `บันทึก ${backfillPreview.filter(m => !m.alreadyExists).length} เดือน`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL WITHDRAW ─────────────────────────────────────── */}
      {modal === "withdraw" && selEmp && (
        <div className="ins-overlay" onClick={closeModal}>
          <div className="ins-modal ins-modal--sm" onClick={e => e.stopPropagation()}>
            <div className="ins-modal-header">
              <h3>เบิกเงินประกันงาน — {selEmp.nickname}</h3>
              <span className="ins-modal-sub">ยอดคงเหลือ ฿{fmtMoney(balances[selEmp.id] || 0)}</span>
            </div>
            <div className="ins-modal-body">
              <label className="ins-label">จำนวนเงินที่เบิก (บาท)</label>
              <input
                type="number"
                className="ins-input"
                placeholder="0"
                value={wdAmount}
                onChange={e => setWdAmount(e.target.value)}
                min="1"
                max={balances[selEmp.id] || 0}
              />
              <label className="ins-label" style={{ marginTop: 12 }}>หมายเหตุ</label>
              <input
                type="text"
                className="ins-input"
                placeholder="เช่น เบิกปีใหม่"
                value={wdNote}
                onChange={e => setWdNote(e.target.value)}
              />
            </div>
            <div className="ins-modal-footer">
              <button className="ins-btn ins-btn--ghost" onClick={closeModal}>ยกเลิก</button>
              <button className="ins-btn ins-btn--secondary" onClick={saveWithdraw} disabled={saving}>
                {saving ? "กำลังบันทึก..." : "ยืนยันเบิก"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL REFUND ───────────────────────────────────────── */}
      {modal === "refund" && selEmp && (
        <div className="ins-overlay" onClick={closeModal}>
          <div className="ins-modal ins-modal--sm" onClick={e => e.stopPropagation()}>
            <div className="ins-modal-header">
              <h3>คืนเงินประกันงาน — {selEmp.nickname}</h3>
            </div>
            <div className="ins-modal-body">
              <div className="ins-refund-info">
                <div className="ins-refund-row">
                  <span>ยอดกระปุกที่จะคืน</span>
                  <span className="ins-refund-amount">฿{fmtMoney(balances[selEmp.id] || 0)}</span>
                </div>
                <p className="ins-refund-note">คืนเป็นเงินสด · ยอดกระปุกจะเป็น ฿0.00</p>
              </div>
            </div>
            <div className="ins-modal-footer">
              <button className="ins-btn ins-btn--ghost" onClick={closeModal}>ยกเลิก</button>
              <button className="ins-btn ins-btn--danger" onClick={saveRefund} disabled={saving}>
                {saving ? "กำลังบันทึก..." : "ยืนยันคืนเงิน"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL HISTORY ──────────────────────────────────────── */}
      {modal === "history" && selEmp && (
        <div className="ins-overlay" onClick={closeModal}>
          <div className="ins-modal ins-modal--lg" onClick={e => e.stopPropagation()}>
            <div className="ins-modal-header">
              <h3>ประวัติกระปุก — {selEmp.nickname}</h3>
              <span className="ins-modal-sub">
                ยอดปัจจุบัน ฿{fmtMoney(balances[selEmp.id] || 0)}
              </span>
            </div>
            <div className="ins-modal-body">
              <div className="ins-hist-list">
                {history
                  .filter(r => r.employee_id === selEmp.id)
                  .map((r, i, arr) => {
                    // คำนวณ running balance
                    const running = arr
                      .slice(i)
                      .reduce((s, x) => s + Number(x.amount), 0);
                    return (
                      <div key={r.id} className="ins-hist-row">
                        <span className="ins-hist-date">{fmtDate(r.entry_date)}</span>
                        <span className={`ins-hist-type ins-hist-type--${r.entry_type}`}>
                          {{ deposit: "ฝาก", withdraw: "เบิก", refund: "คืน" }[r.entry_type]}
                        </span>
                        <span className={`ins-hist-amount ${Number(r.amount) < 0 ? "ins-hist-amount--neg" : "ins-hist-amount--pos"}`}>
                          {Number(r.amount) > 0 ? "+" : ""}฿{fmtMoney(r.amount)}
                        </span>
                        <span className="ins-hist-bal">฿{fmtMoney(running)}</span>
                        <span className="ins-hist-note">{r.note || "—"}</span>
                      </div>
                    );
                  })}
                {history.filter(r => r.employee_id === selEmp.id).length === 0 && (
                  <p className="ins-empty">ยังไม่มีรายการ</p>
                )}
              </div>
            </div>
            <div className="ins-modal-footer">
              <button className="ins-btn ins-btn--ghost" onClick={closeModal}>ปิด</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .ins-page { padding: 24px; font-family: 'Sarabun', sans-serif; }
        .ins-loading { display:flex; flex-direction:column; align-items:center; padding:80px; gap:12px; color:#6b7280; }
        .ins-spinner { width:32px; height:32px; border:3px solid #e5e7eb; border-top-color:#6366f1; border-radius:50%; animation:spin .7s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }

        .ins-toast { position:fixed; top:20px; right:20px; z-index:9999; padding:12px 20px; border-radius:8px; font-size:14px; font-weight:500; }
        .ins-toast--ok  { background:#d1fae5; color:#065f46; border:1px solid #6ee7b7; }
        .ins-toast--err { background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; }

        .ins-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:24px; }
        .ins-title { font-size:22px; font-weight:700; color:#111827; margin:0; }
        .ins-subtitle { font-size:13px; color:#6b7280; margin:4px 0 0; }
        .ins-summary-box { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:12px 20px; text-align:right; }
        .ins-summary-label { display:block; font-size:12px; color:#6b7280; }
        .ins-summary-amount { display:block; font-size:22px; font-weight:700; color:#16a34a; }
        .ins-summary-count { display:block; font-size:12px; color:#6b7280; }

        .ins-table-wrap { overflow-x:auto; }
        .ins-table { width:100%; border-collapse:collapse; font-size:14px; }
        .ins-table th { background:#f9fafb; padding:10px 12px; text-align:left; font-weight:600; color:#374151; border-bottom:2px solid #e5e7eb; white-space:nowrap; }
        .ins-table td { padding:10px 12px; border-bottom:1px solid #f3f4f6; vertical-align:middle; }
        .ins-table tr:last-child td { border-bottom:none; }
        .ins-table tr:hover td { background:#fafafa; }
        .ins-col-right { text-align:right; }

        .ins-row--resigned td { opacity:.6; }
        .ins-code { font-family:monospace; font-size:12px; color:#6b7280; }
        .ins-name { font-weight:600; color:#111827; }
        .ins-level { font-size:13px; color:#374151; }
        .ins-date { font-size:13px; color:#6b7280; white-space:nowrap; }
        .ins-balance { font-weight:700; color:#16a34a; font-variant-numeric:tabular-nums; }
        .ins-balance--zero { color:#9ca3af; }

        .ins-badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; margin-left:4px; }
        .ins-badge--warn    { background:#fef3c7; color:#92400e; }
        .ins-badge--ok      { background:#d1fae5; color:#065f46; }
        .ins-badge--done    { background:#e0e7ff; color:#3730a3; }
        .ins-badge--resigned{ background:#f3f4f6; color:#6b7280; }

        .ins-actions { display:flex; gap:6px; flex-wrap:wrap; }
        .ins-btn { padding:5px 12px; border-radius:6px; font-size:13px; font-weight:500; cursor:pointer; border:none; transition:opacity .15s; }
        .ins-btn:disabled { opacity:.4; cursor:not-allowed; }
        .ins-btn--ghost     { background:transparent; color:#6b7280; border:1px solid #e5e7eb; }
        .ins-btn--ghost:hover:not(:disabled) { background:#f9fafb; }
        .ins-btn--primary   { background:#6366f1; color:#fff; }
        .ins-btn--primary:hover:not(:disabled) { background:#4f46e5; }
        .ins-btn--secondary { background:#0ea5e9; color:#fff; }
        .ins-btn--secondary:hover:not(:disabled) { background:#0284c7; }
        .ins-btn--danger    { background:#ef4444; color:#fff; }
        .ins-btn--danger:hover:not(:disabled) { background:#dc2626; }

        /* overlay */
        .ins-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px; }
        .ins-modal { background:#fff; border-radius:12px; width:100%; max-width:520px; max-height:90vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,.25); }
        .ins-modal--sm { max-width:400px; }
        .ins-modal--lg { max-width:640px; }
        .ins-modal-header { padding:20px 24px 16px; border-bottom:1px solid #f3f4f6; }
        .ins-modal-header h3 { margin:0; font-size:17px; font-weight:700; color:#111827; }
        .ins-modal-sub { font-size:13px; color:#6b7280; margin-top:4px; display:block; }
        .ins-modal-body { padding:20px 24px; overflow-y:auto; flex:1; }
        .ins-modal-footer { padding:16px 24px; border-top:1px solid #f3f4f6; display:flex; justify-content:flex-end; gap:8px; }

        .ins-label { display:block; font-size:13px; font-weight:600; color:#374151; margin-bottom:6px; }
        .ins-input { width:100%; padding:8px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:14px; box-sizing:border-box; font-family:inherit; }
        .ins-input:focus { outline:none; border-color:#6366f1; box-shadow:0 0 0 3px rgba(99,102,241,.1); }

        /* backfill preview */
        .ins-preview { margin-top:16px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; }
        .ins-preview-header { display:flex; justify-content:space-between; padding:8px 12px; background:#f9fafb; font-size:12px; color:#6b7280; font-weight:600; }
        .ins-preview-new { color:#6366f1; }
        .ins-preview-list { max-height:240px; overflow-y:auto; }
        .ins-preview-row { display:flex; gap:12px; align-items:center; padding:6px 12px; font-size:13px; border-top:1px solid #f3f4f6; }
        .ins-preview-row:first-child { border-top:none; }
        .ins-preview-row--exists { opacity:.45; }
        .ins-preview-row span:first-child { flex:1; }
        .ins-preview-tag { font-size:11px; color:#9ca3af; }
        .ins-preview-total { padding:8px 12px; background:#f0fdf4; font-size:13px; font-weight:700; color:#16a34a; border-top:1px solid #bbf7d0; text-align:right; }

        /* withdraw / refund */
        .ins-refund-info { background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:16px; }
        .ins-refund-row { display:flex; justify-content:space-between; align-items:center; }
        .ins-refund-amount { font-size:22px; font-weight:700; color:#dc2626; }
        .ins-refund-note { font-size:12px; color:#9ca3af; margin:8px 0 0; }

        /* history */
        .ins-hist-list { display:flex; flex-direction:column; gap:4px; }
        .ins-hist-row { display:grid; grid-template-columns:90px 50px 90px 90px 1fr; gap:8px; align-items:center; padding:8px 4px; border-bottom:1px solid #f3f4f6; font-size:13px; }
        .ins-hist-date { color:#6b7280; white-space:nowrap; }
        .ins-hist-type { font-size:11px; font-weight:600; padding:2px 6px; border-radius:4px; text-align:center; }
        .ins-hist-type--deposit  { background:#d1fae5; color:#065f46; }
        .ins-hist-type--withdraw { background:#dbeafe; color:#1e40af; }
        .ins-hist-type--refund   { background:#fee2e2; color:#991b1b; }
        .ins-hist-amount { font-weight:600; text-align:right; font-variant-numeric:tabular-nums; }
        .ins-hist-amount--pos { color:#16a34a; }
        .ins-hist-amount--neg { color:#dc2626; }
        .ins-hist-bal { color:#6b7280; text-align:right; font-variant-numeric:tabular-nums; }
        .ins-hist-note { color:#9ca3af; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .ins-empty { text-align:center; color:#9ca3af; padding:32px; }
      `}</style>
    </div>
  );
}
