// src/MonthSlip.jsx
// ─────────────────────────────────────────────────────────────
// "ใบสรุปรายเดือน" — ป็อปอัปดูอย่างเดียว เปิดจากหน้า 📊 สรุปรายปี (แยกรายเดือน)
// 2 ต.ค. 69 เจ้าของขอ: อยากเห็นรายละเอียดข้างในเดือน (ยอดที่จ่ายจริง แยกรายการหัก)
//
// อ่านจากของที่บันทึกไว้แล้วเท่านั้น — ไม่คิดเงินเดือนใหม่ ไม่มีปุ่มแก้ไข:
//   • payroll_records       = ยอดงวด (รายได้/หัก/สุทธิ)
//   • deductions            = รายการหักทีละครั้ง (เบิก ผ่อนเงินกู้ ฯลฯ) ในเดือนนั้น
//   • extra_income_entries  = รายได้พิเศษ (income_type='other')
//   • payout_vouchers.lines = เงินที่จ่ายออกจริงแต่ละรอบ (เสาร์ / สิ้นเดือน / เคลียลาออก)
// ท้ายใบเทียบ "รวมจ่ายจริง" กับ "รับสุทธิ" ให้เอง
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

const TH_MONTH = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
const money = n => Number(n||0).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2});
const plain = n => { const x=Number(n||0); return Number.isInteger(x)?x.toLocaleString("th-TH"):x.toLocaleString("th-TH",{maximumFractionDigits:2}); };
const pad2 = n => String(n).padStart(2,"0");
const dShort = iso => { if(!iso) return ""; const [,m,d]=String(iso).split("-").map(Number); return `${d} ${TH_MONTH[m]}`; };

export default function MonthSlip({ emp, year, month, agg, onClose }){
  const [st,setSt] = useState({ loading:true });

  useEffect(()=>{
    let dead=false;
    (async()=>{
      try{
        const from=`${year}-${pad2(month)}-01`;
        const last=new Date(year, month, 0).getDate();
        const to=`${year}-${pad2(month)}-${pad2(last)}`;
        const perR=await supabase.from("pay_periods").select("id,is_closed,is_month_end_paid").eq("year",year).eq("month",month).maybeSingle();
        if(perR.error) throw perR.error;
        const per=perR.data;
        if(!per){ if(!dead) setSt({ loading:false, none:true }); return; }
        const [recR, dedR, extR, vouR] = await Promise.all([
          supabase.from("payroll_records").select("*").eq("period_id",per.id).eq("employee_id",emp.id).maybeSingle(),
          supabase.from("deductions").select("amount,note,deduct_date,deduction_type_id,deduction_types(name)")
            .eq("employee_id",emp.id).gte("deduct_date",from).lte("deduct_date",to).order("deduct_date"),
          supabase.from("extra_income_entries").select("label,amount,amount_note,income_type")
            .eq("period_id",per.id).eq("employee_id",emp.id),
          supabase.from("payout_vouchers").select("cycle_date,kind,status,employee_id,total_amount,lines").eq("period_id",per.id),
        ]);
        for(const r of [recR,dedR,extR,vouR]) if(r.error) throw r.error;

        const pays=[];
        (vouR.data||[]).forEach(v=>{
          if(v.status==="returned"||v.status==="cancelled") return;
          const ln=(Array.isArray(v.lines)?v.lines:[]).find(l=>l && l.employee_id===emp.id);
          let amt=null;
          if(ln) amt=Number(ln.to_pay||0);
          else if(v.kind==="resign" && v.employee_id===emp.id) amt=Number(v.total_amount||0);
          if(amt==null) return;
          const label = v.kind==="resign" ? "เคลียเงินลาออก" : (v.cycle_date ? "รอบเสาร์ "+dShort(v.cycle_date) : "สิ้นเดือน");
          pays.push({ label, amt, sort: v.kind==="resign" ? "9" : (v.cycle_date||"8"), approved: v.status==="approved" });
        });
        pays.sort((a,b)=>a.sort<b.sort?-1:1);

        if(!dead) setSt({ loading:false, per, rec:recR.data, deds:dedR.data||[], extras:(extR.data||[]).filter(e=>e.income_type==="other"), pays });
      }catch(e){ if(!dead) setSt({ loading:false, err:e.message||String(e) }); }
    })();
    return ()=>{ dead=true; };
  },[emp.id,year,month]);

  const title=`${emp.nickname} · ${TH_MONTH[month]} ${String(year+543).slice(-2)}`;
  let body;
  if(st.loading) body=<div style={S.pad}>กำลังโหลด…</div>;
  else if(st.err) body=<div style={{...S.pad,color:"#b91c1c"}}>โหลดไม่สำเร็จ: {st.err}</div>;
  else if(st.none || !st.rec) body=<div style={S.pad}>ยังไม่มียอดเงินเดือนของเดือนนี้</div>;
  else {
    const r=st.rec;
    const inc=[
      ["เงินเดือน / ค่าแรง (ทำงาน "+plain(r.work_days)+" วัน)", r.base_wage],
      ["ค่าจ้างวันหยุด", r.holiday_wage],
      ["ค่าล่วงเวลา "+plain(r.ot_hours)+" ชม.", r.ot_amount],
      ["เบี้ยขยัน", r.diligence_bonus],
      ["เงินประจำตำแหน่ง", r.position_allowance],
      ["คืนค่าสมัครงาน", r.app_fee_refund],
      ["คืนเงินประกันงาน", r.insurance_refund],
    ].filter(x=>Number(x[1]||0)!==0);
    const extraSum=Number(r.other_income||0);

    // รายการหักจากตาราง deductions จัดกลุ่มตามชนิด (ตรงกับ payrollCalc: ตัด note='เงินออก' ที่ไม่ใช่เบิก)
    const groups=[]; const gi={};
    st.deds.forEach(d=>{
      const name=d.deduction_types?.name||"หักอื่น ๆ";
      const isAdv=name.includes("เบิก");
      if(!isAdv && d.note==="เงินออก") return;
      if(!(name in gi)){ gi[name]=groups.length; groups.push({ name, items:[], sum:0 }); }
      const g=groups[gi[name]]; g.items.push(d); g.sum+=Number(d.amount||0);
    });
    const dedFixed=[
      ["ประกันสังคม", r.social_security],
      ["เงินประกันงาน (สะสมคืนตอนออก)", r.job_insurance],
      ["หักสาย", r.late_deduct],
      ["หักลา / ขาด", r.leave_deduct],
      ["ค่าสมัครงาน", r.app_fee_deduct],
    ].filter(x=>Number(x[1]||0)!==0);
    const listSum=groups.reduce((s,g)=>s+g.sum,0);
    const recList=Number(r.advance_total||0)+Number(r.loan_deduct||0)+Number(r.other_deduct||0);
    const listDiff=Math.round((listSum-recList)*100)/100;

    const paid=st.pays.reduce((s,p)=>s+p.amt,0);
    const payDiff=Math.round((paid-Number(r.net_pay||0))*100)/100;
    const advCash=groups.filter(g=>g.name.includes("เบิก")).reduce((s,g)=>s+g.sum,0);

    body=(
      <div>
        <div style={S.tiles}>
          <div style={{...S.tile,background:"#f0fdf4"}}><div style={{...S.tl,color:"#166534"}}>รายได้รวม</div><div style={{...S.tv,color:"#14532d"}}>{money(r.total_income)}</div></div>
          <div style={{...S.tile,background:"#fef2f2"}}><div style={{...S.tl,color:"#991b1b"}}>หักรวม</div><div style={{...S.tv,color:"#7f1d1d"}}>{money(r.total_deduct)}</div></div>
          <div style={{...S.tile,background:"#1e3a5f"}}><div style={{...S.tl,color:"#cbd5e1"}}>รับสุทธิ</div><div style={{...S.tv,color:"#fff"}}>{money(r.net_pay)}</div></div>
        </div>

        <div style={S.sec}>
          <div style={{...S.h,color:"#1e3a5f"}}>① การทำงาน</div>
          <div style={S.stats}>
            {[["วันทำงาน",r.work_days],["ลากิจ",agg?.personal_days],["ลาป่วย",agg?.sick_days],["วันขาด",agg?.absent_days],["สาย (นาที)",agg?.late_min],["OT (ชม.)",r.ot_hours]].map(([l,v])=>(
              <div key={l} style={S.stat}><div style={{fontSize:18,fontWeight:800}}>{plain(v)}</div><div style={{fontSize:12,color:"#475569"}}>{l}</div></div>
            ))}
          </div>
        </div>

        <div style={S.sec}>
          <div style={{...S.h,color:"#166534"}}>② รายได้</div>
          {inc.map(([l,v])=><div key={l} style={S.row}><span>{l}</span><span>{money(v)}</span></div>)}
          {extraSum!==0 && (
            <div style={S.grp}>
              <div style={S.gh}><span>รายได้พิเศษ</span><span>{money(extraSum)}</span></div>
              {st.extras.map((e,i)=><div key={i} style={S.sub}><span>{e.label||"รายได้อื่น ๆ"}{e.amount_note?" · "+e.amount_note:""}</span><span>{plain(e.amount)}</span></div>)}
            </div>
          )}
          <div style={{...S.row,borderBottom:"none",fontWeight:800,color:"#14532d"}}><span>รวมรายได้</span><span>{money(r.total_income)}</span></div>
        </div>

        <div style={S.sec}>
          <div style={{...S.h,color:"#991b1b"}}>③ หัก</div>
          {dedFixed.map(([l,v])=><div key={l} style={S.row}><span>{l}</span><span>{money(v)}</span></div>)}
          {groups.map(g=>(
            <div key={g.name} style={S.grp}>
              <div style={S.gh}><span>{g.name} {g.items.length} ครั้ง</span><span>{money(g.sum)}</span></div>
              {g.items.map((d,i)=><div key={i} style={S.sub}><span>{dShort(d.deduct_date)}{d.note?" · "+d.note:""}</span><span>{plain(d.amount)}</span></div>)}
            </div>
          ))}
          {listDiff!==0 && <div style={S.warn}>⚠️ รายการหักทีละครั้งรวมได้ {money(listSum)} แต่ยอดในงวดบันทึกไว้ {money(recList)} (ต่างกัน {money(listDiff)}) อาจมีการปรับยอดด้วยมือ</div>}
          <div style={{...S.row,borderBottom:"none",fontWeight:800,color:"#7f1d1d"}}><span>รวมหัก</span><span>{money(r.total_deduct)}</span></div>
        </div>

        <div style={{...S.sec,paddingBottom:20}}>
          <div style={{...S.h,color:"#1e3a5f"}}>④ จ่ายจริง</div>
          {st.pays.length===0 && <div style={{...S.row,color:"#64748b"}}>ยังไม่มีใบจ่ายเงินของเดือนนี้</div>}
          {st.pays.map((p,i)=><div key={i} style={S.row}><span>{p.label}{p.approved?"":" (ยังไม่อนุมัติ)"}</span><span>{money(p.amt)}</span></div>)}
          {st.pays.length>0 && (payDiff===0
            ? <div style={S.ok}>รวมจ่าย {money(paid)} · ตรงกับรับสุทธิ ✓</div>
            : <div style={S.warn}>⚠️ รวมจ่าย {money(paid)} ไม่ตรงกับรับสุทธิ {money(r.net_pay)} (ต่างกัน {money(payDiff)})</div>)}
          {advCash>0 && <div style={{fontSize:13,color:"#475569",paddingTop:6}}>เงินเบิก {money(advCash)} ได้รับเป็นเงินสดไปแล้วตอนเบิก · รวมเงินที่ได้จริงทั้งเดือน {money(Number(r.net_pay||0)+advCash)}</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.box} onClick={e=>e.stopPropagation()} role="dialog" aria-label={"ใบสรุปรายเดือน "+title}>
        <div style={S.head}>
          <div>
            <div style={{fontSize:13,color:"#cbd5e1"}}>ใบสรุปรายเดือน · {emp.emp_code}</div>
            <div style={{fontSize:21,fontWeight:800}}>{title}</div>
          </div>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            {st.per && <span style={st.per.is_closed?S.badgeClosed:S.badgeOpen}>{st.per.is_closed?"งวดปิดแล้ว · ดูอย่างเดียว":"งวดยังเปิด · ดูอย่างเดียว"}</span>}
            <button aria-label="ปิด" onClick={onClose} style={S.x}>✕</button>
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}

const S={
  overlay:{position:"fixed",inset:0,background:"rgba(15,23,42,.45)",display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"24px 12px",overflowY:"auto",zIndex:1000},
  box:{background:"#fff",borderRadius:14,width:"100%",maxWidth:600,overflow:"hidden",fontSize:15,color:"#1e293b",boxShadow:"0 10px 30px rgba(0,0,0,.2)"},
  head:{background:"#1e3a5f",color:"#fff",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10},
  x:{width:38,height:38,borderRadius:8,border:"none",background:"#334e72",color:"#fff",fontSize:18,cursor:"pointer"},
  badgeClosed:{background:"#fef2f2",color:"#991b1b",fontSize:12,fontWeight:700,padding:"4px 10px",borderRadius:20},
  badgeOpen:{background:"#fef3c7",color:"#92400e",fontSize:12,fontWeight:700,padding:"4px 10px",borderRadius:20},
  pad:{padding:24,color:"#475569"},
  tiles:{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10,padding:"16px 20px 6px"},
  tile:{borderRadius:10,padding:"10px 12px"},
  tl:{fontSize:12}, tv:{fontSize:19,fontWeight:800},
  sec:{padding:"10px 20px",display:"flex",flexDirection:"column",gap:2},
  h:{fontWeight:800,fontSize:16,marginBottom:4},
  stats:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(80px,1fr))",gap:8,textAlign:"center"},
  stat:{border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 4px"},
  row:{display:"flex",justifyContent:"space-between",gap:12,padding:"6px 0",borderBottom:"1px solid #f1f5f9"},
  grp:{display:"flex",flexDirection:"column",gap:3,padding:"6px 0",borderBottom:"1px solid #f1f5f9"},
  gh:{display:"flex",justifyContent:"space-between",gap:12},
  sub:{display:"flex",justifyContent:"space-between",gap:12,fontSize:13,color:"#475569",paddingLeft:14},
  ok:{marginTop:6,padding:"8px 12px",background:"#f0fdf4",borderRadius:8,fontWeight:800,color:"#14532d"},
  warn:{marginTop:6,padding:"8px 12px",background:"#fef2f2",borderRadius:8,fontWeight:700,color:"#991b1b",fontSize:14},
};
