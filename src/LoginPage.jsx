// src/LoginPage.jsx
// ─────────────────────────────────────────────
// หน้า PIN lock screen สำหรับ KMMH Payroll
// - ดึง PIN จาก Supabase (app_config)
// - unlock ด้วย PIN ถูกต้อง → ส่ง role ('hr' | 'owner') กลับ
// - PIN ผิด 5 ครั้ง → cooldown 30 วินาที
// ─────────────────────────────────────────────

import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

const MAX_ATTEMPTS = 5;
const COOLDOWN_SEC = 30;

export default function LoginPage({ onLogin }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [cooldown, setCooldown] = useState(0); // วินาทีที่เหลือ
  const [configs, setConfigs] = useState(null); // { pin_hr, pin_owner }
  const inputRef = useRef(null);

  // ─── โหลด PIN จาก Supabase ───────────────────────────────
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("app_config")
        .select("key, value")
        .in("key", ["pin_hr", "pin_owner"]);
      if (error || !data) return;
      const cfg = {};
      data.forEach((r) => (cfg[r.key] = r.value));
      setConfigs(cfg);
    })();
  }, []);

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

  // ─── กดปุ่ม numpad ───────────────────────────────────────
  const handleKey = (k) => {
    if (cooldown > 0) return;
    if (k === "del") {
      setPin((p) => p.slice(0, -1));
      setError("");
      return;
    }
    if (pin.length >= 6) return; // PIN สูงสุด 6 หลัก
    const next = pin + k;
    setPin(next);

    // auto-submit เมื่อกรอกครบ (4–6 หลัก) ถ้าตรงกับ PIN ที่โหลดมา
    if (configs) {
      const matched =
        next === configs.pin_owner
          ? "owner"
          : next === configs.pin_hr
          ? "hr"
          : null;
      if (matched) {
        handleSubmit(next, matched);
        return;
      }
      // ถ้าพิมพ์ครบความยาว PIN owner/hr แล้วยังไม่ตรง → ผิด
      const maxLen = Math.max(
        configs.pin_owner?.length || 4,
        configs.pin_hr?.length || 4
      );
      if (next.length >= maxLen) {
        handleWrongPin();
      }
    }
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
      if (e.key >= "0" && e.key <= "9") handleKey(e.key);
      if (e.key === "Backspace") handleKey("del");
      if (e.key === "Enter" && pin.length >= 4) {
        // manual submit สำหรับ PIN 4+ หลักที่กด Enter
        if (!configs) return;
        const role =
          pin === configs.pin_owner
            ? "owner"
            : pin === configs.pin_hr
            ? "hr"
            : null;
        if (role) handleSubmit(pin, role);
        else handleWrongPin();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pin, configs, cooldown, attempts]);

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
        {!configs && !error && (
          <p style={styles.hint}>กำลังโหลด...</p>
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
