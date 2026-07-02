// remcli — адаптивный логотип (design/assets/logo-mono.svg): стрелки currentColor, курсор — токен accent.
// Инлайн-SVG вместо public/logo.svg, чтобы знак был видим в обеих темах.
export function Logo({ className, label }: { className?: string; label?: string }) {
    return (
        <svg
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
        >
            <path d="M5.5 10.8 L10.7 16 L5.5 21.2" stroke="currentColor" strokeOpacity="0.26" strokeWidth="3.2" />
            <path d="M12.2 9.3 L18.9 16 L12.2 22.7" stroke="currentColor" strokeWidth="3.2" />
            <rect x="21.6" y="19.5" width="6" height="3.2" className="fill-accent" />
        </svg>
    );
}
