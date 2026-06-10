// src/AdvanceSummaryCard.jsx
// การ์ด "เบิกได้อีกเท่าไหร่" — อ่านอย่างเดียว (read-only)
//
// แนวคิด: เบิกได้อีก = (ค่าแรงต่อวัน × วันที่ลงงานแล้วในรอบ) − เบิกที่เอาไปแล้วในรอบ
//   - พนักงานรายเสาร์   : รอบ = วันอาทิตย์ต้นสัปดาห์ปัจจุบัน → วันนี้ (รีเซ็ตทุกเสาร์หลังจ่าย)
//   - พนักงานสิ้นเดือน  : รอบ = วันที่ 1 ของเดือน → วันนี้ (รีเซ็ตตอนจ่ายสิ้นเดือน)
//
// แหล่งข้อมูล (ดึงเอง ไม่ผูกกับการกดคำนวณเงินเดือน):
//   - employees.daily_rate         → ค่าแรงต่อวัน
//   - attendance_logs              → วันที่ลงงานจริง (ไม่นับวันอาทิตย์)
//   - deductions (ประเภทชื่อมี "เบิก") → เบิกที่เอาไปแล้ว
//
// หมายเหตุ: วันอาทิตย์ไม่นับเป็นวันหาค่าแรงเบิก (ค่าวันอาทิตย์จ่ายแยกตามระบบเดิม)

import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";

const fmtInt = (n) => Number(n || 0).toLocaleString("th-TH");
const fmt = (n) =>
  Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ต้นรอบของพนักงานรายเสาร์ = วันอาทิตย์ล่าสุด (ไม่ย้อนข้ามต้นเดือน)
function saturdayCycleStart(today) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  while (start.getDay() !== 0) start.setDate(start.getDate() - 1); // ถอยหาวันอาทิตย์
  const monthFirst = new Date(today.getFullYear(), today.getMonth(), 1);
  return start < monthFirst ? monthFirst : start;
}

export default function AdvanceSummaryCard() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const today = new Date();
      const todayStr = toLocalDateStr(today);
      const monthFirstStr = toLocalDateStr(new Date(today.getFullYear(), today.getMonth(), 1));
      const satStartStr = toLocalDateStr(saturdayCycleStart(today));

      // 1) พนักงานที่ยังทำงาน
      const { data: emps, error: e1 } = await supabase
        .from("employees")
        .select("id, emp_code, nickname, full_name, daily_rate, pay_schedule")
        .eq("is_active", true)
        .order("emp_code");
      if (e1) throw e1;

      const empIds = (emps || []).map((e) => e.id);
      if (!empIds.length) {
        setRows([]);
        return;
      }

      // 2) วันลงงานตั้งแต่ต้นเดือน → วันนี้ (เผื่อทั้งสองรอบ)
      const { data: logs, error: e2 } = await supabase
        .from("attendance_logs")
        .select("employee_id, work_date")
        .in("employee_id", empIds)
        .gte("work_date", monthFirstStr)
        .lte("work_date", todayStr);
      if (e2) throw e2;

      // 3) รายการ "เบิก" ตั้งแต่ต้นเดือน → วันนี้ (กรองด้วยชื่อประเภทที่มีคำว่า "เบิก")
      const { data: deds, error: e3 } = await supabase
        .from("deductions")
        .select("employee_id, amount, deduct_date, deduction_types(name)")
        .in("employee_id", empIds)
        .gte("deduct_date", monthFirstStr)
        .lte("deduct_date", todayStr);
      if (e3) throw e3;

      const advances = (deds || []).filter((d) =>
        (d.deduction_types?.name || "").includes("เบิก")
      );

      const result = (emps || []).map((emp) => {
        const isEom = emp.pay_schedule === "end_of_month";
        const winStart = isEom ? monthFirstStr : satStartStr;

        // วันลงงานในรอบ (ไม่นับวันอาทิตย์) — นับเฉพาะวันที่ไม่ซ้ำ
        const dayset = new Set();
        for (const l of logs || []) {
          if (l.employee_id !== emp.id) continue;
          if (l.work_date < winStart || l.work_date > todayStr) continue;
          if (new Date(l.work_date + "T00:00:00").getDay() === 0) continue; // ข้ามวันอาทิตย์
          dayset.add(l.work_date);
        }
        const workDays = dayset.size;
        const rate = Number(emp.daily_rate || 0);
        const earned = workDays * rate;

        const taken = advances
          .filter(
            (a) =>
              a.employee_id === emp.id &&
              a.deduct_date >= winStart &&
              a.deduct_date <= todayStr
          )
          .reduce((s, a) => s + Number(a.amount || 0), 0);

        const remaining = Math.max(0, earned - taken);
        return {
          id: emp.id,
          emp_code: emp.emp_code,
          nickname: emp.nickname,
          isEom,
          rate,
          workDays,
          earned,
          taken,
          remaining,
        };
      });

      setRows(result);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // แสดงเฉพาะคนที่มีความเคลื่อนไหวในรอบ (ลงงานแล้ว หรือเคยเบิก)
  const shown = rows.filter((r) => r.workDays > 0 || r.taken > 0);
  const totalRemaining = shown.reduce((s, r) => s + r.remaining, 0);

  return (
    <div style={st.card}>
      <div style={st.head}>
        <button onClick={() => setOpen((v) => !v)} style={st.collapseBtn} title={open ? "ย่อ" : "ขยาย"}>
          {open ? "▾" : "▸"}
        </button>
        <div style={{ flex: 1 }}>
          <div style={st.title}>💵 เบิกได้อีกเท่าไหร่</div>
          <div style={st.subtitle}>ค่าแรงที่ลงงานแล้ว − เบิกที่เอาไปแล้ว · อัปเดตตามวันนี้</div>
        </div>
        <span style={st.totalPill}>
          เบิกได้อีกรวม <b>{fmtInt(totalRemaining)}</b> บ.
        </span>
        <button onClick={load} style={st.refreshBtn} disabled={loading}>
          {loading ? "⏳" : "🔄"}
        </button>
      </div>

      {open && (
        <div style={st.body}>
          {err && <div style={st.err}>❌ โหลดข้อมูลไม่ได้: {err}</div>}
          {loading && !err && <p style={st.muted}>⏳ กำลังโหลด...</p>}
          {!loading && !err && shown.length === 0 && (
            <p style={st.muted}>ยังไม่มีพนักงานลงงานหรือเบิกในรอบนี้</p>
          )}

          {!loading && !err && shown.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={st.table}>
                <thead>
                  <tr>
                    {["รหัส", "ชื่อ", "รอบ", "ลงงาน", "หาได้", "เบิกแล้ว", "เบิกได้อีก"].map((h) => (
                      <th
                        key={h}
                        style={{
                          ...st.th,
                          textAlign: h === "รหัส" || h === "ชื่อ" || h === "รอบ" ? "left" : "right",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      <td style={{ ...st.td, color: "#94a3b8", fontSize: 12 }}>{r.emp_code}</td>
                      <td style={{ ...st.td, fontWeight: 700 }}>{r.nickname}</td>
                      <td style={st.td}>
                        <span
                          style={{
                            ...st.badge,
                            background: r.isEom ? "#f5f3ff" : "#eff6ff",
                            color: r.isEom ? "#6d28d9" : "#1d4ed8",
                          }}
                        >
                          {r.isEom ? "💜 สิ้นเดือน" : "🔵 รายเสาร์"}
                        </span>
                      </td>
                      <td style={{ ...st.td, textAlign: "right" }}>{r.workDays} วัน</td>
                      <td style={{ ...st.td, textAlign: "right" }}>{fmt(r.earned)}</td>
                      <td
                        style={{
                          ...st.td,
                          textAlign: "right",
                          color: r.taken > 0 ? "#dc2626" : "#9ca3af",
                        }}
                      >
                        {r.taken > 0 ? `(${fmt(r.taken)})` : "—"}
                      </td>
                      <td
                        style={{
                          ...st.td,
                          textAlign: "right",
                          fontWeight: 800,
                          fontSize: 15,
                          color: r.remaining > 0 ? "#166534" : "#9ca3af",
                        }}
                      >
                        {fmtInt(r.remaining)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#f0fdf4" }}>
                    <td style={st.td} colSpan={6}>
                      <span style={{ fontWeight: 700, color: "#166534" }}>รวมเบิกได้อีก</span>
                    </td>
                    <td style={{ ...st.td, textAlign: "right", fontWeight: 800, fontSize: 16, color: "#166534" }}>
                      {fmtInt(totalRemaining)}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p style={st.note}>
                * ดูอย่างเดียว · หาได้ = ค่าแรงต่อวัน × วันลงงานในรอบ (ไม่นับวันอาทิตย์) · เบิกได้อีก = หาได้ − เบิกแล้ว
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const st = {
  card: {
    background: "#fff",
    borderRadius: 14,
    marginBottom: 16,
    boxShadow: "0 1px 6px rgba(0,0,0,0.08)",
    border: "1px solid #d1fae5",
    overflow: "hidden",
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 16px",
    background: "#ecfdf5",
    borderBottom: "1px solid #d1fae5",
  },
  collapseBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 16,
    color: "#166534",
    padding: 0,
    width: 18,
  },
  title: { fontWeight: 800, fontSize: 15, color: "#065f46" },
  subtitle: { fontSize: 12, color: "#059669" },
  totalPill: {
    background: "#fff",
    border: "1px solid #6ee7b7",
    color: "#065f46",
    padding: "4px 12px",
    borderRadius: 20,
    fontSize: 13,
    whiteSpace: "nowrap",
  },
  refreshBtn: {
    padding: "5px 12px",
    borderRadius: 8,
    border: "1px solid #6ee7b7",
    background: "#fff",
    cursor: "pointer",
    fontSize: 14,
  },
  body: { padding: "8px 12px 12px" },
  err: {
    background: "#fef2f2",
    border: "1px solid #fca5a5",
    color: "#991b1b",
    padding: "10px 14px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
  },
  muted: { color: "#9ca3af", textAlign: "center", padding: 20, fontSize: 13, margin: 0 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    padding: "8px 12px",
    background: "#f8fafc",
    borderBottom: "2px solid #e2e8f0",
    fontWeight: 700,
    color: "#374151",
    whiteSpace: "nowrap",
  },
  td: { padding: "9px 12px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  badge: { fontSize: 11, padding: "2px 9px", borderRadius: 20, fontWeight: 700 },
  note: { fontSize: 11, color: "#94a3b8", margin: "8px 4px 2px", lineHeight: 1.5 },
};
