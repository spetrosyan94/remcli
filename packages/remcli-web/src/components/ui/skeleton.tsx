import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="skeleton"
            className={cn(
                "relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:animate-shimmer before:bg-[linear-gradient(90deg,transparent_0%,hsl(var(--accent)_/_0.14)_45%,transparent_90%)] before:bg-[length:200%_100%] before:content-['']",
                className,
            )}
            {...props}
        />
    );
}

export { Skeleton };
