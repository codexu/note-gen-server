import { cn } from "@/lib/utils"

export const NOTEGEN_SITE_URL = "https://notegen.top"
export const NOTEGEN_DOCS_URL = "https://notegen.top/cn/docs"
export const NOTEGEN_LOGO_URL = "https://s2.loli.net/2025/08/05/IceAMqnBJytp2wE.png"

export function NoteGenMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg",
        className,
      )}
      aria-hidden="true"
    >
      {/* The public site uses this same canonical product mark. */}
      <img src={NOTEGEN_LOGO_URL} alt="" className="size-full object-cover" />
    </span>
  )
}

export function NoteGenWordmark({ className }: { className?: string }) {
  return <span className={cn("font-semibold tracking-tight", className)}>NOTEGEN.</span>
}

export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={cn("size-4", className)} aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.3-5.27-1.29-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18A10.95 10.95 0 0 1 12 6.11c.98 0 1.95.13 2.86.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.4-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  )
}
