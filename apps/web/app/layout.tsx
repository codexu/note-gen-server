import type { Metadata } from "next"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LocaleProvider } from "@/components/locale-provider"
import { Toaster } from "@/components/ui/toast"

export const metadata: Metadata = {
  title: "NoteGen Sync",
  description: "管理 NoteGen 同步内容、工作区与关联设备",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <LocaleProvider>
            <TooltipProvider>{children}</TooltipProvider>
            <Toaster />
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
