import { useEffect, useRef, useState } from 'react';

interface AnimatedNumberProps {
    value: number;
    prefix?: string;
    suffix?: string;
    decimals?: number;
    duration?: number; // ms
    className?: string;
    compact?: boolean; // for large numbers like $100K
}

function formatCompact(value: number, decimals: number): string {
    if (Math.abs(value) >= 1e12) return (value / 1e12).toFixed(decimals) + 'T';
    if (Math.abs(value) >= 1e9) return (value / 1e9).toFixed(decimals) + 'B';
    if (Math.abs(value) >= 1e6) return (value / 1e6).toFixed(decimals) + 'M';
    if (Math.abs(value) >= 1e3) return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return value.toFixed(decimals);
}

export default function AnimatedNumber({
    value,
    prefix = '',
    suffix = '',
    decimals = 2,
    duration = 600,
    className = '',
    compact = false,
}: AnimatedNumberProps) {
    const [displayValue, setDisplayValue] = useState(value);
    const [flash, setFlash] = useState<'up' | 'down' | null>(null);
    const prevValue = useRef(value);
    const animFrame = useRef<number>(0);

    useEffect(() => {
        const from = prevValue.current;
        const to = value;

        // Determine direction for flash
        if (to !== from) {
            setFlash(to > from ? 'up' : 'down');
            const flashTimer = setTimeout(() => setFlash(null), 900);

            // Animate the number counting
            const startTime = performance.now();

            const animate = (now: number) => {
                const elapsed = now - startTime;
                const progress = Math.min(elapsed / duration, 1);

                // Ease-out cubic for smooth deceleration
                const eased = 1 - Math.pow(1 - progress, 3);
                const current = from + (to - from) * eased;

                setDisplayValue(current);

                if (progress < 1) {
                    animFrame.current = requestAnimationFrame(animate);
                } else {
                    setDisplayValue(to);
                }
            };

            animFrame.current = requestAnimationFrame(animate);
            prevValue.current = to;

            return () => {
                cancelAnimationFrame(animFrame.current);
                clearTimeout(flashTimer);
            };
        }
    }, [value, duration]);

    const formatted = compact
        ? formatCompact(displayValue, decimals)
        : displayValue.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        });

    return (
        <span
            className={`inline-block transition-colors duration-500 ${flash === 'up'
                    ? 'text-green-400'
                    : flash === 'down'
                        ? 'text-red-400'
                        : ''
                } ${className}`}
        >
            {prefix}{formatted}{suffix}
        </span>
    );
}
