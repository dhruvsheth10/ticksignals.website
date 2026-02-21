import { useRef, useEffect, useState } from 'react';
import { motion } from 'framer-motion';

interface BlurTextProps {
    text: string;
    delay?: number;
    className?: string;
    animateBy?: 'words' | 'letters';
    direction?: 'top' | 'bottom';
}

const BlurText: React.FC<BlurTextProps> = ({
    text,
    delay = 50,
    className = '',
    animateBy = 'words',
    direction = 'top',
}) => {
    const elements = animateBy === 'words' ? text.split(' ') : text.split('');
    const [inView, setInView] = useState(false);
    const ref = useRef<HTMLParagraphElement>(null);

    useEffect(() => {
        setInView(true);
    }, []);

    const defaultTransitions = {
        hidden: { filter: 'blur(10px)', opacity: 0, transform: `translateY(${direction === 'top' ? '-10px' : '10px'})` },
        visible: { filter: 'blur(0px)', opacity: 1, transform: 'translateY(0px)' },
    };

    return (
        <p ref={ref} className={`m-0 flex flex-wrap ${className}`}>
            {elements.map((element, index) => (
                <motion.span
                    key={index}
                    initial="hidden"
                    animate={inView ? 'visible' : 'hidden'}
                    variants={defaultTransitions}
                    transition={{
                        duration: 0.3,
                        delay: index * (delay / 1000),
                        ease: 'easeOut',
                    }}
                    className={animateBy === 'words' ? 'mr-1' : ''}
                >
                    {element === ' ' ? '\u00A0' : element}
                </motion.span>
            ))}
        </p>
    );
};

export default BlurText;
