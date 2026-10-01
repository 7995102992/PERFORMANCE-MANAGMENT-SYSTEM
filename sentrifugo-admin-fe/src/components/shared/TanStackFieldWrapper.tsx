import * as React from "react"

import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export interface TanStackFieldWrapperProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  field: any
  label: React.ReactNode
  children: React.ReactNode
  className?: string
  labelClassName?: string
}

export function TanStackFieldWrapper({
  field,
  label,
  children,
  className,
  labelClassName,
}: TanStackFieldWrapperProps) {
  // isPristine = field never changed from default. Show errors once the user starts typing.
  const { errors, isPristine, isTouched } = field.state.meta
  const showErrors = (!isPristine || isTouched) && errors && errors.length > 0

  return (
    <div className={cn("space-y-3", className)}>
      <Label htmlFor={field.name} className={labelClassName}>
        {label}
      </Label>
      {children}
      {showErrors && (
        <p className="text-[0.8rem] font-medium text-destructive text-center">
          {errors.join(", ")}
        </p>
      )}
    </div>
  )
}

