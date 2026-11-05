import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Medusa's Button: primary is the inverted (zinc) button, outline and secondary are its neutral button, ghost its
// transparent one, destructive its danger one; outlines and focus rings are box-shadows (globals.css).
const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,box-shadow] outline-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:shadow-borders-error [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-buttons-inverted hover:bg-primary-hover focus-visible:shadow-buttons-inverted-focus",
        destructive:
          "bg-destructive-button text-white shadow-buttons-danger hover:bg-destructive-button-hover focus-visible:shadow-buttons-danger-focus",
        outline:
          "bg-button-neutral text-foreground shadow-buttons-neutral hover:bg-button-neutral-hover active:bg-button-neutral-pressed focus-visible:shadow-buttons-neutral-focus",
        secondary:
          "bg-button-neutral text-foreground shadow-buttons-neutral hover:bg-button-neutral-hover active:bg-button-neutral-pressed focus-visible:shadow-buttons-neutral-focus",
        ghost:
          "text-foreground hover:bg-button-transparent-hover active:bg-button-transparent-pressed focus-visible:shadow-buttons-neutral-focus",
        link: "text-interactive underline-offset-4 hover:underline focus-visible:shadow-borders-focus",
      },
      size: {
        default: "h-8 px-3 py-1.5",
        xs: "h-6 gap-1 px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 px-2 py-1",
        lg: "h-10 px-4 py-2.5",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
