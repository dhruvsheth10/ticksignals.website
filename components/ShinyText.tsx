import React from 'react';

interface ShinyTextProps {
    text: string;
    disabled?: boolean;
    speed?: number;
    className?: string;
}

const ShinyText: React.FC<ShinyTextProps> = ({ text, disabled = false, speed = 3, className = '' }) => {
    const animationDuration = `${speed}s`;

    return (
        <span
            className={`relative inline-block ${disabled ? '' : 'animate-shine max-w-fit bg-clip-text text-transparent'} ${className}`}
            style={
                !disabled
                    ? {
                        backgroundImage: 'linear-gradient(120deg, rgba(255, 255, 255, 0) 40%, rgba(255, 255, 255, 0.8) 50%, rgba(255, 255, 255, 0) 60%)',
                        backgroundSize: '200% 100%',
                        WebkitBackgroundClip: 'text',
                        animationDuration: animationDuration,
                    }
                    : {}
            }
        >
            <span className={disabled ? '' : 'text-gray-400'}>{text}</span>
        </span>
    );
};

export default ShinyText;
