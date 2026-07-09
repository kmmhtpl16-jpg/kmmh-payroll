// src/LoginPage.jsx
// ─────────────────────────────────────────────
// หน้า PIN lock screen สำหรับ KMMH Payroll
// - ตรวจ PIN ผ่าน RPC verify_login_pin (ฝั่ง server) — ไม่อ่าน PIN จาก app_config ตรงๆ อีกแล้ว
//   เพื่อให้ปิด RLS ตาราง app_config กัน anon ดึง PIN/โทเคนได้
// - unlock ด้วย PIN ถูกต้อง → ส่ง role ('hr' | 'owner') กลับ
// - PIN ผิด 5 ครั้ง → cooldown 30 วินาที
// ─────────────────────────────────────────────

import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import { ensureSession } from "./supabase";

const MAX_ATTEMPTS = 5;
const COOLDOWN_SEC = 30;
const MIN_PIN_LEN = 4;
const MAX_PIN_LEN = 6;

export default function LoginPage({ onLogin }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [cooldown, setCooldown] = useState(0); // วินาทีที่เหลือ
  const checkingRef = useRef(false);

  // ─── Cooldown timer ──────────────────────────────────────
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearInterval(t);
          setAttempts(0);
          setError("");
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  // ─── ตรวจ PIN ผ่าน server (RPC) ─────────────────────────
  // markWrongIfNoMatch = true → ถ้าไม่ตรงให้นับเป็นผิดทันที (ใช้ตอนกด Enter)
  const checkPin = async (candidate, markWrongIfNoMatch) => {
    if (checkingRef.current || loading) return;
    if (candidate.length < MIN_PIN_LEN) return;
    checkingRef.current = true;
    try {
      const { data, error: rpcErr } = await supabase.rpc("verify_login_pin", {
        p_pin: candidate,
      });
      if (rpcErr) {
        setError("เชื่อมต่อไม่ได้ ลองใหม่");
        return;
      }
      if (data === "owner" || data === "hr") {
        // แลก PIN เป็น session จริงก่อน ไม่งั้น RLS จะปฏิเสธทุก query (anon)
        setLoading(true);
        const ok = await ensureSession(candidate);
        setLoading(false);
        if (!ok) {
          setPin("");
          setError("เข้าสู่ระบบไม่สำเร็จ ลองใหม่");
          return;
        }
        handleSubmit(candidate, data);
      } else if (markWrongIfNoMatch || candidate.length >= MAX_PIN_LEN) {
        handleWrongPin();
      }
    } finally {
      checkingRef.current = false;
    }
  };

  // ─── กดปุ่ม numpad ───────────────────────────────────────
  const handleKey = (k) => {
    if (cooldown > 0 || loading) return;
    if (k === "del") {
      setPin((p) => p.slice(0, -1));
      setError("");
      return;
    }
    if (pin.length >= MAX_PIN_LEN) return;
    const next = pin + k;
    setPin(next);
    if (next.length >= MIN_PIN_LEN) checkPin(next, false); // auto-check
  };

  const handleSubmit = (pinVal, role) => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setPin("");
      onLogin(role); // ส่ง role กลับ App.jsx
    }, 300);
  };

  const handleWrongPin = () => {
    const nextAttempts = attempts + 1;
    setAttempts(nextAttempts);
    setPin("");
    if (nextAttempts >= MAX_ATTEMPTS) {
      setError(`ผิดหลายครั้ง รอ ${COOLDOWN_SEC} วินาที`);
      setCooldown(COOLDOWN_SEC);
    } else {
      setError(`PIN ไม่ถูกต้อง (${nextAttempts}/${MAX_ATTEMPTS})`);
    }
  };

  // ─── รับ keyboard จริงด้วย ───────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (cooldown > 0 || loading) return;
      if (e.key >= "0" && e.key <= "9") handleKey(e.key);
      if (e.key === "Backspace") handleKey("del");
      if (e.key === "Enter" && pin.length >= MIN_PIN_LEN) checkPin(pin, true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pin, cooldown, attempts, loading]);

  // ─── UI ─────────────────────────────────────────────────
  const dots = Array.from({ length: 6 }, (_, i) => i < pin.length);

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        {/* Logo / ชื่อแอป */}
        <div style={styles.logo}>🏢</div>
        <h2 style={styles.title}>KMMH Payroll</h2>
        <p style={styles.subtitle}>กรุณาใส่รหัสเพื่อเข้าใช้งาน</p>

        {/* Dot display */}
        <div style={styles.dotRow}>
          {dots.map((filled, i) => (
            <div
              key={i}
              style={{
                ...styles.dot,
                background: filled ? "#2563eb" : "#e5e7eb",
                transform: filled ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s",
              }}
            />
          ))}
        </div>

        {/* Error / cooldown */}
        {error && (
          <p style={styles.error}>
            {cooldown > 0 ? `⏳ ${error} (${cooldown}s)` : `⚠️ ${error}`}
          </p>
        )}

        {/* Numpad */}
        <div style={styles.numpad}>
          {["1","2","3","4","5","6","7","8","9","","0","del"].map((k, i) => (
            <button
              key={i}
              onClick={() => k && handleKey(k)}
              disabled={cooldown > 0 || loading}
              style={{
                ...styles.numBtn,
                ...(k === "" ? styles.numBtnEmpty : {}),
                ...(k === "del" ? styles.numBtnDel : {}),
                opacity: cooldown > 0 || loading ? 0.4 : 1,
              }}
            >
              {k === "del" ? "⌫" : k}
            </button>
          ))}
        </div>

        <p style={styles.footer}>บจก.กิจมั่งมีโฮม · HR & เจ้าของเท่านั้น</p>
      </div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────
const styles = {
  overlay: {
    position: "fixed", inset: 0,
    background: "linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 9999,
  },
  card: {
    background: "#fff",
    borderRadius: 20,
    padding: "2rem 2rem 1.5rem",
    width: 320,
    maxWidth: "90vw",
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: "0.75rem",
  },
  logo: { fontSize: 40, lineHeight: 1 },
  title: { margin: 0, fontSize: 22, fontWeight: 700, color: "#1e293b" },
  subtitle: { margin: 0, fontSize: 13, color: "#64748b" },
  dotRow: {
    display: "flex", gap: 12, margin: "0.5rem 0",
  },
  dot: {
    width: 16, height: 16, borderRadius: "50%",
    border: "2px solid #cbd5e1",
  },
  error: {
    margin: 0, fontSize: 13, color: "#dc2626",
    fontWeight: 600, textAlign: "center",
  },
  hint: { margin: 0, fontSize: 12, color: "#94a3b8" },
  numpad: {
    display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
    gap: 10, width: "100%", marginTop: 4,
  },
  numBtn: {
    height: 58, borderRadius: 12,
    border: "1.5px solid #e2e8f0",
    background: "#f8fafc",
    fontSize: 22, fontWeight: 600, color: "#1e293b",
    cursor: "pointer",
    transition: "background 0.1s, transform 0.05s",
  },
  numBtnEmpty: { background: "transparent", border: "none", cursor: "default" },
  numBtnDel: { background: "#fef2f2", color: "#ef4444" },
  footer: { margin: 0, fontSize: 11, color: "#94a3b8", marginTop: 4 },
};
