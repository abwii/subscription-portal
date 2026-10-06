import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  return <button type={type} data-variant={variant} {...props} />;
}
