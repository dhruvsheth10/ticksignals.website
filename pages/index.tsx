import { useState, useEffect } from 'react';
import Head from 'next/head';
import { Search, BarChart3, Activity } from 'lucide-react';
import Layout from '../components/Layout';
import TickerAnalyzer from '../components/TickerAnalyzer';
import StockScreener from '../components/StockScreener';
import LivePortfolio from '../components/LivePortfolio';

export default function Home() {
  const [activeTab, setActiveTab] = useState('screener');

  const [selectedTicker, setSelectedTicker] = useState<string>('');
  const handleTickerClick = (ticker: string) => {
    setSelectedTicker(ticker);
    setActiveTab('analyzer');
  };

  const tabs = [
    { id: 'screener', label: 'Stock Screener', icon: BarChart3 },
    { id: 'analyzer', label: 'Ticker Analyzer', icon: Search },
    { id: 'portfolio', label: 'Live Portfolio', icon: Activity },
  ];

  return (
    <>
      <Head>
        <title>TickSignals :&#41;</title>
        <meta name="description" content="Professional stock screener with real-time fundamental data and configurable filters" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
      </Head>

      <Layout>
        {/* Hero Section */}
        <div className="relative overflow-hidden">
          <div className="absolute inset-0 bg-aqua-gradient opacity-10"></div>
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
            <div className="text-center animate-fade-in">
              <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold bg-gradient-to-r from-aquamarine-400 via-cyan-400 to-teal-400 bg-clip-text text-transparent mb-4 pb-2">
                TickSignals
              </h1>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mb-6">
          <div className="bg-gray-800/30 backdrop-blur-sm rounded-xl p-1.5 inline-flex gap-1.5 border border-gray-700/50">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-all text-sm ${activeTab === tab.id
                    ? 'bg-aquamarine-600 text-white shadow-lg shadow-aquamarine-500/50'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                    }`}
                >
                  <Icon size={16} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
          <div className="animate-slide-up">
            {activeTab === 'screener' && <StockScreener onTickerClick={handleTickerClick} />}
            {activeTab === 'analyzer' && <TickerAnalyzer initialTicker={selectedTicker} />}
            {activeTab === 'portfolio' && <LivePortfolio />}
          </div>
        </div>
      </Layout>
    </>
  );
}