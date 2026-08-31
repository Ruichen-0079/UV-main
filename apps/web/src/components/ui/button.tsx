import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-[12px] text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-[var(--yuvi-accent)] text-white hover:opacity-90",
        secondary:
          "border border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)] text-[var(--yuvi-ink)] hover:bg-[var(--yuvi-accent-soft)]",
        ghost: "text-[var(--yuvi-muted)] hover:bg-[var(--yuvi-accent-soft)] hover:text-[var(--yuvi-ink)]"
      },
      size: {
        sm: "h-8 px-3",
        md: "h-10 px-4",
        lg: "h-12 px-5"
      }
    },
    defaultVariants: { variant: "primary", size: "md" }
  }
);

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }
>(function Button({ className, variant, size, asChild, ...props }, ref) {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
