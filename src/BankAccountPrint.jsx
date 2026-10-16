// src/BankAccountPrint.jsx
// 🆕 16ต.ค.69 ใบยืนยันหมายเลขบัญชี — หน้าปริ้น A4 หน้าเดียว (เปิดจาก BankAccountPanel)
import { useState } from 'react'
import { createPortal } from 'react-dom'

const digits = (s) => String(s || '').replace(/[^0-9]/g, '')

// ─────────────────────────────────────────────
// หน้าปริ้น A4 หน้าเดียว
//   เลขบัตรประชาชน/ที่อยู่ กรอกได้เฉพาะที่นี่ (state ในหน่วยความจำ) — ปิดหน้านี้แล้วหายทันที
// ─────────────────────────────────────────────
function Line({ value, min = 120, grow }) {
  return (
    <span className="bk-line" style={{ minWidth: min, flex: grow ? 1 : undefined }}>
      {value ? value : ' '}
    </span>
  )
}
function Box({ on }) { return <span className="bk-box">{on ? '✓' : ' '}</span> }

function fmtAcc(s) {
  const d = digits(s)
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 4)}-${d.slice(4, 9)}-${d.slice(9)}` : d
}

export default function BankAccountPrint({ emp, position, form, onBack }) {
  // ⚠️ อยู่ในหน่วยความจำเท่านั้น ห้ามส่งออกไปไหน
  const [idNo, setIdNo] = useState('')
  const [addr, setAddr] = useState('')
  const [docDate, setDocDate] = useState('')

  const pm = form.pay_method
  const inp = { height: 32, borderRadius: 6, border: '0.5px solid #ccc', padding: '0 8px', boxSizing: 'border-box' }
  const idDigits = digits(idNo).slice(0, 13).padEnd(13, ' ').split('')

  // วางไว้ใต้ body ตรง ๆ — ตอนปริ้นซ่อนทุกอย่างอื่น ใบจะออกมาหน้าเดียว
  return createPortal(
    <div className="bk-print-root" style={{ position: 'fixed', inset: 0, background: '#e9e9e6', zIndex: 200, overflowY: 'auto' }}>
      <style>{PRINT_CSS}</style>
      <div className="bk-noprint" style={{ background: '#fff', borderBottom: '0.5px solid #ddd', padding: '10px 16px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 1 }}>
        <button onClick={onBack} style={{ background: 'none', border: '0.5px solid #ccc', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}>← กลับ</button>
        <input value={idNo} onChange={e => setIdNo(digits(e.target.value).slice(0, 13))} placeholder="เลขบัตรประชาชน (ไม่บันทึก)" inputMode="numeric" autoComplete="off" style={{ ...inp, width: 200 }} />
        <input value={addr} onChange={e => setAddr(e.target.value)} placeholder="ที่อยู่ (ไม่บันทึก)" autoComplete="off" style={{ ...inp, flex: 1, minWidth: 200 }} />
        <input type="date" value={docDate} onChange={e => setDocDate(e.target.value)} title="วันที่ในใบ (ว่าง = เขียนมือ)" style={inp} />
        <button onClick={() => window.print()} style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 16px', cursor: 'pointer', fontWeight: 500 }}>🖨 ปริ้น</button>
        <div style={{ width: '100%', fontSize: 11, color: '#999' }}>เลขบัตรประชาชนและที่อยู่ ใช้พิมพ์ลงใบเท่านั้น ระบบไม่เก็บ — ปิดหน้านี้แล้วหายทันที · ช่องที่ว่างจะเป็นเส้นไข่ปลาให้เขียนมือ</div>
      </div>

      <div className="bk-sheet">
        <div className="bk-head">
          <div className="bk-title">หนังสือยืนยันหมายเลขบัญชี</div>
          <div className="bk-sub">สำหรับรับเงินเดือน / ค่าจ้าง</div>
          <div className="bk-co">บริษัท กิจมั่งมีโฮม จำกัด</div>
        </div>

        <div className="bk-row" style={{ justifyContent: 'flex-end' }}>
          วันที่ <Line value={docDate ? thaiDate(docDate) : ''} min={200} />
        </div>

        <div className="bk-row">ข้าพเจ้า (ชื่อ-สกุล) <Line value={emp.full_name} grow /></div>
        <div className="bk-row">
          ชื่อเล่น <Line value={emp.nickname} min={130} />
          รหัสพนักงาน <Line value={emp.emp_code} min={110} />
          ตำแหน่ง <Line value={position} grow />
        </div>
        <div className="bk-row">
          เลขประจำตัวประชาชน
          <span className="bk-id">
            {idDigits.map((c, i) => (
              <span key={i} className={'bk-idc' + ([1, 5, 10, 12].includes(i) ? ' bk-gap' : '')}>{c.trim() || ' '}</span>
            ))}
          </span>
        </div>
        <div className="bk-row">ที่อยู่ <Line value={addr} grow /></div>
        {!addr && <div className="bk-row"><Line grow /></div>}

        <div className="bk-para">
          มีความประสงค์ให้บริษัทฯ จ่ายเงินเดือน ค่าจ้าง และเงินอื่นใดที่ข้าพเจ้าพึงได้รับจากบริษัทฯ ด้วยวิธีดังนี้ (เลือก 1 ข้อ)
        </div>

        <div className="bk-opt">
          <div className="bk-row"><Box on={pm === 'transfer'} /> <b>โอนเข้าบัญชีธนาคาร</b></div>
          <div className="bk-row bk-ind">
            ธนาคาร <Line value={pm === 'transfer' ? form.bank_name : ''} min={170} />
            เลขที่บัญชี <Line value={pm === 'transfer' ? fmtAcc(form.account_no) : ''} grow />
          </div>
          <div className="bk-row bk-ind">ชื่อบัญชี <Line value={pm === 'transfer' ? form.account_name : ''} grow /></div>
        </div>

        <div className="bk-opt">
          <div className="bk-row"><Box on={pm === 'promptpay'} /> <b>โอนเข้าพร้อมเพย์</b></div>
          <div className="bk-row bk-ind">
            หมายเลขพร้อมเพย์ <Line value={pm === 'promptpay' ? form.promptpay_id : ''} min={170} />
            ธนาคาร <Line value={pm === 'promptpay' ? form.bank_name : ''} grow />
          </div>
          <div className="bk-row bk-ind">ชื่อบัญชี <Line value={pm === 'promptpay' ? form.account_name : ''} grow /></div>
        </div>

        <div className="bk-opt">
          <div className="bk-row"><Box on={pm === 'cash'} /> <b>รับเป็นเงินสด</b></div>
          <div className="bk-row bk-ind">เหตุผล <Line value={pm === 'cash' ? form.cash_reason : ''} grow /></div>
        </div>

        <div className="bk-para">
          ข้าพเจ้าขอยืนยันว่าบัญชีข้างต้นเป็นบัญชีของข้าพเจ้าเอง และข้อมูลทั้งหมดถูกต้อง
          พร้อมแนบสำเนาหน้าสมุดบัญชีเป็นหลักฐาน หากมีการเปลี่ยนแปลงข้าพเจ้าจะแจ้งฝ่ายบุคคลเป็นลายลักษณ์อักษรทันที
        </div>

        <div className="bk-signs">
          {['พนักงาน', 'ผู้รับเอกสาร (ฝ่ายบุคคล)'].map((t, i) => (
            <div key={t} className="bk-sign">
              <div className="bk-row">ลงชื่อ <Line grow /></div>
              <div className="bk-row">(<Line value={i === 0 ? emp.full_name : ''} grow />)</div>
              <div className="bk-cap">{t}</div>
              <div className="bk-row">วันที่ <Line grow /></div>
            </div>
          ))}
        </div>

        <div className="bk-foot">แนบ: สำเนาหน้าสมุดบัญชีธนาคาร (หน้าที่มีชื่อและเลขที่บัญชี)</div>
      </div>
    </div>,
    document.body
  )
}

const TH_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
function thaiDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${TH_MONTH[m - 1]} ${y + 543}`
}

const PRINT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
.bk-sheet { width: 210mm; min-height: 297mm; margin: 16px auto; background: #fff; box-sizing: border-box;
  padding: 16mm 18mm; font-family: 'Sarabun', 'Tahoma', sans-serif; font-size: 17px; color: #000; line-height: 1.5;
  box-shadow: 0 1px 6px rgba(0,0,0,.15); }
.bk-head { text-align: center; margin-bottom: 14px; }
.bk-title { font-size: 24px; font-weight: 700; }
.bk-sub { font-size: 15px; color: #333; }
.bk-co { font-size: 18px; font-weight: 600; margin-top: 4px; }
.bk-row { display: flex; align-items: flex-end; gap: 8px; margin: 11px 0; white-space: nowrap; }
.bk-ind { padding-left: 30px; }
.bk-line { display: inline-block; border-bottom: 1.5px dotted #000; padding: 0 6px; min-height: 1.4em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.bk-box { display: inline-flex; width: 18px; height: 18px; border: 1.5px solid #000; align-items: center;
  justify-content: center; font-size: 14px; font-weight: 700; margin-bottom: 3px; }
.bk-id { display: inline-flex; gap: 0; margin-left: 6px; }
.bk-idc { display: inline-flex; width: 22px; height: 26px; border: 1px solid #000; margin-left: -1px;
  align-items: center; justify-content: center; font-weight: 600; }
.bk-gap { margin-left: 8px; }
.bk-para { margin: 14px 0 8px; text-indent: 2.5em; line-height: 1.7; white-space: normal; }
.bk-opt { margin: 4px 0 6px; }
.bk-signs { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 44px; }
.bk-sign .bk-cap { text-align: center; margin-top: -4px; }
.bk-foot { margin-top: 26px; font-size: 13.5px; color: #333; border-top: 0.5px solid #999; padding-top: 6px; }
@media print {
  @page { size: A4; margin: 0; }
  html, body { background: #fff !important; }
  body > *:not(.bk-print-root) { display: none !important; }
  .bk-noprint { display: none !important; }
  .bk-print-root { position: static !important; background: #fff !important; overflow: visible !important; }
  .bk-sheet { margin: 0; box-shadow: none; height: 297mm; min-height: 0; overflow: hidden; }
}
`
