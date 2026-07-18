// src/AnnualSummaryPage.jsx
// ─────────────────────────────────────────────────────────────
// หน้า "สรุปข้อมูลพนักงานรายปี" (ดึงข้อมูลสดจาก Supabase)
// 2 โหมด: (1) สรุปรายปี  (2) เลือกเอง/รายเดือน (ติ๊กคอลัมน์ + แยกรายเดือน)
//
// นิยามตัวเลข (ยึดตาม payrollCalc.js + ตารางจริง — ให้ตรงกับที่จ่ายจริง):
//   • วันทำงาน   = payroll_records.work_days (ขาดครึ่งวัน=0.5 · ขาด/ลาไม่จ่าย ตัดออก)
//   • รายได้รวม  = total_income (รวม OT+โบนัส)   · จ่ายสุทธิ = net_pay
//   • ลากิจ/ลาป่วย = leave_requests (วัน=1, ชม.=hours/8) — เทียบโควตากับ leave_balances
//   • ขาด        = attendance_logs.hr_note ("ขาดงาน"=1, "ขาดงานครึ่งวัน"=0.5)
//   • มาสแกนจริง = จำนวนวันที่มี scan_am_in (โชว์ในป็อปอัปรายคน)
//   • สถานะทดลอง/ประจำ รายเดือน = ตัดจาก employees.permanent_start_date (วันบรรจุ)
//        เดือนก่อนวันบรรจุ=ทดลอง · ตั้งแต่วันบรรจุ=ประจำ · บรรจุกลางเดือน=แยกตามวัน
//   • ทดลองงาน  = emp_type='trial' และยังไม่มีวันบรรจุ ; นับถอยหลังครบ 120 วันจาก trial_start_date
// ─────────────────────────────────────────────────────────────
import { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";

const TH_MONTH = ["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
const PROBATION_DAYS = 120, URGENT_DAYS = 15;
const baht = n => Number(n||0).toLocaleString("th-TH",{maximumFractionDigits:0});
const num  = n => { const x=Number(n||0); return Number.isInteger(x)?x:x.toFixed(1); };
const pd   = s => { if(!s) return null; const [y,m,d]=String(s).split("-").map(Number); return new Date(y,m-1,d); };
const dayDiff = (a,b) => Math.round((a-b)/86400000);
const beShort = d => `${d.getDate()} ${TH_MONTH[d.getMonth()+1]} ${String(d.getFullYear()+543).slice(-2)}`;

const METRICS = [
  { key:"pay_work_days", label:"วันทำงาน",  unit:"day",   def:true },
  { key:"leave_total",   label:"วันลารวม",  unit:"day",   def:true, calc:r=>Number(r.personal_days)+Number(r.sick_days) },
  { key:"personal_days", label:"ลากิจ",     unit:"day" },
  { key:"sick_days",     label:"ลาป่วย",    unit:"day" },
  { key:"absent_days",   label:"วันขาด",    unit:"day",   def:true },
  { key:"late_min",      label:"สาย (นาที)",unit:"num" },
  { key:"ot_hours",      label:"OT (ชม.)",  unit:"num" },
  { key:"total_income",  label:"รายได้รวม", unit:"money", def:true },
  { key:"total_deduct",  label:"ยอดหัก",    unit:"money" },
  { key:"net_pay",       label:"จ่ายสุทธิ", unit:"money" },
];
const getVal = (rec,key) => { if(!rec) return 0; const m=METRICS.find(x=>x.key===key); return m&&m.calc?m.calc(rec):Number(rec[key]||0); };
const fmtVal = (v,unit) => unit==="money" ? baht(v) : num(v);

function monthStatus(permStr, isTrial, y, mm){
  const P=pd(permStr), ms=new Date(y,mm-1,1), me=new Date(y,mm,0);
  if(P){ if(ms>=P) return "perm"; if(me<P) return "trial"; return "mixed"; }
  return isTrial ? "trial" : "perm";
}
const curStatus = (permStr,isTrial,ref) => { const P=pd(permStr); return (P&&ref>=P)?"perm":(isTrial?"trial":"perm"); };
function splitMixed(permStr, y, mm, v){
  const P=pd(permStr), total=new Date(y,mm,0).getDate();
  const tdays=Math.max(0,Math.min(total,P.getDate()-1)), ratio=total?tdays/total:0;
  const t=Math.round(v*ratio*10)/10; return { t, p:Math.round((v-t)*10)/10 };
}
const statusTag = s => s==="perm"
  ? '<span class="chip c-perm">ประจำ</span>'
  : s==="trial" ? '<span class="chip c-trial">ทดลอง</span>' : '<span class="chip c-mixed">ทดลอง→ประจำ</span>';

export default function AnnualSummaryPage({ role }){
  const now = new Date();
  const REF = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [year,setYear]       = useState(now.getFullYear());
  const [loading,setLoading] = useState(true);
  const [err,setErr]         = useState(null);
  const [db,setDb]           = useState({ rowsY:[], monthMap:{}, months:[] });

  const [tab,setTab]         = useState("year");
  const [statusF,setStatusF] = useState("active");
  const [q,setQ]             = useState("");
  const [sortKey,setSortKey] = useState("emp_code");
  const [sortDir,setSortDir] = useState(1);
  const [open,setOpen]       = useState({});

  const [sel,setSel]         = useState(new Set(METRICS.filter(m=>m.def).map(m=>m.key)));
  const [cView,setCView]     = useState("year");
  const [cStatusF,setCStatusF]=useState("active");
  const [cq,setCq]           = useState("");

  useEffect(()=>{ loadYear(year); /* eslint-disable-next-line */ }, [year]);

  async function loadYear(y){
    setLoading(true); setErr(null);
    try{
      const from=`${y}-01-01`, to=`${y}-12-31`;
      const [empR, perR, attR, lvR, lbR] = await Promise.all([
        supabase.from("employees").select("id,emp_code,nickname,full_name,emp_type,is_active,probation,trial_start_date,permanent_start_date").order("emp_code"),
        supabase.from("pay_periods").select("id,month").eq("year",y),
        supabase.from("attendance_logs").select("employee_id,work_date,scan_am_in,hr_note,late_minutes,ot_hours,needs_hr_review").gte("work_date",from).lte("work_date",to).limit(50000),
        supabase.from("leave_requests").select("employee_id,leave_type,leave_date,unit,hours").gte("leave_date",from).lte("leave_date",to).limit(50000),
        supabase.from("leave_balances").select("employee_id,sick_quota,sick_used,personal_quota,personal_used").eq("year",y),
      ]);
      for(const r of [empR,perR,attR,lvR,lbR]) if(r.error) throw r.error;

      const emps=empR.data||[], periods=perR.data||[];
      const id2code={}; emps.forEach(e=>id2code[e.id]=e.emp_code);
      const pmonth={}; periods.forEach(p=>pmonth[p.id]=p.month);
      const pids=periods.map(p=>p.id);
      let prs=[];
      if(pids.length){
        const prR=await supabase.from("payroll_records").select("*").in("period_id",pids).limit(50000);
        if(prR.error) throw prR.error; prs=prR.data||[];
      }
      const lb={}; (lbR.data||[]).forEach(b=>lb[b.employee_id]=b);

      const blankY=()=>({present_days:0,absent_days:0,personal_days:0,sick_days:0,late_min:0,ot_hours:0,pending_review:0,
        pay_work_days:0,total_income:0,total_deduct:0,net_pay:0,ot_amount:0,diligence:0,other_income:0,periods_paid:0});
      const blankM=()=>({present_days:0,absent_days:0,personal_days:0,sick_days:0,late_min:0,ot_hours:0,
        total_income:0,total_deduct:0,net_pay:0,pay_work_days:0});
      const aggY={}, aggM={}, monthsSet=new Set();
      emps.forEach(e=>{ aggY[e.emp_code]=blankY(); });
      const ensureM=(code,m)=>{ const k=code+"_"+m; if(!aggM[k]) aggM[k]=blankM(); return aggM[k]; };

      (attR.data||[]).forEach(a=>{
        const code=id2code[a.employee_id]; if(!code) return; const y0=aggY[code];
        const m=Number(String(a.work_date).slice(5,7)); const mm=ensureM(code,m);
        const present=a.scan_am_in?1:0;
        const abs=a.hr_note==="ขาดงาน"?1:(a.hr_note==="ขาดงานครึ่งวัน"?0.5:0);
        y0.present_days+=present; mm.present_days+=present;
        y0.absent_days+=abs;      mm.absent_days+=abs;
        y0.late_min+=(a.late_minutes||0); mm.late_min+=(a.late_minutes||0);
        y0.ot_hours+=Number(a.ot_hours||0); mm.ot_hours+=Number(a.ot_hours||0);
        if(a.needs_hr_review) y0.pending_review++;
        monthsSet.add(m);
      });
      (lvR.data||[]).forEach(l=>{
        const code=id2code[l.employee_id]; if(!code) return; const y0=aggY[code];
        const m=Number(String(l.leave_date).slice(5,7)); const mm=ensureM(code,m);
        const d=(l.unit==="day")?1:Number(l.hours||0)/8;
        if(l.leave_type==="personal"){ y0.personal_days+=d; mm.personal_days+=d; }
        else if(l.leave_type==="sick"){ y0.sick_days+=d; mm.sick_days+=d; }
        monthsSet.add(m);
      });
      prs.forEach(r=>{
        const code=id2code[r.employee_id]; if(!code) return; const y0=aggY[code];
        const m=pmonth[r.period_id]; const mm=ensureM(code,m);
        y0.pay_work_days+=Number(r.work_days||0); mm.pay_work_days+=Number(r.work_days||0);
        y0.total_income+=Number(r.total_income||0); mm.total_income+=Number(r.total_income||0);
        y0.total_deduct+=Number(r.total_deduct||0); mm.total_deduct+=Number(r.total_deduct||0);
        y0.net_pay+=Number(r.net_pay||0); mm.net_pay+=Number(r.net_pay||0);
        y0.ot_amount+=Number(r.ot_amount||0);
        y0.diligence+=Number(r.diligence_bonus||0);
        y0.other_income+=Number(r.other_income||0);
        y0.periods_paid++;
        if(m) monthsSet.add(m);
      });

      const rowsY=emps.map(e=>{
        const a=aggY[e.emp_code], b=lb[e.id]||{};
        const isTrial=(e.emp_type==="trial" && !e.permanent_start_date);
        let days_left=null, due=null;
        if(isTrial && e.trial_start_date){
          const t=pd(e.trial_start_date);
          days_left=PROBATION_DAYS - dayDiff(REF,t);
          const dueD=new Date(t); dueD.setDate(dueD.getDate()+PROBATION_DAYS); due=beShort(dueD);
        }
        return { emp_code:e.emp_code, nickname:e.nickname, full_name:e.full_name||"",
          emp_type:e.emp_type, is_active:e.is_active, perm:e.permanent_start_date,
          is_trial:isTrial, days_left, due,
          sick_quota:b.sick_quota, sick_used:b.sick_used, personal_quota:b.personal_quota, personal_used:b.personal_used,
          ...a };
      });
      setDb({ rowsY, monthMap:aggM, months:[...monthsSet].sort((x,y)=>x-y) });
    }catch(e){ setErr(e.message||String(e)); }
    finally{ setLoading(false); }
  }

  const filt=(rows,st,query)=>{
    let out=rows.filter(r=> st==="trial"?r.is_trial : st==="all"?true : r.is_active);
    const s=query.trim().toLowerCase();
    if(s) out=out.filter(r=>(r.nickname+" "+r.emp_code+" "+r.full_name).toLowerCase().includes(s));
    return out;
  };
  const getM=(code,m)=>db.monthMap[code+"_"+m];

  /* ══════════ โหมดรายปี ══════════ */
  const yearHtml=useMemo(()=>{
    if(loading||err) return "";
    let rows=filt(db.rowsY,statusF,q);
    rows=[...rows].sort((a,b)=>{ const x=a[sortKey],y=b[sortKey];
      return typeof x==="string"?String(x).localeCompare(String(y),"th")*sortDir:(Number(x)-Number(y))*sortDir; });
    const sum=k=>rows.reduce((s,r)=>s+Number(r[k]||0),0);
    const trialN=rows.filter(r=>r.is_trial).length;
    const urgentN=rows.filter(r=>r.is_trial && r.days_left!=null && r.days_left<=URGENT_DAYS).length;
    const cardArr=[["พนักงาน",rows.filter(r=>r.is_active).length+' <small>คน</small>'],
      ["ทดลองงาน",'<span style="color:'+(trialN?'#b45309':'#1e3a5f')+'">'+trialN+'</span> <small>คน'+(urgentN?' · ใกล้ครบ '+urgentN:'')+'</small>'],
      ["รวมวันขาด",num(sum("absent_days"))+' <small>วัน</small>'],
      ["รวมลากิจ",num(sum("personal_days"))+' <small>วัน</small>'],
      ["รวมลาป่วย",num(sum("sick_days"))+' <small>วัน</small>'],
      ["รวมจ่ายสุทธิ",baht(sum("net_pay"))+' <small>บาท</small>'],
      ["ค้างตรวจเวลา",sum("pending_review")+' <small>รายการ</small>']];
    const cards='<div class="cards">'+cardArr.map(c=>'<div class="card"><div class="k">'+c[0]+'</div><div class="v">'+c[1]+'</div></div>').join("")+'</div>';

    const trials=db.rowsY.filter(r=>r.is_trial).sort((a,b)=>(a.days_left??9999)-(b.days_left??9999));
    const banner=trials.length?'<div class="tbanner"><b>⏳ พนักงานทดลองงาน '+trials.length+' คน</b> — นับถอยหลังถึงครบ '+PROBATION_DAYS+' วัน (ต้องตัดสินใจบรรจุ/ไม่บรรจุ):<div>'
      +trials.map(r=>'<span class="item">'+r.nickname+' <span class="d">'+(r.days_left==null?'—':(r.days_left<0?'เกินกำหนด':'เหลือ '+r.days_left+' วัน'))+'</span>'+(r.due?' · ครบ '+r.due:'')+'</span>').join("")+'</div></div>':"";

    const fmtType=r=>{ if(!r.is_active) return '<span class="chip c-off">ลาออก</span>';
      if(r.is_trial){ const u=r.days_left!=null&&r.days_left<=URGENT_DAYS;
        return '<span class="chip c-trial">ทดลองงาน</span>'+(r.days_left!=null?'<span class="tbadge'+(u?' urgent':'')+'">'+(r.days_left<0?'เกินกำหนด':'เหลือ '+r.days_left+' วัน')+'</span>':''); }
      return '<span class="chip '+(r.emp_type==="trial"?'c-trial':'c-perm')+'">'+(r.emp_type==="trial"?'ทดลองงาน':'ประจำ')+'</span>'; };
    const arrow=k=>sortKey===k?' <span class="arr">'+(sortDir>0?'▲':'▼')+'</span>':'';
    const H=[["emp_code","รหัส","l"],["nickname","ชื่อเล่น","l"],["emp_type","ประเภท","l"],
      ["pay_work_days","วันทำงาน"],["absent_days","ขาด"],["personal_days","ลากิจ"],["sick_days","ลาป่วย"],
      ["late_min","สาย(น.)"],["ot_hours","OT(ชม.)"],["total_income","รายได้รวม"],["total_deduct","หัก"],["net_pay","จ่ายสุทธิ"]];
    const thead='<tr>'+H.map(h=>'<th class="'+(h[2]==="l"?"l ":"")+'sortable" data-k="'+h[0]+'">'+h[1]+arrow(h[0])+'</th>').join("")+'</tr>';

    const body=rows.map(r=>{
      const det=open[r.emp_code];
      const mism=(Number(r.personal_days)!==Number(r.personal_used||0))||(Number(r.sick_days)!==Number(r.sick_used||0));
      const li=(a,b)=>'<div class="dline"><span>'+a+'</span><b>'+b+'</b></div>';
      const detail=det?'<tr class="detail"><td colspan="12"><div class="detailBox"><div class="dgrid">'
        +'<div class="dcol"><h4>💰 รายได้</h4>'+li("OT (บาท)",baht(r.ot_amount)+" ฿")+li("โบนัสขยัน",baht(r.diligence)+" ฿")+li("รายได้อื่น",baht(r.other_income)+" ฿")+li("รวมรายได้",baht(r.total_income)+" ฿")+'</div>'
        +'<div class="dcol"><h4>➖ หัก</h4>'+li("รวมหัก",baht(r.total_deduct)+" ฿")+li("จ่ายสุทธิ",baht(r.net_pay)+" ฿")+li("งวดที่จ่ายในปี",r.periods_paid+" งวด")+'</div>'
        +'<div class="dcol"><h4>🏖️ วันลา (2 แหล่ง)</h4>'+li("ลากิจ หน้าลา",num(r.personal_days)+" / "+num(r.personal_quota||0))+li("ลากิจ โควตา",num(r.personal_used||0)+" / "+num(r.personal_quota||0))+li("ลาป่วย หน้าลา",num(r.sick_days)+" / "+num(r.sick_quota||0))+li("ลาป่วย โควตา",num(r.sick_used||0)+" / "+num(r.sick_quota||0))+'</div>'
        +'<div class="dcol"><h4>⏱️ เวลา</h4>'+li("วันจ่ายค่าแรง",num(r.pay_work_days)+" วัน")+li("มาสแกนจริง",num(r.present_days)+" วัน")+li("ขาดงาน",num(r.absent_days)+" วัน")+li("มาสาย",r.late_min+" นาที")+li("OT",num(r.ot_hours)+" ชม.")+'</div>'
        +'</div>'+(mism?'<div class="note">⚠️ ยอดวันลา 2 แหล่งไม่ตรงกัน — อาจมีการคีย์ตกหล่น</div>':'')
        +(r.pending_review>0?'<div class="note">🟡 มีรายการเวลาค้างตรวจ '+r.pending_review+' รายการ</div>':'')+'</div></td></tr>':"";
      const tcls=r.is_trial?"main trial":(r.is_active?"main":"main row-off");
      return '<tr class="'+tcls+'" data-code="'+r.emp_code+'">'
        +'<td class="l" style="color:#94a3b8">'+r.emp_code+'</td><td class="l"><b>'+r.nickname+'</b></td><td class="l">'+fmtType(r)+'</td>'
        +'<td>'+num(r.pay_work_days)+'</td><td class="'+(Number(r.absent_days)>0?'warn':'')+'">'+num(r.absent_days)+'</td>'
        +'<td>'+num(r.personal_days)+'</td><td>'+num(r.sick_days)+'</td><td class="'+(r.late_min>0?'warn':'')+'">'+r.late_min+'</td><td>'+num(r.ot_hours)+'</td>'
        +'<td class="money">'+baht(r.total_income)+'</td><td class="money" style="color:#94a3b8">'+baht(r.total_deduct)+'</td><td class="money"><b>'+baht(r.net_pay)+'</b></td></tr>'+detail;
    }).join("");

    return cards+banner+'<div class="panel"><h2>รายบุคคล — คลิกแถวเพื่อดูรายละเอียด</h2><div class="tblwrap"><table>'
      +'<thead>'+thead+'</thead><tbody>'+body+'</tbody></table></div></div>';
  },[loading,err,db,statusF,q,sortKey,sortDir,open]);

  /* ══════════ โหมดเลือกเอง / รายเดือน ══════════ */
  const customHtml=useMemo(()=>{
    if(loading||err) return "";
    const mets=METRICS.filter(m=>sel.has(m.key));
    const rows=filt(db.rowsY,cStatusF,cq).sort((a,b)=>a.emp_code.localeCompare(b.emp_code));
    const MONTHS=db.months, Y=year;
    if(mets.length===0) return '<div style="padding:24px;color:#94a3b8">เลือกข้อมูลอย่างน้อย 1 อย่างด้านบน</div>';
    if(rows.length===0) return '<div style="padding:24px;color:#94a3b8">ไม่มีพนักงานตามเงื่อนไข</div>';
    const cBadge=r=> r.is_trial&&r.days_left!=null?'<span class="tbadge'+(r.days_left<=URGENT_DAYS?' urgent':'')+'">ทดลอง · เหลือ '+r.days_left+' วัน</span>':'';

    if(cView==="year"){
      const thead='<tr><th class="l">รหัส</th><th class="l">ชื่อเล่น</th>'+mets.map(m=>'<th class="bl">'+m.label+'</th>').join("")+'</tr>';
      const tot={}; mets.forEach(m=>tot[m.key]=0);
      const body=rows.map(r=>{
        const cells=mets.map(m=>{ let v=0; MONTHS.forEach(mm=> v+=getVal(getM(r.emp_code,mm),m.key)); tot[m.key]+=v;
          return '<td class="bl '+(m.unit==="money"?"money":"")+'">'+fmtVal(v,m.unit)+'</td>'; }).join("");
        return '<tr class="'+(r.is_trial?"trial":(r.is_active?"":"row-off"))+'"><td class="l" style="color:#94a3b8">'+r.emp_code+'</td><td class="l"><b>'+r.nickname+'</b>'+cBadge(r)+'</td>'+cells+'</tr>';
      }).join("");
      const foot='<tr class="tfoot"><td class="l" colspan="2">รวมทั้งหมด</td>'+mets.map(m=>'<td class="bl '+(m.unit==="money"?"money":"")+'">'+fmtVal(tot[m.key],m.unit)+'</td>').join("")+'</tr>';
      return '<table>'+'<thead>'+thead+'</thead><tbody>'+body+foot+'</tbody></table>';
    }
    // แยกรายเดือน
    const r1='<tr><th class="l" rowspan="2">รหัส</th><th class="l" rowspan="2">ชื่อเล่น</th>'
      +mets.map(m=>'<th class="grpc" colspan="'+(MONTHS.length+1)+'">'+m.label+'</th>').join("")+'</tr>';
    const r2='<tr>'+mets.map(m=>MONTHS.map((mm,i)=>'<th class="sub'+(i===0?' bl':'')+'">'+TH_MONTH[mm]+' '+String(Y+543).slice(-2)+'</th>').join("")+'<th class="sub" style="color:#1e3a5f">รวม</th>').join("")+'</tr>';
    const tot={}; mets.forEach(m=>{ tot[m.key]={}; MONTHS.forEach(mm=>tot[m.key][mm]=0); tot[m.key].sum=0; });
    const body=rows.map(r=>{
      const cells=mets.map((m,mi)=>{ let sum=0,tS=0,pS=0;
        const mc=MONTHS.map((mm,i)=>{ const v=getVal(getM(r.emp_code,mm),m.key); sum+=v; tot[m.key][mm]+=v;
          const st=monthStatus(r.perm,r.is_trial,Y,mm);
          const scls=st==="trial"?" trialm":(st==="mixed"?" mixedm":"");
          const tag=(mi===0 && st!=="perm")?'<div class="mtag">'+(st==="mixed"?"ทดลอง→ประจำ":"ทดลอง")+'</div>':"";
          let inner=fmtVal(v,m.unit);
          if(st==="mixed"){ const sp=splitMixed(r.perm,Y,mm,v); tS+=sp.t; pS+=sp.p;
            inner='<span class="sp-t">'+fmtVal(sp.t,m.unit)+'</span><span class="sp-plus">/</span><span class="sp-p">'+fmtVal(sp.p,m.unit)+'</span>'; }
          else if(st==="trial"){ tS+=v; } else { pS+=v; }
          return '<td class="'+(i===0?"bl ":"")+(m.unit==="money"?"money":"")+(v===0?" muted":"")+scls+'">'+inner+tag+'</td>'; }).join("");
        tot[m.key].sum+=sum;
        const split=(tS>0&&pS>0)?'<span class="sp-t">'+fmtVal(tS,m.unit)+'</span><span class="sp-plus">+</span><span class="sp-p">'+fmtVal(pS,m.unit)+'</span>':fmtVal(sum,m.unit);
        return mc+'<td class="'+(m.unit==="money"?"money ":"")+'" style="font-weight:700">'+split+'</td>'; }).join("");
      return '<tr class="'+(r.is_trial?"trial":(r.is_active?"":"row-off"))+'"><td class="l" style="color:#94a3b8">'+r.emp_code+'</td><td class="l"><b>'+r.nickname+'</b>'+cBadge(r)+'</td>'+cells+'</tr>';
    }).join("");
    const foot='<tr class="tfoot"><td class="l" colspan="2">รวมทั้งหมด</td>'+mets.map(m=>MONTHS.map((mm,i)=>'<td class="'+(i===0?"bl ":"")+(m.unit==="money"?"money":"")+'">'+fmtVal(tot[m.key][mm],m.unit)+'</td>').join("")+'<td class="'+(m.unit==="money"?"money":"")+'">'+fmtVal(tot[m.key].sum,m.unit)+'</td>').join("")+'</tr>';
    return '<table><thead>'+r1+r2+'</thead><tbody>'+body+foot+'</tbody></table>';
  },[loading,err,db,sel,cView,cStatusF,cq,year]);

  // คลิกในตารางรายปี: หัวคอลัมน์=เรียง, แถว=กาง/พับ
  const onYearClick=e=>{
    const th=e.target.closest("th[data-k]");
    if(th){ const k=th.dataset.k; if(sortKey===k) setSortDir(d=>-d); else { setSortKey(k); setSortDir(1); } return; }
    const tr=e.target.closest("tr.main");
    if(tr){ const c=tr.dataset.code; setOpen(o=>({...o,[c]:!o[c]})); }
  };
  const toggleMetric=k=>setSel(s=>{ const n=new Set(s); n.has(k)?n.delete(k):n.add(k); return n; });
  const years=[]; for(let yy=now.getFullYear(); yy>=2026; yy--) years.push(yy);

  return (
    <div className="asum">
      <style>{CSS}</style>
      <div className="tabs">
        <button className={tab==="year"?"tab on":"tab"} onClick={()=>setTab("year")}>📅 สรุปรายปี</button>
        <button className={tab==="custom"?"tab on":"tab"} onClick={()=>setTab("custom")}>🧩 เลือกเอง / รายเดือน</button>
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          <label style={{fontSize:13,fontWeight:600,color:"#334155"}}>ปี</label>
          <select value={year} onChange={e=>setYear(Number(e.target.value))}>
            {years.map(yy=><option key={yy} value={yy}>{yy+543} ({yy})</option>)}
          </select>
          <button className="btn" onClick={()=>window.print()}>🖨️ พิมพ์/PDF</button>
        </div>
      </div>

      {loading && <div className="pad">กำลังโหลดข้อมูล…</div>}
      {err && <div className="pad err">❌ โหลดข้อมูลไม่สำเร็จ: {err}</div>}

      {!loading && !err && tab==="year" && (
        <div>
          <div className="toolbar">
            <label>แสดง</label>
            <select value={statusF} onChange={e=>setStatusF(e.target.value)}>
              <option value="active">เฉพาะที่ยังทำงาน</option>
              <option value="trial">เฉพาะทดลองงาน</option>
              <option value="all">ทั้งหมด (รวมลาออก)</option>
            </select>
            <input type="search" value={q} onChange={e=>setQ(e.target.value)} placeholder="🔍 ค้นหาชื่อ / รหัส" />
          </div>
          <div onClick={onYearClick} dangerouslySetInnerHTML={{__html:yearHtml}} />
        </div>
      )}

      {!loading && !err && tab==="custom" && (
        <div className="panel">
          <div className="builder">
            <div className="grp">
              <div className="lbl">1) เลือกข้อมูลที่อยากดู</div>
              <div className="chks">
                {METRICS.map(m=>(
                  <label key={m.key} className={sel.has(m.key)?"chk on":"chk"} onClick={()=>toggleMetric(m.key)}>{m.label}</label>
                ))}
              </div>
            </div>
            <div className="grp">
              <div className="lbl">2) มุมมองเวลา</div>
              <div className="seg">
                <button className={cView==="year"?"on":""} onClick={()=>setCView("year")}>รวมทั้งปี</button>
                <button className={cView==="month"?"on":""} onClick={()=>setCView("month")}>แยกรายเดือน</button>
              </div>
            </div>
            <div className="grp">
              <div className="lbl">3) พนักงาน</div>
              <div className="chks" style={{alignItems:"center"}}>
                <select value={cStatusF} onChange={e=>setCStatusF(e.target.value)}>
                  <option value="active">เฉพาะที่ยังทำงาน</option>
                  <option value="trial">เฉพาะทดลองงาน</option>
                  <option value="all">ทั้งหมด (รวมลาออก)</option>
                </select>
                <input type="search" value={cq} onChange={e=>setCq(e.target.value)} placeholder="🔍 ค้นหาชื่อ / รหัส" />
              </div>
            </div>
          </div>
          <div className="clegend">
            <span className="sw"></span> เดือนพื้นส้ม + คำว่า "ทดลอง" = เดือนที่ยังทดลองงาน · ช่อง "รวม" ถ้าปีนั้นคร่อมสองสถานะจะแยกเป็น{" "}
            <span className="sp-t">ทดลอง</span><span className="sp-plus">+</span><span className="sp-p">ประจำ</span>
          </div>
          <div className="tblwrap" dangerouslySetInnerHTML={{__html:customHtml}} />
        </div>
      )}
    </div>
  );
}

const CSS = `
.asum{ font-family:-apple-system,"Segoe UI","Noto Sans Thai",Tahoma,sans-serif; color:#1e293b; }
.asum .pad{ padding:24px; color:#64748b; } .asum .err{ color:#b91c1c; }
.asum .tabs{ display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
.asum .tab{ padding:9px 18px; border-radius:10px; border:1.5px solid #e2e8f0; background:#fff; cursor:pointer; font-weight:700; font-size:14px; color:#64748b; }
.asum .tab.on{ background:#2563eb; color:#fff; border-color:#2563eb; }
.asum .toolbar{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:14px; }
.asum .toolbar label{ font-size:13px; font-weight:600; color:#334155; }
.asum select,.asum input[type=search]{ padding:8px 12px; border:1.5px solid #cbd5e1; border-radius:8px; font-size:14px; font-weight:600; color:#1e3a5f; background:#fff; }
.asum input[type=search]{ font-weight:400; min-width:200px; }
.asum .btn{ padding:8px 14px; border-radius:8px; border:1.5px solid #cbd5e1; background:#fff; cursor:pointer; font-weight:600; font-size:13px; color:#334155; }
.asum .cards{ display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px; }
.asum .card{ background:#fff; border-radius:12px; padding:14px 16px; box-shadow:0 1px 4px rgba(0,0,0,.06); }
.asum .card .k{ font-size:12px; color:#64748b; font-weight:600; } .asum .card .v{ font-size:22px; font-weight:800; color:#1e3a5f; margin-top:2px; }
.asum .card .v small{ font-size:13px; font-weight:600; color:#94a3b8; }
.asum .panel{ background:#fff; border-radius:14px; box-shadow:0 1px 4px rgba(0,0,0,.06); overflow:hidden; margin-bottom:16px; }
.asum .panel h2{ font-size:15px; padding:14px 16px; border-bottom:1px solid #eef2f7; margin:0; }
.asum .builder{ padding:14px 16px; border-bottom:1px solid #eef2f7; background:#f8fafc; }
.asum .builder .grp{ margin-bottom:12px; } .asum .builder .grp:last-child{ margin-bottom:0; }
.asum .builder .lbl{ font-size:12px; font-weight:700; color:#334155; margin-bottom:6px; }
.asum .chks{ display:flex; gap:8px; flex-wrap:wrap; }
.asum .chk{ padding:6px 12px; border:1.5px solid #e2e8f0; border-radius:20px; background:#fff; cursor:pointer; font-size:13px; font-weight:600; color:#475569; user-select:none; }
.asum .chk.on{ background:#dbeafe; border-color:#93c5fd; color:#1e40af; }
.asum .seg{ display:inline-flex; border:1.5px solid #cbd5e1; border-radius:8px; overflow:hidden; }
.asum .seg button{ padding:7px 14px; border:none; background:#fff; cursor:pointer; font-weight:600; font-size:13px; color:#475569; }
.asum .seg button.on{ background:#2563eb; color:#fff; }
.asum .tblwrap{ overflow-x:auto; }
.asum table{ width:100%; border-collapse:collapse; font-size:13px; white-space:nowrap; }
.asum th{ background:#f8fafc; text-align:right; padding:9px 10px; border-bottom:2px solid #e2e8f0; font-weight:700; color:#334155; }
.asum th.l,.asum td.l{ text-align:left; } .asum th.sortable{ cursor:pointer; } .asum th.sortable:hover{ background:#eef2f7; }
.asum th .arr{ color:#2563eb; font-size:11px; }
.asum th.grpc{ text-align:center; border-left:2px solid #e2e8f0; border-bottom:1px solid #e2e8f0; color:#1e3a5f; }
.asum th.sub{ font-size:12px; color:#64748b; font-weight:600; } .asum th.bl,.asum td.bl{ border-left:2px solid #eef2f7; }
.asum td{ padding:8px 10px; border-bottom:1px solid #f1f5f9; text-align:right; }
.asum tbody tr.main{ cursor:pointer; } .asum tbody tr.main:hover{ background:#f8fafc; }
.asum .tfoot td{ font-weight:800; color:#1e3a5f; background:#f8fafc; border-top:2px solid #e2e8f0; border-bottom:none; }
.asum .chip{ display:inline-block; font-size:11px; font-weight:700; padding:1px 8px; border-radius:20px; }
.asum .c-perm{ background:#eff6ff; color:#1d4ed8; } .asum .c-trial{ background:#fef3c7; color:#92400e; }
.asum .c-off{ background:#fee2e2; color:#b91c1c; } .asum .c-mixed{ background:linear-gradient(90deg,#fef3c7 50%,#eff6ff 50%); color:#7c5e10; }
.asum .warn{ color:#dc2626; font-weight:700; } .asum .muted{ color:#cbd5e1; } .asum .money{ font-variant-numeric:tabular-nums; }
.asum .row-off{ opacity:.55; }
.asum tr.trial td{ background:#fffdf5; } .asum tr.trial:hover td{ background:#fef9ec; }
.asum tr.trial td:first-child{ border-left:4px solid #f59e0b; }
.asum .tbadge{ display:inline-block; font-size:11px; font-weight:700; padding:1px 8px; border-radius:20px; background:#fef3c7; color:#92400e; margin-left:5px; }
.asum .tbadge.urgent{ background:#fee2e2; color:#b91c1c; }
.asum .tbanner{ background:#fffbeb; border:1.5px solid #fde68a; border-radius:12px; padding:12px 16px; margin-bottom:14px; font-size:13px; }
.asum .tbanner b{ color:#92400e; } .asum .tbanner .item{ display:inline-block; background:#fff; border:1px solid #fde68a; border-radius:8px; padding:4px 10px; margin:4px 6px 0 0; font-weight:600; }
.asum .tbanner .item .d{ color:#b91c1c; font-weight:800; }
.asum td.trialm{ background:#fff7ed; box-shadow:inset 0 2px 0 #fdba74; } .asum td.mixedm{ background:linear-gradient(180deg,#eff6ff,#fff7ed); box-shadow:inset 0 2px 0 #fdba74; }
.asum .mtag{ font-size:9px; font-weight:800; color:#c2410c; line-height:1; margin-top:2px; }
.asum .sp-t{ color:#c2410c; font-weight:800; } .asum .sp-p{ color:#1d4ed8; font-weight:800; } .asum .sp-plus{ color:#94a3b8; font-weight:600; margin:0 3px; }
.asum .detailBox{ padding:14px 18px; background:#f8fafc; } .asum .dgrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:14px; }
.asum .dcol h4{ font-size:12px; color:#64748b; margin:0 0 6px; } .asum .dline{ display:flex; justify-content:space-between; font-size:13px; padding:3px 0; border-bottom:1px dashed #e2e8f0; }
.asum .note{ background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:6px 10px; font-size:12px; color:#92400e; margin-top:8px; }
.asum .clegend{ padding:8px 16px; font-size:12px; color:#64748b; border-bottom:1px solid #eef2f7; background:#fff; }
.asum .clegend .sw{ display:inline-block; width:11px; height:11px; border-radius:3px; background:#fff7ed; box-shadow:inset 0 2px 0 #fdba74; vertical-align:middle; margin:0 4px 2px 4px; }
@media print{ .asum .tabs,.asum .toolbar,.asum .builder,.asum .btn{ display:none !important; } }
`;
