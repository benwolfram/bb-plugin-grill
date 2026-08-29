/* Native radio/checkbox inputs styled like the vendored controls.
 *
 * A choice row is a real <label> wrapping a real input, so clicking anywhere
 * on the row toggles it and screen readers get the accessible name for free.
 * The vendored Checkbox is a Radix button, which a wrapping label cannot
 * name — hence these.
 */
import * as React from "react";

import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";
import { Icon } from "./icon.js";

/** A radio (single-select) or checkbox (multi-select) mark. */
const ChoiceControl = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<"input"> & { multiple?: boolean }
>(({ className, multiple = false, ...props }, ref) => (
  <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
    <input
      ref={ref}
      type={multiple ? "checkbox" : "radio"}
      className={cn(
        `peer size-4 shrink-0 cursor-pointer appearance-none border border-input bg-transparent shadow-xs ${CONTROL_HOVER_TRANSITION} checked:border-foreground checked:bg-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50`,
        multiple ? "rounded-sm" : "rounded-full",
        className,
      )}
      {...props}
    />
    {multiple ? (
      <Icon
        name="Check"
        aria-hidden
        className="pointer-events-none absolute size-3 text-background opacity-0 peer-checked:opacity-100"
      />
    ) : (
      <span
        aria-hidden
        className="pointer-events-none absolute size-1.5 rounded-full bg-background opacity-0 peer-checked:opacity-100"
      />
    )}
  </span>
));
ChoiceControl.displayName = "ChoiceControl";

/** The clickable row a choice lives in. */
function ChoiceRow({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        `flex cursor-pointer items-start gap-2.5 rounded-md border border-transparent px-2 py-1.5 ${CONTROL_HOVER_TRANSITION} hover:bg-state-hover has-[:checked]:border-border has-[:checked]:bg-muted`,
        className,
      )}
      {...props}
    />
  );
}

export { ChoiceControl, ChoiceRow };
