"use client"

import { MoonIcon, SunIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import { useLocale } from "@/components/locale-provider"

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const { locale } = useLocale()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isDark = mounted && resolvedTheme === "dark"
  const label = !mounted
    ? locale === "zh-CN" ? "切换主题" : "Switch theme"
    : isDark
      ? locale === "zh-CN" ? "切换到浅色模式" : "Switch to light mode"
      : locale === "zh-CN" ? "切换到深色模式" : "Switch to dark mode"

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {mounted && isDark ? <SunIcon /> : <MoonIcon />}
    </Button>
  )
}
