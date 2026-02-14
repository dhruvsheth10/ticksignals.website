import { ReactNode } from 'react';
import { TrendingUp, Github, Twitter } from 'lucide-react';

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-900">
      {/* Background Effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 right-0 w-96 h-96 bg-aquamarine-500/10 rounded-full filter blur-3xl animate-pulse-slow"></div>
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-cyan-500/10 rounded-full filter blur-3xl animate-pulse-slow" style={{ animationDelay: '1s' }}></div>
      </div>

      {/* Header */}
      <header className="relative border-b border-gray-800/50 backdrop-blur-sm bg-gray-900/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-aquamarine-500/10 rounded-lg">
                <TrendingUp className="text-aquamarine-400" size={24} />
              </div>
              <span className="text-xl font-bold bg-gradient-to-r from-aquamarine-400 to-cyan-400 bg-clip-text text-transparent">
                TickSignals
              </span>
            </div>

          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative">
        {children}
      </main>

      {/* Footer */}
      <footer className="relative border-t border-gray-800/50 mt-32">
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