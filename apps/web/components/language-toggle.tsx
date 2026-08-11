"use client"

import { LanguagesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useLocale } from "@/components/locale-provider"

export function LanguageToggle() {
  const { locale, setLocale } = useLocale()
  const nextLocale = locale === "zh-CN" ? "en" : "zh-CN"
  const label = locale === "zh-CN" ? "Switch to English" : "切换到中文"

  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => setLocale(nextLocale)} aria-label={label} title={label}>
      <LanguagesIcon data-icon="inline-start" />
      {locale === "zh-CN" ? "EN" : "中文"}
    </Button>
  )
}
