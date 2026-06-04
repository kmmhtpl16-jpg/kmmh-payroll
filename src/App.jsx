import { useState } from 'react'
import EmployeesPage from './EmployeesPage'
import AttendancePage from './AttendancePage'

const TABS = [
  { key: 'employees',  label: 'ทะเบียนลูกจ้าง', icon: '👥' },
  { key: 'attendance', label: 'บันทึกเวลา',     icon: '🕐' },
]

export default function App() {
  const [tab, setTab] = useState('employees')

  return (
    <div style={{ minHeight: '100vh', background: '#fff' }}>
      {/* Top nav */}
      <div style={{
        borderBottom: '0.5px solid #e5e5e5', background: '#fafafa',
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{
          maxWidth: 1200, margin: '0 auto', padding: '0 1rem',
          display: 'flex', alignItems: 'center', gap: 4, height: 52,
        }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#111', marginRight: 16 }}>
            KMMH Payroll
          </span>
          {TABS.map(t => {
            const on = tab === t.key
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{
                  background: on ? '#111' : 'transparent',
                  color: on ? '#fff' : '#555',
                  border: 'none', borderRadius: 8,
                  padding: '7px 14px', cursor: 'pointer',
                  fontSize: 13, fontWeight: 500,
                  fontFamily: 'sans-serif',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                <span>{t.icon}</span>{t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Page content */}
      {tab === 'employees'  && <EmployeesPage />}
      {tab === 'attendance' && <AttendancePage />}
    </div>
  )
}
