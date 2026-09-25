// 💼 เคลียเงินพนักงานลาออก (25 ก.ย. 69)
//   หลัก "โปรแกรมตรวจ ไม่ทำแทน": โปรแกรมคิดยอดให้ดูทีละบรรทัดจากผลคำนวณเงินเดือน (payroll_records)
//   HR ยื่น → เจ้าของอนุมัติ · เก็บเป็น payout_vouchers kind='resign' (1 คน/ใบ)
//   ใบสิ้นเดือน (WeeklyPage) หักยอดที่เคลียแล้วออกให้เอง → ไม่จ่ายซ้ำ
//   คนลาออกที่ยังไม่มีใบเคลียเงิน = ป้ายค้างให้เห็น (เกิน 7 วัน = แดง)
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const MONTHS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const money = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toBE = (iso) => { if (!iso) return "-"; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${Number(y) + 543}`; };
const todayISO = () => { const t = new Date(Date.now() + 7 * 3600 * 1000); return t.toISOString().slice(0, 10); };
const daysSince = (iso) => Math.floor((new Date(todayISO()) - new Date(String(iso).slice(0, 10))) / 86400000);
const STATUS = {
  submitted: { text: "⏳ รออนุมัติ", bg: "#FEF3C7", fg: "#92400E" },
  approved:  { text: "✓ เคลียแล้ว", bg: "#EAF3DE", fg: "#27500A" },
  returned:  { text: "↩️ ถูกตีกลับ", bg: "#FCEBEB", fg: "#A32D2D" },
  month_end: { text: "✓ เคลียกับใบสิ้นเดือนแล้ว", bg: "#EAF3DE", fg: "#27500A" },
};
export const SETTLE_WINDOW_DAYS = 90;   // ดูคนที่ลาออกภายใน 90 วัน

// โหลดสถานะเคลียเงินของคนลาออก → { [employee_id]: voucher | null }
//   🆕 คนที่ออกก่อนมีระบบใบเคลีย (เช่น ดรีม ส.ค.69) และถูกเคลียไปกับ "ใบสิ้นเดือนที่อนุมัติแล้ว" ของเดือนที่ลาออก
//      = ถือว่าเคลียแล้ว (status 'month_end') ไม่ต้องทำใบเคลียซ้ำ — ต้องส่ง emps (มี resigned_date) มาด้วย
export async function loadResignVouchers(empIds, emps = []) {
  if (!empIds.length) return {};
  const { data } = await supabase.from("payout_vouchers")
    .select("id, voucher_no, status, total_amount, cycle_date, pay_method, pay_note, employee_id, return_reason, period_id, lines")
    .eq("kind", "resign").in("employee_id", empIds);
  const m = {};
  for (const id of empIds) m[id] = null;
  for (const v of data || []) {
    // คนเดียวอาจมีหลายงวด (กลับมาทำแล้วออกใหม่) → เอาใบล่าสุด
    if (!m[v.employee_id] || String(v.cycle_date) > String(m[v.employee_id].cycle_date)) m[v.employee_id] = v;
  }
  const noV = emps.filter((e) => empIds.includes(e.id) && !m[e.id] && e.resigned_date);
  if (noV.length) {
    const { data: me } = await supabase.from("payout_vouchers")
      .select("voucher_no, status, lines, approved_at, pay_periods(year, month)")
      .eq("kind", "cycle").is("cycle_date", null).eq("status", "approved");
    for (const e of noV) {
      const [y, mo] = String(e.resigned_date).slice(0, 10).split("-").map(Number);
      const v = (me || []).find((x) => x.pay_periods?.year === y && x.pay_periods?.month === mo &&
        (x.lines || []).some((l) => l.employee_id === e.id));
      if (v) {
        const ln = v.lines.find((l) => l.employee_id === e.id);
        m[e.id] = { status: "month_end", voucher_no: v.voucher_no, total_amount: Number(ln.to_pay || 0), cycle_date: String(v.approved_at || "").slice(0, 10) || null };
      }
    }
  }
  return m;
}

// แถบเตือนบนหน้าพนักงาน
export function ResignSettleBanner({ resigned, settleMap, onOpen }) {
  const pending = resigned.filter((e) => {
    const v = settleMap[e.id];
    return !v || v.status === "returned" || v.status === "submitted";
  });
  if (!pending.length) return null;
  return (
    <div style={{ background: "#FCEBEB", border: "0.5px solid #F09595", borderRadius: 8, padding: "10px 12px", marginBottom: 12, fontSize: 12.5, color: "#7A1F1F", lineHeight: 1.7 }}>
      <b>💼 คนลาออกที่ยังเคลียเงินไม่จบ {pending.length} คน</b>
      <span style={{ color: "#A32D2D" }}> — ถ้าไม่ทำใบเคลียเงิน ยอดของคนนี้จะไปโผล่ในใบจ่ายสิ้นเดือน (เสี่ยงจ่ายซ้ำถ้าโอนไปแล้ว)</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {pending.map((e) => {
          const v = settleMap[e.id];
          const d = daysSince(e.resigned_date);
          const late = !v && d > 7;
          return (
            <button key={e.id} onClick={() => onOpen(e)}
              style={{ background: late ? "#A32D2D" : "#fff", color: late ? "#fff" : "#A32D2D", border: "0.5px solid #F09595", borderRadius: 99, padding: "3px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
              {e.nickname} · ออก {toBE(e.resigned_date)} ({d} วัน) · {v ? STATUS[v.status]?.text : "ยังไม่เคลีย"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ป้ายในแถวพนักงาน (คนลาออก)
export function ResignSettleChip({ emp, voucher, onOpen }) {
  if (!emp.resigned_date || daysSince(emp.resigned_date) > SETTLE_WINDOW_DAYS && !voucher) return null;
  const st = voucher ? STATUS[voucher.status] : null;
  return (
    <button onClick={() => onOpen(emp)}
      style={{ marginTop: 4, background: st ? st.bg : "#FCEBEB", color: st ? st.fg : "#A32D2D", border: "none", borderRadius: 99, padding: "1px 8px", fontSize: 10.5, fontWeight: 600, cursor: "pointer" }}>
      💼 {voucher ? (voucher.status === "month_end" ? `${st.text} ${voucher.voucher_no} (${money(voucher.total_amount)})` : `${st.text} ${money(voucher.total_amount)} · ${toBE(voucher.cycle_date)}`) : "ยังไม่เคลียเงินลาออก"}
    </button>
  );
}

// หน้าต่างเคลียเงิน
export function ResignSettleModal({ emp, role, onClose, onDone }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [ctx, setCtx] = useState(null);   // { period, rec, satPaid, satList, extras, deds, voucher }
  const [payDate, setPayDate] = useState(todayISO());
  const [payMethod, setPayMethod] = useState("transfer");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, [emp?.id]);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const rd = String(emp.resigned_date).slice(0, 10);
      const [y, m] = rd.split("-").map(Number);
      const { data: per } = await supabase.from("pay_periods").select("id, year, month, is_closed").eq("year", y).eq("month", m).maybeSingle();
      if (!per) { setErr(`ยังไม่มีงวดเดือน ${MONTHS[m]} ${y + 543}`); setLoading(false); return; }
      const dFrom = `${y}-${String(m).padStart(2, "0")}-01`;
      const dTo = `${y}-${String(m).padStart(2, "0")}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
      const [{ data: rec }, { data: vs }, { data: ex }, { data: dd }] = await Promise.all([
        supabase.from("payroll_records").select("*").eq("period_id", per.id).eq("employee_id", emp.id).maybeSingle(),
        supabase.from("payout_vouchers").select("id, kind, voucher_no, status, cycle_date, total_amount, lines, pay_method, pay_note, return_reason, employee_id").eq("period_id", per.id),
        supabase.from("extra_income_entries").select("label, amount, income_type, disburse_on").eq("period_id", per.id).eq("employee_id", emp.id),
        supabase.from("deductions").select("amount, deduct_date, note, deduction_types(name)").eq("employee_id", emp.id).gte("deduct_date", dFrom).lte("deduct_date", dTo),
      ]);
      // จ่ายรอบเสาร์ไปแล้ว (ใบรอบที่ยื่น/อนุมัติ)
      const satList = [];
      for (const v of vs || []) {
        if ((v.kind || "cycle") !== "cycle" || !v.cycle_date || !["submitted", "approved"].includes(v.status)) continue;
        const ln = (v.lines || []).find((l) => l.employee_id === emp.id);
        if (ln && Number(ln.to_pay || 0)) satList.push({ date: v.cycle_date, no: v.voucher_no, amt: Number(ln.to_pay || 0), status: v.status });
      }
      const meVoucher = (vs || []).find((v) => (v.kind || "cycle") === "cycle" && !v.cycle_date && ["submitted", "approved"].includes(v.status));
      const meLine = meVoucher ? (meVoucher.lines || []).find((l) => l.employee_id === emp.id && Number(l.to_pay || 0)) : null;
      const voucher = (vs || []).find((v) => v.kind === "resign" && v.employee_id === emp.id) || null;
      if (voucher) { setPayDate(voucher.cycle_date); setPayMethod(voucher.pay_method || "transfer"); setNote(voucher.pay_note || ""); }
      setCtx({ period: per, rec, satList, satPaid: satList.reduce((s, x) => s + x.amt, 0), extras: ex || [], deds: dd || [], voucher, meLine, meVoucher });
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  const rec = ctx?.rec;
  const net = rec ? Number(rec.net_pay ?? (Number(rec.total_income || 0) - Number(rec.total_deduct || 0))) : 0;
  const toPay = rec ? Math.round((net - (ctx.satPaid || 0)) * 100) / 100 : 0;
  const v = ctx?.voucher;
  const locked = v && (v.status === "submitted" || v.status === "approved");
  const extrasOther = (ctx?.extras || []).filter((x) => x.income_type === "other");

  async function submit() {
    if (!rec) return;
    if (!payDate) { setErr("ใส่วันที่จ่าย"); return; }
    if (ctx.meLine) { setErr(`ใบจ่ายสิ้นเดือน ${ctx.meVoucher.voucher_no} มียอดของ ${emp.nickname} อยู่แล้ว ${money(ctx.meLine.to_pay)} — ตีกลับใบสิ้นเดือนก่อน แล้วค่อยเคลียเงิน`); return; }
    setBusy(true); setErr(null);
    const line = {
      employee_id: emp.id, emp_code: emp.emp_code, nickname: emp.nickname, full_name: emp.full_name,
      work_days: Number(rec.work_days || 0), wage: Number(rec.base_wage || 0), ot: Number(rec.ot_amount || 0),
      advance: ctx.satPaid, to_pay: toPay,
      income_items: extrasOther.map((x) => ({ label: x.label || "รายได้อื่นๆ", amount: Number(x.amount || 0), disburse_on: "resign" })),
      resign: {
        resigned_date: emp.resigned_date, net_month: net, sat_paid: ctx.satPaid,
        calc_at: rec.updated_at,
        income: { base_wage: rec.base_wage, holiday_wage: rec.holiday_wage, ot_amount: rec.ot_amount, diligence_bonus: rec.diligence_bonus, position_allowance: rec.position_allowance, other_income: rec.other_income, insurance_refund: rec.insurance_refund, app_fee_refund: rec.app_fee_refund, total_income: rec.total_income },
        deduct: { social_security: rec.social_security, late_deduct: rec.late_deduct, leave_deduct: rec.leave_deduct, advance_total: rec.advance_total, other_deduct: rec.other_deduct, job_insurance: rec.job_insurance, app_fee_deduct: rec.app_fee_deduct, loan_deduct: rec.loan_deduct, total_deduct: rec.total_deduct },
      },
    };
    const payload = {
      kind: "resign", employee_id: emp.id, period_id: ctx.period.id, cycle_date: payDate,
      voucher_no: v?.voucher_no || `R${ctx.period.year}-${String(ctx.period.month).padStart(2, "0")}-${emp.emp_code || emp.nickname}`,
      status: "submitted", total_amount: toPay, employee_count: 1, lines: [line],
      pay_method: payMethod, pay_note: note || null, submitted_at: new Date().toISOString(),
    };
    const { error } = v
      ? await supabase.from("payout_vouchers").update({ ...payload, returned_at: null, return_reason: null }).eq("id", v.id)
      : await supabase.from("payout_vouchers").insert(payload);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDone && onDone(`ยื่นใบเคลียเงินลาออก ${emp.nickname} ${money(toPay)} บาท แล้ว — รอเจ้าของอนุมัติ`);
  }

  async function setStatus(status) {
    if (!v) return;
    let reason = null;
    if (status === "returned") { reason = window.prompt("เหตุผลที่ตีกลับ"); if (reason === null) return; }
    setBusy(true); setErr(null);
    const patch = status === "approved" ? { status, approved_at: new Date().toISOString() } : { status, returned_at: new Date().toISOString(), return_reason: reason || "ตีกลับ" };
    const { error } = await supabase.from("payout_vouchers").update(patch).eq("id", v.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDone && onDone(status === "approved" ? `อนุมัติใบเคลียเงิน ${emp.nickname} แล้ว` : `ตีกลับใบเคลียเงิน ${emp.nickname} แล้ว`);
  }

  const Row = ({ label, value, neg, bold, muted, indent }) => !Number(value) && !bold ? null : (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", paddingLeft: indent ? 14 : 0, fontSize: indent ? 12 : 13, fontWeight: bold ? 700 : 400, color: muted ? "#888" : neg ? "#A32D2D" : "#222" }}>
      <span>{label}</span><span>{neg && Number(value) ? "−" : ""}{money(value)}</span>
    </div>
  );

  return (
    <div onClick={(e) => e.target === e.currentTarget && !busy && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: "1.25rem 1.5rem", width: "100%", maxWidth: 500, maxHeight: "92vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 16 }}>💼 เคลียเงินลาออก — ใบของ {emp.nickname} คนเดียว</span>
          <button onClick={onClose} disabled={busy} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#aaa" }}>×</button>
        </div>
        <div style={{ background: "#F7F7F5", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>{emp.nickname} — {emp.full_name} <span style={{ color: "#888", fontWeight: 400 }}>· {emp.emp_code}</span></div>
          <div style={{ fontSize: 12, color: "#666" }}>วันสุดท้ายที่ทำงาน {toBE(emp.resigned_date)} · {emp.emp_type === "permanent" ? "ประจำ" : "ทดลองงาน"} · {emp.pay_schedule === "saturday" ? "รายเสาร์" : "สิ้นเดือน"}</div>
        </div>

        {loading && <div style={{ padding: 20, textAlign: "center", color: "#aaa" }}>กำลังโหลด...</div>}
        {!loading && ctx && !rec && (
          <div style={{ background: "#FCEBEB", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#A32D2D" }}>
            ยังไม่มีผลคำนวณเงินเดือนงวด {MONTHS[ctx.period.month]} {ctx.period.year + 543} ของคนนี้ — ไปกด "คำนวณ + บันทึก" ที่หน้า 💰 เงินเดือน ก่อน
          </div>
        )}

        {!loading && rec && (
          <>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
              จากผลคำนวณงวด {MONTHS[ctx.period.month]} {ctx.period.year + 543} · คำนวณล่าสุด {new Date(rec.updated_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
              {!locked && <> · ถ้าเพิ่งแก้บันทึกเวลา/รายหัก ให้กดคำนวณใหม่ก่อน</>}
            </div>
            <div style={{ border: "0.5px solid #e5e5e5", borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#27500A", marginBottom: 2 }}>รายได้ ({rec.work_days} วัน)</div>
              <Row label="ค่าแรง" value={Number(rec.base_wage)} />
              <Row label="ค่าวันหยุด" value={Number(rec.holiday_wage)} />
              <Row label="OT" value={Number(rec.ot_amount)} />
              <Row label="เบี้ยขยัน" value={Number(rec.diligence_bonus)} />
              <Row label="เงินประจำตำแหน่ง" value={Number(rec.position_allowance)} />
              <Row label="รายได้อื่นๆ" value={Number(rec.other_income)} />
              {extrasOther.map((x, i) => <Row key={i} indent muted label={`· ${x.label || "รายได้อื่นๆ"}`} value={Number(x.amount)} />)}
              <Row label="คืนประกันงาน" value={Number(rec.insurance_refund)} />
              <Row label="คืนค่าสมัครงาน" value={Number(rec.app_fee_refund)} />
              <Row label="รวมรายได้" value={Number(rec.total_income)} bold />

              <div style={{ fontSize: 12, fontWeight: 600, color: "#A32D2D", margin: "8px 0 2px" }}>รายหัก</div>
              <Row label="ประกันสังคม" value={Number(rec.social_security)} neg />
              <Row label="หักสาย" value={Number(rec.late_deduct)} neg />
              <Row label="หักลา" value={Number(rec.leave_deduct)} neg />
              <Row label="เบิกล่วงหน้า" value={Number(rec.advance_total)} neg />
              <Row label="หักอื่นๆ" value={Number(rec.other_deduct)} neg />
              {ctx.deds.filter((d) => (d.deduction_types?.name || "") !== "เบิกเงินสด" && d.note !== "เงินออก").map((d, i) => (
                <Row key={i} indent muted label={`· ${d.note || d.deduction_types?.name || "หัก"}`} value={Number(d.amount)} />
              ))}
              <Row label="ประกันงาน" value={Number(rec.job_insurance)} neg />
              <Row label="ค่าสมัครงาน" value={Number(rec.app_fee_deduct)} neg />
              <Row label="หักเงินกู้" value={Number(rec.loan_deduct)} neg />
              <Row label="รวมรายหัก" value={Number(rec.total_deduct)} neg bold />

              <div style={{ borderTop: "0.5px solid #eee", marginTop: 6, paddingTop: 4 }}>
                <Row label="สุทธิทั้งเดือน" value={net} bold />
                {ctx.satList.map((x, i) => <Row key={i} indent muted neg label={`จ่ายรอบเสาร์ ${toBE(x.date)} (${x.no})`} value={x.amt} />)}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, padding: "8px 10px", background: toPay < 0 ? "#FCEBEB" : "#EAF3DE", borderRadius: 8, fontWeight: 800, fontSize: 16, color: toPay < 0 ? "#A32D2D" : "#085041" }}>
                <span>{toPay < 0 ? "พนักงานต้องคืนร้าน" : "ยอดเคลียจ่าย"}</span><span>{money(Math.abs(toPay))} บาท</span>
              </div>
            </div>

            {ctx.meLine && ctx.meVoucher.status === "approved" && (
              <div style={{ background: "#EAF3DE", borderRadius: 8, padding: "8px 12px", marginBottom: 10, fontSize: 12.5, color: "#27500A", fontWeight: 600 }}>
                ✓ เคลียไปกับใบจ่ายสิ้นเดือน {ctx.meVoucher.voucher_no} (อนุมัติแล้ว) ยอด {money(ctx.meLine.to_pay)} — ไม่ต้องทำใบเคลียเงินซ้ำ
              </div>
            )}
            {ctx.meLine && ctx.meVoucher.status !== "approved" && (
              <div style={{ background: "#FCEBEB", borderRadius: 8, padding: "8px 12px", marginBottom: 10, fontSize: 12, color: "#A32D2D" }}>
                ⚠️ ใบจ่ายสิ้นเดือน {ctx.meVoucher.voucher_no} มียอดของคนนี้อยู่แล้ว {money(ctx.meLine.to_pay)} (ยังไม่อนุมัติ) — ถ้าจะจ่ายไปกับใบนั้น ไม่ต้องทำใบเคลียเงิน
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: "#666" }}>วันที่จ่าย *
                <input type="date" value={payDate} disabled={locked} onChange={(e) => setPayDate(e.target.value)}
                  style={{ display: "block", width: "100%", height: 32, borderRadius: 8, border: "0.5px solid #ccc", padding: "0 8px", boxSizing: "border-box", marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 12, color: "#666" }}>วิธีจ่าย *
                <select value={payMethod} disabled={locked} onChange={(e) => setPayMethod(e.target.value)}
                  style={{ display: "block", width: "100%", height: 32, borderRadius: 8, border: "0.5px solid #ccc", padding: "0 6px", marginTop: 3 }}>
                  <option value="transfer">โอนธนาคาร</option>
                  <option value="cash">เงินสด</option>
                </select>
              </label>
              <label style={{ fontSize: 12, color: "#666", gridColumn: "1/-1" }}>หมายเหตุ
                <input value={note} disabled={locked} onChange={(e) => setNote(e.target.value)} placeholder="เช่น โอน TTB 21 ก.ย."
                  style={{ display: "block", width: "100%", height: 32, borderRadius: 8, border: "0.5px solid #ccc", padding: "0 8px", boxSizing: "border-box", marginTop: 3 }} />
              </label>
            </div>

            {v && (
              <div style={{ fontSize: 12, marginBottom: 8, color: STATUS[v.status]?.fg }}>
                ใบ {v.voucher_no} · {emp.nickname} 1 คน · {STATUS[v.status]?.text} · {money(v.total_amount)} บาท
                {v.status === "returned" && v.return_reason && <> · เหตุผล: {v.return_reason}</>}
                {locked && Math.abs(Number(v.total_amount) - toPay) >= 1 && (
                  <div style={{ color: "#A32D2D", fontWeight: 600, marginTop: 4 }}>
                    ⚠️ ผลคำนวณล่าสุดได้ {money(toPay)} ไม่ตรงกับใบ {money(v.total_amount)} — ส่วนต่างจะไปโผล่ในใบจ่ายสิ้นเดือน ตรวจก่อนจ่าย
                  </div>
                )}
              </div>
            )}
            {err && <div style={{ background: "#FCEBEB", borderRadius: 8, padding: "8px 12px", marginBottom: 8, fontSize: 12, color: "#A32D2D" }}>❌ {err}</div>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <button onClick={onClose} disabled={busy} style={{ height: 36, padding: "0 14px", borderRadius: 8, border: "0.5px solid #ccc", background: "none", cursor: "pointer" }}>ปิด</button>
              {(!v || v.status === "returned") && !(ctx.meLine && ctx.meVoucher.status === "approved") && (
                <button onClick={submit} disabled={busy || ctx.period.is_closed} title={ctx.period.is_closed ? "งวดปิดแล้ว" : ""}
                  style={{ height: 36, padding: "0 16px", borderRadius: 8, border: "none", background: "#111", color: "#fff", cursor: "pointer", fontWeight: 600, opacity: busy || ctx.period.is_closed ? 0.5 : 1 }}>
                  {busy ? "กำลังบันทึก..." : v ? "ยื่นใบเคลียเงินใหม่" : "📝 ยื่นใบเคลียเงิน"}
                </button>
              )}
              {v?.status === "submitted" && role === "owner" && (
                <>
                  <button onClick={() => setStatus("returned")} disabled={busy} style={{ height: 36, padding: "0 14px", borderRadius: 8, border: "0.5px solid #F09595", background: "#fff", color: "#A32D2D", cursor: "pointer" }}>↩️ ตีกลับ</button>
                  <button onClick={() => setStatus("approved")} disabled={busy} style={{ height: 36, padding: "0 16px", borderRadius: 8, border: "none", background: "#27500A", color: "#fff", cursor: "pointer", fontWeight: 600 }}>✓ อนุมัติ (จ่ายแล้ว)</button>
                </>
              )}
              {v?.status === "submitted" && role !== "owner" && <span style={{ fontSize: 12, color: "#92400E", alignSelf: "center" }}>รอเจ้าของอนุมัติ</span>}
            </div>
          </>
        )}
        {!loading && err && !rec && <div style={{ marginTop: 8, fontSize: 12, color: "#A32D2D" }}>❌ {err}</div>}
      </div>
    </div>
  );
}
