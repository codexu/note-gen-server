"use client"

import type { ReactNode } from "react"
import { MenuIcon } from "lucide-react"

import { LanguageToggle } from "@/components/language-toggle"
import {
  NOTEGEN_DOCS_URL,
  NOTEGEN_SITE_URL,
  GitHubMark,
  NoteGenMark,
  NoteGenWordmark,
} from "@/components/notegen-brand"
import { ThemeToggle } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

const productLinks = [
  { label: "工作流", href: `${NOTEGEN_SITE_URL}/cn#workflow` },
  { label: "功能", href: `${NOTEGEN_SITE_URL}/cn#features` },
  { label: "网页剪藏", href: `${NOTEGEN_SITE_URL}/cn/web-clipper/download` },
  { label: "文档", href: NOTEGEN_DOCS_URL },
] as const

const moreLinks = [
  { label: "交流群", description: "加入 NoteGen 用户交流群", href: `${NOTEGEN_SITE_URL}/cn/community` },
  { label: "商务合作", description: "了解与 NoteGen 的合作方式", href: `${NOTEGEN_SITE_URL}/cn/business` },
  { label: "支持项目", description: "支持 NoteGen 开源项目", href: `${NOTEGEN_SITE_URL}/cn/donate` },
] as const

export function SiteHeader({ instanceName, showLanguage = false }: {
  instanceName?: string | null
  showLanguage?: boolean
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-4 sm:px-6">
        <a className="flex shrink-0 items-center gap-2" href="/" aria-label="NoteGen Sync 首页">
          <NoteGenMark className="size-6 rounded-md" />
          <NoteGenWordmark />
          <span className="text-xs text-muted-foreground">SYNC</span>
        </a>

        <nav className="ml-3 hidden items-center gap-1 md:flex" aria-label="NoteGen 产品导航">
          {productLinks.map((link) => (
            <Button key={link.href} variant="ghost" size="sm" nativeButton={false}
              render={<a href={link.href} target="_blank" rel="noreferrer" />}>
              {link.label}
            </Button>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>更多</DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuGroup>
                {moreLinks.map((link) => (
                  <DropdownMenuItem key={link.href} render={<a href={link.href} target="_blank" rel="noreferrer" />}>
                    <span className="grid gap-0.5">
                      <span className="font-medium">{link.label}</span>
                      <span className="text-xs text-muted-foreground">{link.description}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>

        <div className="ml-auto flex items-center gap-1">
          {instanceName ? <Badge variant="outline" className="hidden max-w-48 truncate lg:inline-flex">{instanceName}</Badge> : null}
          <div className="hidden items-center gap-1 sm:flex">
            {showLanguage ? <LanguageToggle /> : null}
            <ThemeToggle />
            <Button className="rounded-full" variant="outline" size="sm" nativeButton={false}
              render={<a href="https://github.com/codexu/note-gen" target="_blank" rel="noreferrer" />}>
              <GitHubMark />GitHub
            </Button>
          </div>
          <Sheet>
            <SheetTrigger render={<Button className="md:hidden" variant="ghost" size="icon" aria-label="打开导航" />}>
              <MenuIcon />
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(22rem,88vw)]">
              <SheetHeader className="border-b">
                <SheetTitle className="flex items-center gap-2"><NoteGenMark className="size-6 rounded-md" /><NoteGenWordmark /> SYNC</SheetTitle>
                <SheetDescription>NoteGen 产品与同步服务导航</SheetDescription>
              </SheetHeader>
              <nav className="flex flex-col gap-1 px-3" aria-label="移动端产品导航">
                {[...productLinks, ...moreLinks].map((link) => (
                  <SheetClose key={link.href} render={<a className="rounded-lg px-3 py-2.5 font-medium hover:bg-accent" href={link.href} target="_blank" rel="noreferrer" />}>
                    {link.label}
                  </SheetClose>
                ))}
              </nav>
              <div className="mt-auto flex items-center gap-1 border-t p-4">
                {showLanguage ? <LanguageToggle /> : null}
                <ThemeToggle />
                <Button className="ml-auto" variant="outline" size="sm" nativeButton={false}
                  render={<a href="https://github.com/codexu/note-gen" target="_blank" rel="noreferrer" />}>
                  <GitHubMark />GitHub
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <a className="flex items-center gap-2 font-medium text-foreground" href={NOTEGEN_SITE_URL} target="_blank" rel="noreferrer">
          <NoteGenMark className="size-7" />
          <NoteGenWordmark />
        </a>
        <p>Capture first, organize later.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <a className="hover:text-foreground" href="https://github.com/codexu/note-gen" target="_blank" rel="noreferrer">GitHub</a>
          <a className="hover:text-foreground" href={NOTEGEN_DOCS_URL} target="_blank" rel="noreferrer">文档</a>
          <a className="hover:text-foreground" href={`${NOTEGEN_SITE_URL}/cn/web-clipper/download`} target="_blank" rel="noreferrer">网页剪藏</a>
          <a className="hover:text-foreground" href={`${NOTEGEN_SITE_URL}/cn/community`} target="_blank" rel="noreferrer">交流群</a>
          <a className="hover:text-foreground" href={`${NOTEGEN_SITE_URL}/cn/business`} target="_blank" rel="noreferrer">商务合作</a>
          <a className="hover:text-foreground" href={`${NOTEGEN_SITE_URL}/cn/donate`} target="_blank" rel="noreferrer">支持项目</a>
        </div>
      </div>
    </footer>
  )
}

export function PublicSiteShell({ children, instanceName, showLanguage = false }: {
  children: ReactNode
  instanceName?: string | null
  showLanguage?: boolean
}) {
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <SiteHeader instanceName={instanceName} showLanguage={showLanguage} />
      <div className="flex flex-1 flex-col">{children}</div>
      <SiteFooter />
    </div>
  )
}
