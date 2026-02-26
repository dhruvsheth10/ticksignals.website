import Link from 'next/link';
import { useRouter } from 'next/router';
import { Search, BarChart3, Activity } from 'lucide-react';

export default function Navigation() {
    const router = useRouter();

    const tabs = [
        { id: '/', label: 'Stock Screener', icon: BarChart3 },
        { id: '/analyze', label: 'Ticker Analyzer', icon: Search },
        { id: '/live', label: 'Live Portfolio', icon: Activity },
    ];

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mb-6 mt-6">
            <div className="bg-gray-800 rounded-xl p-1 inline-flex gap-1 border border-gray-700 overflow-x-auto max-w-full hide-scrollbar">
                {tabs.map((tab) => {
                    const Icon = tab.icon;
                    const isActive = router.pathname === tab.id;
                    return (
                        <Link
                            key={tab.id}
                            href={tab.id}
                            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-colors text-sm whitespace-nowrap ${isActive
                                ? 'bg-aquamarine-600 text-white'
                                : 'text-gray-400 hover:text-white hover:bg-gray-700'
                                }`}
                        >
                            <Icon size={16} />
                            {tab.label}
                        </Link>
                    );
                })}
            </div>
        </div>
    );
}
