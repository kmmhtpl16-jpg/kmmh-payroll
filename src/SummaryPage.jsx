// src/SummaryPage.jsx
// 📑 หน้าสรุปเดือน — 2 แบบ
//   แบบ 1 (ปกส): ชื่อจริง + เงินเดือนฐาน + ประกันสังคม + ยอดรวม → ส่งสำนักงานบัญชี
//   แบบ 2 (เซ็นรับเงิน): รายได้ทั้งหมด + ช่องลายเซ็น → ให้พนักงานเซ็นรับเงิน
//   🔒 ปิดข้อมูล: ซ่อนตัวเลขเงินทุกช่อง เหลือแต่ช่องลายเซ็น (พิมพ์ไปตัดประกบแผ่นจริง)
import { useState } from "react";
import { calcPayroll } from "./payrollCalc";

const MONTHS_TH = ["","มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
  "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];

const fmt = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// เงินเดือนฐานที่ใช้คิด ปกส. (ฐานที่จดทะเบียน)
const ssBase = (r) =>
  r.monthly_salary != null ? r.monthly_salary
  : (r.social_security > 0 ? Math.round(r.social_security / 0.05) : r.base_wage);

export default function SummaryPage({ role }) {
  const now = new Date();
  const [year,   setYear]   = useState(now.getFullYear() + 543);
  const [month,  setMonth]  = useState(now.getMonth() + 1);
  const [view,   setView]   = useState("ss");      // "ss" | "sign"
  const [hide,   setHide]   = useState(false);     // 🔒 ปิดข้อมูล
  const [result, setResult] = useState(null);
  const [loading,setLoading]= useState(false);
  const [msg,    setMsg]    = useState(null);

  const handleCalc = async () => {
    setLoading(true); setMsg(null); setResult(null);
    try {
      const data = await calcPayroll(year - 543, month);
      setResult(data);
    } catch (e) {
      setMsg({ type: "error", text: "❌ " + e.message });
    } finally { setLoading(false); }
  };

  // แบบ 1 (ปกส) — เฉพาะคนที่จ่ายประกันสังคม (พนักงานประจำ)
  const ssRows   = result ? result.results.filter(r => r.social_security > 0) : [];
  // แบบ 2 (เซ็นรับเงิน) — ทุกคนที่มีรายได้
  const signRows = result ? result.results.filter(r => r.total_income > 0) : [];

  const ssTotalSalary = ssRows.reduce((a,r) => a + ssBase(r), 0);
  const ssTotalSS     = ssRows.reduce((a,r) => a + r.social_security, 0);
  const signTotal     = signRows.reduce((a,r) => a + r.total_income, 0);

  const periodLabel = `1-${result?.daysInMonth || ""} ${MONTHS_TH[month]} ${year}`;

  // ── พิมพ์ (ใช้ iframe ซ่อน เลี่ยงบั๊ก popup บน iOS) ──
  function handlePrint() {
    if (!result) return;
    const esc = (str) => String(str==null?"":str).replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
    const m   = (n) => Number(n||0).toLocaleString("th-TH",{ minimumFractionDigits:2, maximumFractionDigits:2 });
    const blank = '<span class="hid">__________</span>';

    let title, headCols, bodyRows, footCols, note;

    if (view === "ss") {
      title = "สรุปประกันสังคม (ส่งสำนักงานบัญชี)";
      headCols = `<th class="c-no">ลำดับ</th><th class="c-name">ชื่อ-นามสกุล</th>
        <th class="c-num">เงินเดือน</th><th class="c-num">ประกันสังคม</th>`;
      bodyRows = ssRows.map((r,i) => `
        <tr>
          <td class="c-no">${i+1}</td>
          <td class="c-name">${esc(r.full_name || r.nickname)}</td>
          <td class="c-num">${hide ? blank : m(ssBase(r))}</td>
          <td class="c-num">${hide ? blank : m(r.social_security)}</td>
        </tr>`).join("");
      footCols = `<td class="c-no"></td><td class="c-name">รวม (${ssRows.length} คน)</td>
        <td class="c-num">${hide ? blank : m(ssTotalSalary)}</td>
        <td class="c-num">${hide ? blank : m(ssTotalSS)}</td>`;
      note = "นำส่งเงินสมทบประกันสังคม";
    } else {
      title = "ใบเซ็นรับเงินเดือน";
      headCols = `<th class="c-no">ลำดับ</th><th class="c-name">ชื่อ-นามสกุล</th>
        <th class="c-num">รายได้</th><th class="c-sign">ลายเซ็นผู้รับเงิน</th>`;
      bodyRows = signRows.map((r,i) => `
        <tr>
          <td class="c-no">${i+1}</td>
          <td class="c-name">${esc(r.full_name || r.nickname)}<span class="nick">(${esc(r.nickname)})</span></td>
          <td class="c-num">${hide ? blank : m(r.total_income)}</td>
          <td class="c-sign"></td>
        </tr>`).join("");
      footCols = `<td class="c-no"></td><td class="c-name">รวม (${signRows.length} คน)</td>
        <td class="c-num">${hide ? blank : m(signTotal)}</td>
        <td class="c-sign"></td>`;
      note = "ลงลายมือชื่อเพื่อรับเงิน";
    }

    const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">
      <title>${esc(title)}</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Sarabun','Tahoma',sans-serif; color:#1e293b; padding:9mm 12mm; }
        @page { size:A4 portrait; margin:0; }
        .head { text-align:center; margin-bottom:3mm; }
        .co { font-size:17px; font-weight:800; color:#1e3a5f; }
        .ti { font-size:15px; font-weight:700; margin-top:1.5mm; }
        .pe { font-size:12px; color:#475569; margin-top:1mm; }
        table { width:100%; border-collapse:collapse; font-size:13px; }
        th, td { border:1px solid #94a3b8; padding:1.5mm 3mm; }
        th { background:#e2e8f0; font-weight:700; }
        .c-no   { width:12mm; text-align:center; }
        .c-name { text-align:left; }
        .c-num  { width:32mm; text-align:right; font-variant-numeric:tabular-nums; }
        .c-sign { width:55mm; }
        .nick { color:#64748b; font-size:11px; margin-left:5px; }
        tfoot td { font-weight:800; background:#f1f5f9; }
        .hid { color:#cbd5e1; letter-spacing:1px; }
        tbody tr { height:8mm; }
        .foot-note { margin-top:4mm; font-size:11px; color:#64748b; }
        .sigbox { margin-top:8mm; display:flex; justify-content:flex-end; }
        .sigbox .b { text-align:center; font-size:12px; }
        .sigbox .ln { border-bottom:1px solid #1e293b; width:60mm; margin-bottom:1.5mm; height:9mm; }
      </style></head><body>
        <div class="head">
          <div class="co">บริษัท กิจมั่งมีโฮม จำกัด</div>
          <div class="ti">${esc(title)}</div>
          <div class="pe">ประจำเดือน ${esc(periodLabel)}</div>
        </div>
        <table>
          <thead><tr>${headCols}</tr></thead>
          <tbody>${bodyRows}</tbody>
          <tfoot><tr>${footCols}</tr></tfoot>
        </table>
        <div class="foot-note">หมายเหตุ: ${esc(note)}</div>
        <div class="sigbox"><div class="b"><div class="ln"></div>ผู้จัดทำ / ผู้จ่ายเงิน<br>วันที่ ......./......./.......</div></div>
      </body></html>`;

    const iframe = document.createElement("iframe");
    iframe.style.position="fixed"; iframe.style.right="0"; iframe.style.bottom="0";
    iframe.style.width="0"; iframe.style.height="0"; iframe.style.border="0";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    iframe.onload = () => {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      catch(e) { setMsg({ type:"error", text:"❌ พิมพ์ไม่สำเร็จ: " + e.message }); }
      setTimeout(() => { document.body.removeChild(iframe); }, 1000);
    };
  }

  return (
    <div style={st.page}>
      {/* ── เลือกงวด ── */}
      <div style={st.topBar}>
        <div style={st.periodPicker}>
          <label style={st.label}>ปี (พ.ศ.)</label>
          <input type="number" value={year} onChange={e => setYear(+e.target.value)}
            style={st.input} min={2560} max={2580} />
          <label style={st.label}>เดือน</label>
          <select value={month} onChange={e => setMonth(+e.target.value)} style={st.select}>
            {MONTHS_TH.slice(1).map((mn, i) => (<option key={i+1} value={i+1}>{mn}</option>))}
          </select>
        </div>
        <button onClick={handleCalc} disabled={loading} style={{ ...st.btn, ...st.btnPrimary }}>
          {loading ? "⏳ กำลังคำนวณ..." : "🧮 คำนวณ"}
        </button>
      </div>

      {msg && (
        <div style={{ ...st.msgBox, background:"#fef2f2", borderColor:"#fca5a5", color:"#991b1b" }}>
          {msg.text}
        </div>
      )}

      {result && (
        <>
          {/* ── แถบควบคุม: เลือกแบบ + ปิดข้อมูล + พิมพ์ ── */}
          <div style={st.ctrlBar}>
            <div style={st.segment}>
              <button onClick={() => setView("ss")}
                style={{ ...st.segBtn, ...(view==="ss" ? st.segActive : {}) }}>
                📋 ปกส (ส่งบัญชี)
              </button>
              <button onClick={() => setView("sign")}
                style={{ ...st.segBtn, ...(view==="sign" ? st.segActive : {}) }}>
                ✍️ เซ็นรับเงิน
              </button>
            </div>

            <label style={{ ...st.hideToggle, ...(hide ? st.hideToggleOn : {}) }}>
              <input type="checkbox" checked={hide} onChange={e => setHide(e.target.checked)}
                style={{ width:16, height:16 }} />
              🔒 ปิดข้อมูล (ซ่อนยอดเงิน)
            </label>

            <button onClick={handlePrint} style={{ ...st.btn, ...st.btnPrint }}>
              🖨 พิมพ์
            </button>
          </div>

          {hide && (
            <div style={st.hideNote}>
              🔒 โหมดปิดข้อมูล: ยอดเงินถูกซ่อน — พิมพ์ออกมาให้พนักงานเซ็น แล้วตัดช่องลายเซ็นไปประกบแผ่นจริง
            </div>
          )}

          {/* ── ตัวอย่างบนจอ ── */}
          <div style={st.previewWrap}>
            <div style={st.sheetHead}>
              <div style={st.coName}>บริษัท กิจมั่งมีโฮม จำกัด</div>
              <div style={st.sheetTitle}>
                {view==="ss" ? "สรุปประกันสังคม (ส่งสำนักงานบัญชี)" : "ใบเซ็นรับเงินเดือน"}
              </div>
              <div style={st.sheetPeriod}>ประจำเดือน {periodLabel}</div>
            </div>

            {view === "ss" ? (
              <table style={st.table}>
                <thead><tr>
                  <th style={{ ...st.th, width:50 }}>ลำดับ</th>
                  <th style={{ ...st.th, textAlign:"left" }}>ชื่อ-นามสกุล</th>
                  <th style={{ ...st.th, textAlign:"right" }}>เงินเดือน</th>
                  <th style={{ ...st.th, textAlign:"right" }}>ประกันสังคม</th>
                </tr></thead>
                <tbody>
                  {ssRows.map((r,i) => (
                    <tr key={r.employee_id}>
                      <td style={{ ...st.td, textAlign:"center" }}>{i+1}</td>
                      <td style={st.td}>{r.full_name || r.nickname}</td>
                      <td style={{ ...st.td, textAlign:"right" }}>{hide ? <Hid/> : fmt(ssBase(r))}</td>
                      <td style={{ ...st.td, textAlign:"right" }}>{hide ? <Hid/> : fmt(r.social_security)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr style={st.footRow}>
                  <td style={st.td}></td>
                  <td style={st.td}>รวม ({ssRows.length} คน)</td>
                  <td style={{ ...st.td, textAlign:"right" }}>{hide ? <Hid/> : fmt(ssTotalSalary)}</td>
                  <td style={{ ...st.td, textAlign:"right" }}>{hide ? <Hid/> : fmt(ssTotalSS)}</td>
                </tr></tfoot>
              </table>
            ) : (
              <table style={st.table}>
                <thead><tr>
                  <th style={{ ...st.th, width:50 }}>ลำดับ</th>
                  <th style={{ ...st.th, textAlign:"left" }}>ชื่อ-นามสกุล</th>
                  <th style={{ ...st.th, textAlign:"right" }}>รายได้</th>
                  <th style={{ ...st.th, width:200 }}>ลายเซ็นผู้รับเงิน</th>
                </tr></thead>
                <tbody>
                  {signRows.map((r,i) => (
                    <tr key={r.employee_id} style={{ height:38 }}>
                      <td style={{ ...st.td, textAlign:"center" }}>{i+1}</td>
                      <td style={st.td}>{r.full_name || r.nickname}
                        <span style={st.nick}>({r.nickname})</span></td>
                      <td style={{ ...st.td, textAlign:"right" }}>{hide ? <Hid/> : fmt(r.total_income)}</td>
                      <td style={st.td}></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr style={st.footRow}>
                  <td style={st.td}></td>
                  <td style={st.td}>รวม ({signRows.length} คน)</td>
                  <td style={{ ...st.td, textAlign:"right" }}>{hide ? <Hid/> : fmt(signTotal)}</td>
                  <td style={st.td}></td>
                </tr></tfoot>
              </table>
            )}
          </div>
        </>
      )}

      {!result && !loading && (
        <p style={{ color:"#94a3b8", textAlign:"center", padding:40 }}>
          เลือกเดือนแล้วกด “คำนวณ” เพื่อดูสรุป
        </p>
      )}
    </div>
  );
}

function Hid() {
  return <span style={{ color:"#cbd5e1", letterSpacing:1 }}>__________</span>;
}

const st = {
  page: { maxWidth:"100%", margin:"0 auto" },
  topBar: { display:"flex", alignItems:"flex-end", gap:12, marginBottom:12,
    flexWrap:"wrap", background:"#fff", padding:16, borderRadius:12,
    boxShadow:"0 1px 4px rgba(0,0,0,0.08)" },
  periodPicker: { display:"flex", alignItems:"center", gap:8, flex:1, flexWrap:"wrap" },
  label:  { fontSize:13, color:"#64748b", fontWeight:600 },
  input:  { width:80, padding:"6px 10px", border:"1.5px solid #e2e8f0", borderRadius:8, fontSize:14, textAlign:"center" },
  select: { padding:"6px 10px", border:"1.5px solid #e2e8f0", borderRadius:8, fontSize:14 },
  btn: { padding:"10px 20px", borderRadius:10, border:"none", fontWeight:700, fontSize:14, cursor:"pointer" },
  btnPrimary: { background:"#2563eb", color:"#fff" },
  btnPrint:   { background:"#7c3aed", color:"#fff" },
  msgBox: { padding:"10px 14px", borderRadius:8, border:"1px solid", marginBottom:12, fontWeight:600, fontSize:14 },
  ctrlBar: { display:"flex", alignItems:"center", gap:12, marginBottom:12, flexWrap:"wrap",
    background:"#fff", padding:12, borderRadius:12, boxShadow:"0 1px 4px rgba(0,0,0,0.06)" },
  segment: { display:"flex", border:"1.5px solid #e2e8f0", borderRadius:10, overflow:"hidden" },
  segBtn: { padding:"8px 16px", border:"none", background:"#fff", color:"#64748b",
    fontWeight:700, fontSize:13, cursor:"pointer" },
  segActive: { background:"#1e3a5f", color:"#fff" },
  hideToggle: { display:"flex", alignItems:"center", gap:7, fontSize:13, fontWeight:600,
    color:"#475569", cursor:"pointer", padding:"6px 12px", borderRadius:10,
    border:"1.5px solid #e2e8f0" },
  hideToggleOn: { background:"#fef3c7", borderColor:"#fcd34d", color:"#92400e" },
  hideNote: { padding:"8px 14px", borderRadius:8, background:"#fffbeb", border:"1px solid #fde68a",
    color:"#92400e", fontSize:13, marginBottom:12, fontWeight:600 },
  previewWrap: { background:"#fff", borderRadius:12, padding:"22px 26px",
    boxShadow:"0 1px 4px rgba(0,0,0,0.08)", overflowX:"auto" },
  sheetHead: { textAlign:"center", marginBottom:16 },
  coName: { fontSize:18, fontWeight:800, color:"#1e3a5f" },
  sheetTitle: { fontSize:15, fontWeight:700, marginTop:4 },
  sheetPeriod: { fontSize:12, color:"#475569", marginTop:3 },
  table: { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th: { border:"1px solid #94a3b8", padding:"7px 10px", background:"#e2e8f0", fontWeight:700, textAlign:"center" },
  td: { border:"1px solid #cbd5e1", padding:"7px 10px" },
  footRow: { background:"#f1f5f9", fontWeight:800 },
  nick: { color:"#64748b", fontSize:11, marginLeft:6 },
};
