import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

// Medusa's Badge: a 20px tag, 12px medium text, a 6px radius and a 1px border in the tag colour.
const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-0.5 overflow-hidden rounded-md border px-1.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:shadow-borders-focus [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-neutral-border bg-neutral-bg text-neutral",
        secondary: "border-neutral-border bg-neutral-bg text-neutral",
        destructive: "border-danger-border bg-danger-bg text-danger",
        outline: "border-border text-foreground [a&]:hover:bg-accent",
        ghost: "border-transparent [a&]:hover:bg-accent",
        link: "border-transparent text-interactive underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
