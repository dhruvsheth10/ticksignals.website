import { ReactNode } from 'react';
import { TrendingUp, Github, Twitter } from 'lucide-react';
import InfiniteScroll from './InfiniteScroll';

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <header className="relative border-b border-gray-800 bg-gray-900 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-aquamarine-500/10 rounded-lg">
                <TrendingUp className="text-aquamarine-400" size={24} />
              </div>
              <span className="text-xl font-bold text-white tracking-tight">
                TickSignals
              </span>
            </div>

          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative">
        {/* Ticker Tape */}
        <div className="bg-gray-900 border-b border-gray-800 py-2">
          <InfiniteScroll
            speed={40}
            items={[
              <div key="1" className="flex items-center gap-2"><span className="text-gray-300 font-bold text-sm">AAPL</span><span className="text-green-400 text-sm font-medium">+1.2%</span></div>,
              <div key="2" className="flex items-center gap-2"><span className="text-gray-300 font-bold text-sm">TSLA</span><span className="text-red-400 text-sm font-medium">-0.8%</span></div>,
              <div key="3" className="flex items-center gap-2"><span className="text-gray-300 font-bold text-sm">NVDA</span><span className="text-green-400 text-sm font-medium">+3.4%</span></div>,
              <div key="4" className="flex items-center gap-2"><span className="text-gray-300 font-bold text-sm">MSFT</span><span className="text-green-400 text-sm font-medium">+0.5%</span></div>,
              <div key="5" className="flex items-center gap-2"><span className="text-gray-300 font-bold text-sm">AMZN</span><span className="text-green-400 text-sm font-medium">+1.1%</span></div>,
              <div key="6" className="flex items-center gap-2"><span className="text-gray-300 font-bold text-sm">META</span><span className="text-red-400 text-sm font-medium">-1.2%</span></div>,
              <div key="7" className="flex items-center gap-2"><span className="text-gray-300 font-bold text-sm">GOOGL</span><span className="text-green-400 text-sm font-medium">+0.9%</span></div>,
              <div key="8" className="flex items-center gap-2"><span className="text-gray-300 font-bold text-sm">AMD</span><span className="text-green-400 text-sm font-medium">+2.1%</span></div>,
            ]}
          />
        </div>

        {children}
      </main>

      {/* Footer */}
      <footer className="relative border-t border-gray-800 bg-gray-900 mt-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="text-center text-gray-400 text-sm">
            <p>© 2026 TickSignals. Made by Dhruv and papa</p>
            <p className="mt-2">Not financial advice. Trade at your own risk.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}