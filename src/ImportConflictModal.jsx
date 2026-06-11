// src/ImportConflictModal.jsx
// ─────────────────────────────────────────────────────────────
// Modal เตือนก่อนนำเข้าทับข้อมูลสำคัญ (HR แก้มือ / วันในรอบที่จ่ายแล้ว)
// โชว์ตารางเทียบ "เดิม → ใหม่" ให้ดูง่าย แล้วให้เลือก ทับ / เก็บของเดิม
// rows: [{ key, work_date, nickname, reason, old:{am_in,late,ot}, neu:{am_in,late,ot} }]
// ─────────────────────────────────────────────────────────────

// แปลง YYYY-MM-DD → DD/MM/พ.ศ.
function toBE(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

const changed = (a, b) => String(a) !== String(b);

export default function ImportConflictModal({ rows, onOverwrite, onKeep, onCancel, saving }) {
  if (!rows || rows.length === 0) return null;

  return (
    <div style={s.overlay} onClick={onCancel}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <span style={{ fontWeight: 700, fontSize: 16, color: "#fff" }}>
            ⚠️ ข้อมูลสำคัญจะถูกทับ ({rows.length} รายการ)
          </span>
          <button onClick={onCancel} style={s.closeBtn}>✕</button>
        </div>

        <div style={s.body}>
          <p style={s.note}>
            ไฟล์ที่นำเข้ามีวันที่ตรงกับข้อมูลที่ <strong>HR แก้มือไว้</strong> หรือ
            <strong> อยู่ในรอบที่จ่ายเงินไปแล้ว</strong> — ดูส่วนที่จะเปลี่ยนก่อนตัดสินใจ
            (ช่องที่ <span style={{ color: "#dc2626", fontWeight: 700 }}>แดง</span> คือค่าที่ต่างจากเดิม)
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>วันที่</th>
                  <th style={s.th}>พนักงาน</th>
                  <th style={s.th}>เหตุผล</th>
                  <th style={s.th}>เข้าเช้า</th>
                  <th style={s.th}>สาย (น.)</th>
                  <th style={s.th}>OT (ชม.)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td style={s.td}>{toBE(r.work_date)}</td>
                    <td style={{ ...s.td, fontWeight: 600 }}>{r.nickname}</td>
                    <td style={s.tdReason}>{r.reason}</td>
                    <Cell oldV={r.old.am_in} newV={r.neu.am_in} />
                    <Cell oldV={r.old.late} newV={r.neu.late} />
                    <Cell oldV={r.old.ot} newV={r.neu.ot} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={s.footer}>
          <button onClick={onKeep} disabled={saving} style={{ ...s.btn, ...s.btnKeep }}>
            🛡️ เก็บของเดิมไว้ (ข้ามรายการพวกนี้)
          </button>
          <button onClick={onOverwrite} disabled={saving} style={{ ...s.btn, ...s.btnOverwrite }}>
            ⬇️ ทับด้วยข้อมูลใหม่ทั้งหมด
          </button>
          <button onClick={onCancel} disabled={saving} style={{ ...s.btn, ...s.btnCancel }}>
            ยกเลิก
          </button>
        </div>
      </div>
    </div>
  );
}

// ช่องเทียบ เดิม → ใหม่ (ถ้าต่างกัน → ใหม่เป็นสีแดง)
function Cell({ oldV, newV }) {
  const diff = changed(oldV, newV);
  return (
    <td style={{ ...s.td, textAlign: "center" }}>
      <span style={{ color: "#94a3b8" }}>{String(oldV)}</span>
      <span style={{ color: "#cbd5e1", margin: "0 4px" }}>→</span>
      <span style={{ fontWeight: diff ? 700 : 400, color: diff ? "#dc2626" : "#1e293b" }}>
        {String(newV)}
      </span>
    </td>
  );
}

const s = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 12,
  },
  modal: {
    background: "#fff", borderRadius: 16, width: 720, maxWidth: "95vw",
    maxHeight: "88vh", overflow: "hidden", display: "flex", flexDirection: "column",
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "14px 16px", background: "#b45309", borderRadius: "16px 16px 0 0",
  },
  closeBtn: { background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer", lineHeight: 1 },
  body: { padding: 16, overflowY: "auto" },
  note: {
    margin: "0 0 12px", fontSize: 13, color: "#92400e",
    background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 12px", lineHeight: 1.6,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    padding: "8px 8px", textAlign: "left", background: "#1e3a5f",
    color: "#fff", fontWeight: 700, whiteSpace: "nowrap",
  },
  td: { padding: "7px 8px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdReason: {
    padding: "7px 8px", borderBottom: "1px solid #f1f5f9",
    fontSize: 12, color: "#92400e", whiteSpace: "nowrap",
  },
  footer: {
    display: "flex", gap: 8, padding: "12px 16px", borderTop: "1px solid #e2e8f0",
    flexWrap: "wrap", justifyContent: "flex-end",
  },
  btn: { padding: "10px 16px", borderRadius: 10, border: "none", fontWeight: 700, fontSize: 13.5, cursor: "pointer" },
  btnKeep: { background: "#16a34a", color: "#fff" },
  btnOverwrite: { background: "#dc2626", color: "#fff" },
  btnCancel: { background: "#f1f5f9", color: "#374151", border: "1px solid #e2e8f0" },
};
