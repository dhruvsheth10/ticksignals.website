import React from 'react';
import { motion } from 'framer-motion';

interface InfiniteScrollProps {
    items: React.ReactNode[];
    speed?: number;
    direction?: 'left' | 'right';
    className?: string;
}

const InfiniteScroll: React.FC<InfiniteScrollProps> = ({
    items,
    speed = 20,
    direction = 'left',
    className = ''
}) => {
    return (
        <div className={`overflow-hidden flex relative w-full ${className}`}>
            <motion.div
                className="flex whitespace-nowrap min-w-full"
                animate={{
                    x: direction === 'left' ? ['0%', '-50%'] : ['-50%', '0%'],
                }}
                transition={{
                    repeat: Infinity,
                    ease: 'linear',
                    duration: speed,
                }}
            >
                <div className="flex gap-8 px-4">
                    {items.map((item, i) => (
                        <div key={`item1-${i}`}>{item}</div>
                    ))}
                </div>
                <div className="flex gap-8 px-4">
                    {items.map((item, i) => (
                        <div key={`item2-${i}`}>{item}</div>
                    ))}
                </div>
            </motion.div>
        </div>
    );
};

export default InfiniteScroll;
