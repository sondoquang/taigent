import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md bg-field px-2 py-1.5 text-sm text-foreground caret-foreground shadow-borders-base transition-[color,background-color,box-shadow] outline-none selection:bg-interactive selection:text-white file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:bg-field-hover disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:shadow-borders-active",
        "aria-invalid:shadow-borders-error",
        className
      )}
      {...props}
    />
  )
}

export { Input }
