import * as React from "react"
import { cn } from "@/lib/utils"
import { ChevronDownIcon } from "lucide-react"

function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div
      className="group/native-select relative w-fit has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "h-8 w-full min-w-0 appearance-none rounded-md bg-field px-2 py-1.5 pr-8 text-sm text-foreground shadow-borders-base transition-[color,background-color,box-shadow] outline-none selection:bg-interactive selection:text-white placeholder:text-muted-foreground hover:bg-field-hover disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-7 data-[size=sm]:py-1",
          "focus-visible:shadow-borders-active",
          "aria-invalid:shadow-borders-error",
          className
        )}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  )
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
