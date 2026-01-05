import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const progressVariants = cva("relative h-2 w-full overflow-hidden rounded-full", {
  variants: {
    variant: {
      default: "bg-secondary",
      accent: "bg-accent/20",
      success: "bg-success/20",
      warning: "bg-warning/20",
      destructive: "bg-destructive/20",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

const indicatorVariants = cva("h-full w-full flex-1 transition-all duration-300 rounded-full", {
  variants: {
    variant: {
      default: "bg-primary",
      accent: "bg-accent",
      success: "bg-success",
      warning: "bg-warning",
      destructive: "bg-destructive",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>,
    VariantProps<typeof progressVariants> {}

const Progress = React.forwardRef<React.ElementRef<typeof ProgressPrimitive.Root>, ProgressProps>(
  ({ className, value, variant, ...props }, ref) => (
    <ProgressPrimitive.Root ref={ref} className={cn(progressVariants({ variant }), className)} {...props}>
      <ProgressPrimitive.Indicator
        className={cn(indicatorVariants({ variant }))}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
)
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
