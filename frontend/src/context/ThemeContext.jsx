import React, { createContext, useContext, useEffect, useState } from 'react';

const ThemeContext = createContext({ isDark: false, toggle: () => {} });

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem('erp_theme') === 'dark'; } catch { return false; }
  });

  useEffect(() => {
    document.body.classList.toggle('dark', isDark);
    try { localStorage.setItem('erp_theme', isDark ? 'dark' : 'light'); } catch {}
  }, [isDark]);

  const toggle = () => setIsDark(d => !d);
  return <ThemeContext.Provider value={{ isDark, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }
