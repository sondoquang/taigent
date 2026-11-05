import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md bg-field px-2 py-1.5 text-sm text-foreground caret-foreground shadow-borders-base transition-[color,background-color,box-shadow] outline-none placeholder:text-muted-foreground hover:bg-field-hover focus-visible:shadow-borders-active disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:shadow-borders-error",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
