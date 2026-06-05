// src/App.jsx
import { useState } from "react";
import LoginPage from "./LoginPage";
import AttendancePage from "./AttendancePage";
import EmployeesPage from "./EmployeesPage";
import DeductionsPage from "./DeductionsPage";
import PayrollPage from "./PayrollPage";
import WeeklyPage from "./WeeklyPage";
import SettingsPage from "./SettingsPage";

const TABS = [
  { id: "attendance",  label: "⏱ บันทึกเวลา" },
  { id: "employees",   label: "👥 พนักงาน" },
  { id: "deductions",  label: "📋 รายจ่ายพนักงาน" },
  { id: "payroll",     label: "💰 เงินเดือน" },
  { id: "weekly",      label: "💸 รายจ่ายบริษัท" },
  { id: "settings",    label: "⚙️ วันหยุด" },
];

export default function App() {
  const [role, setRole] = useState(null);
  const [activeTab, setActiveTab] = useState("attendance");

  if (!role) return <LoginPage onLogin={(r) => setRole(r)} />;

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <span style={styles.headerTitle}>KMMH Payroll</span>
        <div style={styles.roleTag}>
          {role === "owner" ? "👑 เจ้าของ" : "🧑‍💼 HR"}
        </div>
        <button onClick={() => setRole(null)} style={styles.logoutBtn}>🔒 ออก</button>
      </header>
      <nav style={styles.tabBar}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            style={{ ...styles.tabBtn, ...(activeTab === t.id ? styles.tabBtnActive : {}) }}>
            {t.label}
          </button>
        ))}
      </nav>
      <main style={styles.main}>
        {activeTab === "attendance"  && <AttendancePage role={role} />}
        {activeTab === "employees"   && <EmployeesPage role={role} />}
        {activeTab === "deductions"  && <DeductionsPage role={role} />}
        {activeTab === "payroll"     && <PayrollPage role={role} />}
        {activeTab === "weekly"      && <WeeklyPage role={role} />}
        {activeTab === "settings"    && <SettingsPage role={role} />}
      </main>
    </div>
  );
}

const styles = {
  app: { minHeight:"100vh", display:"flex", flexDirection:"column",
    background:"#f0f4f8", fontFamily:"'Sarabun', sans-serif" },
  header: { background:"#1e3a5f", color:"#fff", padding:"0.75rem 1rem",
    display:"flex", alignItems:"center", gap:"0.75rem" },
  headerTitle: { fontWeight:700, fontSize:18, flex:1 },
  roleTag: { background:"rgba(255,255,255,0.15)", borderRadius:20,
    padding:"2px 10px", fontSize:13 },
  logoutBtn: { background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.3)",
    color:"#fff", borderRadius:8, padding:"4px 10px", cursor:"pointer", fontSize:13 },
  tabBar: { display:"flex", background:"#fff", borderBottom:"2px solid #e2e8f0",
    padding:"0 1rem", overflowX:"auto" },
  tabBtn: { padding:"0.75rem 1rem", border:"none", background:"none",
    color:"#64748b", fontSize:13, fontWeight:600, cursor:"pointer",
    borderBottom:"3px solid transparent", marginBottom:-2,
    transition:"all 0.15s", whiteSpace:"nowrap" },
  tabBtnActive: { color:"#2563eb", borderBottom:"3px solid #2563eb" },
  main: { flex:1, padding:"1rem" },
};
