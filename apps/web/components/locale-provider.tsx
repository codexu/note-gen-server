"use client"

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

export type Locale = "zh-CN" | "en"

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("zh-CN")

  useEffect(() => {
    const stored = window.localStorage.getItem("notegen-locale")
    const nextLocale = stored === "en" || stored === "zh-CN"
      ? stored
      : window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en"
    setLocaleState(nextLocale)
    document.documentElement.lang = nextLocale
  }, [])

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale(nextLocale) {
      setLocaleState(nextLocale)
      window.localStorage.setItem("notegen-locale", nextLocale)
      document.documentElement.lang = nextLocale
    },
  }), [locale])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext)
  if (context === null) throw new Error("useLocale must be used within LocaleProvider")
  return context
}
