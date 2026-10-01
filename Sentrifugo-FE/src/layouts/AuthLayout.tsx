import type { ReactNode } from 'react'
import logoLight from '@/assets/logo-light.svg'
import logoDark from '@/assets/logo-dark.svg'
import officeLogo from '@/assets/office-logo.png'

interface AuthLayoutProps {
  title: string
  description?: ReactNode
  headerIcon?: ReactNode
  children: ReactNode
  footerSlot?: ReactNode
}

export function AuthLayout({
  title,
  description,
  headerIcon,
  children,
  footerSlot,
}: AuthLayoutProps) {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background">
      <img
        src={officeLogo}
        alt="Sentrifugo Office"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-black/40" />

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-[400px] rounded-2xl border border-white/20 bg-background/65 p-8 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-center">
            <img
              src={logoLight}
              alt="Sentrifugo"
              className="block h-12 w-auto dark:hidden"
            />
            <img
              src={logoDark}
              alt="Sentrifugo"
              className="hidden h-12 w-auto dark:block"
            />
          </div>

          <div className="mt-6 space-y-2 text-center">
            {headerIcon && <div className="mb-1 flex justify-center">{headerIcon}</div>}
            {title && (
              <h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground">
                {title}
              </h1>
            )}
            {description && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>

          <div className="mt-6 space-y-5">{children}</div>
          {footerSlot && <div className="mt-4 flex justify-center">{footerSlot}</div>}
        </div>

        <p className="mt-6 text-xs text-white/80">
          © {new Date().getFullYear()} Sentrifugo
        </p>
      </div>
    </div>
  )
}
